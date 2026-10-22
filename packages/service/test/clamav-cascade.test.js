import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProtectionEngineService } from "../dist/engine.js";

/**
 * P0 — CLAMAV_RESOURCE_EXHAUSTION: a anti-cascata.
 *
 * O ciclo que congelava o PC era: o motor lançava um `clamscan.exe`, o
 * `ProcessMonitor` via-o como processo novo, o motor voltava a analisá-lo, e
 * lançava outro. Cada volta custava ~6,2 s e ~981 MB.
 *
 * REVISÃO DE 2026-10-02. A defesa anterior era uma lista de NOMES em
 * `SAFE_PROCESSES`, o que dava a qualquer `clamscan.exe` imunidade de análise
 * e de auto-kill — evasão trivial, e o nome de uma ferramenta de segurança é
 * exactamente o que um atacante escolhe. A defesa passou a ser IDENTIDADE:
 *
 *   1. o PID é um que nós lançámos;
 *   2. OU o pai é um que nós lançámos (descendência — o shim do Chocolatey
 *      arranca o clamscan verdadeiro, e o PID que carrega os 981 MB não é o
 *      PID que nós spawnámos);
 *   3. OU nome de motor E caminho de motor, em conjunto.
 *
 * A propriedade que fecha o problema: um processo EXTERNO nunca tem o nosso
 * PID como pai. A identidade não se falsifica; um nome, sim.
 */

const ENGINE_DIR = "C:\\ProgramData\\chocolatey\\lib\\clamav\\tools\\clamav-1.5.2.win.x64\\clamscan.exe";

/**
 * Identidades de criação, como o Windows as reportaria.
 *
 * CORRECÇÃO DE 2026-10-03 (Codex achado 4, "consulta-por-presença concedem
 * imunidade"). Este ficheiro registava `registerOwnChild(4242)` **sem
 * identidade** e depois afirmava que o processo era nosso. Passava porque
 * `isOwnChildPid` respondia `true` a uma consulta por presença — exactamente o
 * defeito. Agora o registo traz a identidade capturada, e o processo observado
 * traz a identidade observada: são coisas diferentes, e é a igualdade entre elas
 * que prova ownership.
 *
 * Estes testes não foram apagados nem afrouxados: passaram a ter de responder
 * pela razão certa.
 */
const CRIACAO_SHIM = "2026-10-03T10:00:00.0000000Z";
const CRIACAO_REAL = "2026-10-03T10:00:02.0000000Z";

/**
 * Raiz de dados INJETADA num tmpdir deste ficheiro.
 *
 * `new ProtectionEngineService()` sem argumentos significa "home real do
 * utilizador" — é o default de PRODUÇÃO. Um teste que o use deixa logs e
 * definições em `%USERPROFILE%\.cybersafe-service`, e Worse, pode cruzar o
 * estado de uma execução com a seguinte. Ver test/p0-runtime-isolation.test.js.
 */
const TEST_BASE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-cascade-"));
after(async () => {
  await fs.rm(TEST_BASE_DIR, { recursive: true, force: true }).catch(() => {});
});

let engine;
beforeEach(() => {
  engine = new ProtectionEngineService(TEST_BASE_DIR);
});

/**
 * Publica um snapshot pelo HANDLER REAL (`process.started`).
 *
 * É o que põe o processo no cache do serviço, e é de onde sai a identidade
 * observada do PAI que `classifyOwnChild` exige para um descendente. Emitir o
 * evento é a via honesta de a obter — sem isto, um descendente nunca teria
 * como ser confirmado e o teste passaria pelo motivo errado outra vez.
 *
 * `handleProcessStart` é neutralizado porque o que está em teste é a decisão de
 * ownership, não a análise do ficheiro (mesmo padrão já usado em
 * process-kill.test.js para o `processMonitor`).
 */
function observe(snapshot) {
  engine.handleProcessStart = () => {};
  engine.bindWatchers();
  engine.processMonitor.emit("process.started", {
    memoryMb: 0,
    trusted: "unknown",
    commandLine: "",
    path: "",
    ppid: 0,
    ...snapshot,
  });
}

describe("anti-cascata — identidade (a defesa principal)", () => {
  it("o PID que o serviço lançou não é analisado", () => {
    engine.registerOwnChild(4242, CRIACAO_SHIM);
    assert.equal(
      engine.shouldScanStartedProcess({
        pid: 4242,
        name: "clamscan.exe",
        path: ENGINE_DIR,
        startedAt: CRIACAO_SHIM,
      }),
      false,
      "o nosso próprio motor não se auto-analisa",
    );
  });

  it("o FILHO do nosso motor também não é analisado (descendência)", () => {
    // O caso do Chocolatey: nós lançamos o shim (PID 4242) e o shim arranca o
    // clamscan verdadeiro (PID 5150), que é quem carrega a base. Sem descendência
    // o P0 volta — foi medido.
    engine.registerOwnChild(4242, CRIACAO_SHIM);
    observe({ pid: 4242, name: "clamscan.exe", path: ENGINE_DIR, startedAt: CRIACAO_SHIM });
    assert.equal(
      engine.shouldScanStartedProcess({
        pid: 5150,
        name: "clamscan.exe",
        path: ENGINE_DIR,
        ppid: 4242,
        startedAt: CRIACAO_REAL,
      }),
      false,
      "descendência do nosso motor também é nosso",
    );
  });

  it("um PID que o serviço NÃO lançou é analisado normalmente", () => {
    assert.equal(
      engine.shouldScanStartedProcess({ pid: 9999, name: "notepad.exe", path: "C:\\Windows\\notepad.exe", ppid: 1000 }),
      true,
    );
  });

  it("a descendência só protege o que é mesmo nosso", () => {
    engine.registerOwnChild(4242, CRIACAO_SHIM);
    observe({ pid: 4242, name: "clamscan.exe", path: ENGINE_DIR, startedAt: CRIACAO_SHIM });
    assert.equal(
      engine.shouldScanStartedProcess({
        pid: 5151,
        name: "notepad.exe",
        path: "C:\\Windows\\notepad.exe",
        ppid: 4242,
        startedAt: CRIACAO_REAL,
      }),
      false,
      "um filho do nosso motor é nosso — o clamscan também pode abrir editors",
    );
    assert.equal(
      engine.shouldScanStartedProcess({
        pid: 5152,
        name: "notepad.exe",
        path: "C:\\Windows\\notepad.exe",
        ppid: 7777,
        startedAt: CRIACAO_REAL,
      }),
      true,
      "mas um filho de um PID que não é nosso, não",
    );
  });

  it("um clamscan.exe EXTERNO, com nome de motor, é analisado", () => {
    // Malware que se dá a si próprio o nome de uma ferramenta de segurança.
    // A lista de nomes deixou de ser autoridade: sem identidade e sem caminho
    // de motor, este processo é exactamente o que parece ser.
    assert.equal(
      engine.shouldScanStartedProcess({
        pid: 31337,
        name: "clamscan.exe",
        path: "C:\\Users\\victim\\Downloads\\clamscan.exe",
        ppid: 2000,
      }),
      true,
      "o nome, sozinho, não compra imunidade",
    );
  });

  it("nome E caminho de motor, juntos, dão a mesma protecção", () => {
    // A segunda defesa. Vale quando o PID não é nosso (ex.: o serviço
    // reiniciou e perdeu o registo) mas o binário está onde só vive um motor.
    assert.equal(
      engine.shouldScanStartedProcess({ pid: 31338, name: "clamscan.exe", path: ENGINE_DIR, ppid: 2000 }),
      false,
    );
  });

  it("as três defesas juntas não deixam passar um motor de scan de nenhuma maneira", () => {
    // Um clamscan nosso, directo.
    engine.registerOwnChild(8001, CRIACAO_SHIM);
    observe({ pid: 8001, name: "clamscan.exe", path: ENGINE_DIR, startedAt: CRIACAO_SHIM });
    assert.equal(
      engine.shouldScanStartedProcess({
        pid: 8001,
        name: "clamscan.exe",
        path: ENGINE_DIR,
        startedAt: CRIACAO_SHIM,
      }),
      false,
    );
    // Um clamscan nosso, por descendencia.
    assert.equal(
      engine.shouldScanStartedProcess({
        pid: 8002,
        name: "clamscan.exe",
        path: ENGINE_DIR,
        ppid: 8001,
        startedAt: CRIACAO_REAL,
      }),
      false,
    );
    // Um clamscan de motor, por caminho, sem PID nosso (servico reiniciado).
    assert.equal(
      engine.shouldScanStartedProcess({ pid: 8003, name: "clamd.exe", path: ENGINE_DIR, ppid: 4 }),
      false,
    );
    // E o que nao e nosso, nao passa.
    assert.equal(
      engine.shouldScanStartedProcess({
        pid: 8004,
        name: "clamscan.exe",
        path: "C:\\Users\\victim\\Downloads\\clamscan.exe",
        ppid: 4,
      }),
      true,
    );
  });
});

describe("anti-cascata — a lista de nomes deixou de ser autoridade", () => {
  it("um nome de motor, sozinho, NAO chega para escaping a analise", () => {
    // A regressão que a revisão corrigiu. Com a lista em SAFE_PROCESSES, este
    // processo era ignorado em silêncio — e nem_auto-killado. Malware que se
    // dá a si próprio o nome de uma ferramenta de segurança é trivial.
    for (const name of ["clamscan.exe", "clamscan", "clamd.exe", "freshclam.exe", "clambc.exe", "sigtool.exe"]) {
      assert.equal(
        engine.shouldScanStartedProcess({ pid: 9001, name, path: `C:\\Users\\victim\\Downloads\\${name}`, ppid: 90 }),
        true,
        `${name} fora de um directório de motor tem de ser analisado`,
      );
    }
  });

  it("a lista continua a existir — é validação, não autoridade", () => {
    // Não desapareceu: passou a ser uma das condições, junto com o caminho.
    // A escolha de um nome genérico aqui (cmd, powershell) desligaria
    // monitorização real sem que ninguém perceba.
    assert.ok(ProtectionEngineService.SCAN_ENGINE_DIRS.size > 0, "os directórios de motor estão carregados");
  });

  it("isto NÃO desliga a monitorização de processos reais", () => {
    // Nomes que NÃO estão em SAFE_PROCESSES. A lista de confiança original
    // (browsers, binários de sistema) não foi tocada por esta alteração — o
    // que saiu da lista foram os nomes do ClamAV, e são estes que estão a
    // ser testados.
    for (const name of ["notepad.exe", "outlook.exe", "onedrive.exe", "teams.exe", "winword.exe"]) {
      assert.equal(
        engine.shouldScanStartedProcess({
          pid: 20000 + name.length,
          name,
          path: `C:\\Program Files\\${name}`,
          ppid: 1,
        }),
        true,
        `${name} tem de continuar a ser analisado`,
      );
    }
  });
});

describe("anti-cascata — os filhos próprios não são um leak", () => {
  it("o tracker liberta o PID quando o processo morre", () => {
    engine.registerOwnChild(7001, CRIACAO_SHIM);
    assert.equal(engine.ownChildCount(), 1);
    assert.equal(engine.isOwnChildPid(7001, CRIACAO_SHIM), true);
    engine.releaseOwnChild(7001);
    assert.equal(engine.ownChildCount(), 0);
    assert.equal(engine.isOwnChildPid(7001), false, "o PID já não é nosso");
    // E um PID que já não é nosso é analisado, quando não há nome/caminho de
    // motor a falar mais alto. Sem esta parte, o tracker só crescia e nunca
    // voltava a proteger ninguém.
    assert.equal(
      engine.shouldScanStartedProcess({ pid: 7001, name: "notepad.exe", path: "C:\\Windows\\notepad.exe", ppid: 5 }),
      true,
    );
  });

  it("a lista não cresce sem limite (um poll de 300 processos não pode ser um leak)", () => {
    for (let i = 0; i < 5000; i++) engine.registerOwnChild(100000 + i);
    assert.ok(engine.ownChildCount() <= 1024, `a janela tem de ser limitada, ficou com ${engine.ownChildCount()}`);
  });
});

describe("anti-cascata — exclusão por caminho", () => {
  it("o binário do ClamAV é ignorado por caminho, mesmo com um nome que não está em lista nenhuma", () => {
    assert.equal(engine.shouldScanProcessPath(ENGINE_DIR), false);
  });

  it("o caminho REAL do binário é aprendido, não só o layout conhecido", () => {
    engine.noteClamavBinary("D:\\Ferramentas\\ClamAV-custom\\bin\\clamd.exe");
    assert.equal(engine.shouldScanProcessPath("D:\\Ferramentas\\ClamAV-custom\\bin\\clamd.exe"), false);
  });

  it("um path typo não broad-brusha a exclusão", () => {
    engine.noteClamavBinary("C:\\Users\\caioc\\Downloads\\clamd.exe");
    assert.equal(
      engine.shouldScanProcessPath("C:\\Users\\caioc\\Documents\\programa.exe"),
      true,
      "só se exclui o que foi realmente visto",
    );
  });

  it("a comparação de caminho é case-insensitive (Windows não distingue)", () => {
    assert.equal(engine.shouldScanProcessPath(ENGINE_DIR.toUpperCase()), false);
  });

  it("um programa normal numa pasta normal continua a ser analisado", () => {
    assert.equal(engine.shouldScanProcessPath("C:\\Program Files\\Notepad++\\notepad++.exe"), true);
  });
});
