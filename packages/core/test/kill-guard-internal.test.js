import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyKillTarget } from "../dist/response.js";

/**
 * RED — falso positivo `internal` na regra de ancestralidade.
 *
 * CASO PROVADO com um processo VIVO (dados do utilizador, nao hipotese):
 *
 *   PID  = 35744          NAME = Notepad.exe
 *   PPID = 1628           PAI  = explorer.exe (PID 1628)
 *   PATH = C:\Program Files\WindowsApps\Microsoft.WindowsNotepad_...\Notepad.exe
 *   CMD  = "C:\...\Notepad.exe"      (sem a palavra "cybersafe" em lado nenhum)
 *
 * Foi recusado 4x com protectedReason = "internal".
 *
 * Duas hipoteses alternativas ficam mortas por estes dados:
 *   - NAO e o launcher MSIX: o caminho e o do executavel real e o processo
 *     continuava vivo. A proteccao de App Execution Alias esta correcta.
 *   - NAO e a regra de path nem a de command line: o caminho nao comeca por
 *     packages/service/dist/src e a command line nao contem "cybersafe".
 *
 * Sobra uma: a regra do ppid. `engine.ts` sobe a cadeia de ancestrais ate 16
 * niveis a partir de `process.ppid`, e num ambiente de desenvolvimento essa
 * cadeia inclui o explorer.exe. O Notepad e IRMAO de outra ramificacao do
 * explorer, nao um componente do CyberSafe.
 */

const NOTEPAD = {
  pid: 35744,
  ppid: 1628,
  name: "Notepad.exe",
  path: "C:\\Program Files\\WindowsApps\\Microsoft.WindowsNotepad_11.2607.14.0_x64__8wekyb3d8bbwe\\Notepad\\Notepad.exe",
  commandLine: "\"C:\\Program Files\\WindowsApps\\Microsoft.WindowsNotepad_11.2607.14.0_x64__8wekyb3d8bbwe\\Notepad\\Notepad.exe\"",
};

/**
 * Contexto identico ao que o servico montava quando o caso foi observado:
 * selfPid e um node de servico, e a cadeia de ancestrais sobe ate ao explorer.
 */
function contextoDev({ explorerPid = 1628, terminalPid = 2000, pwshPid = 2100, agentPid = 2200, selfPid = 2300 } = {}) {
  return {
    selfPid,
    ancestorPids: [explorerPid, terminalPid, pwshPid, agentPid],
    parentOf: {
      // explorer -> terminal -> pwsh -> agente -> serviço
      [terminalPid]: explorerPid,
      [pwshPid]: terminalPid,
      [agentPid]: pwshPid,
      [selfPid]: agentPid,
      // Notepad é IRMÃO da ramificação do CyberSafe: mesmo pai, outra ramo.
      35744: explorerPid,
    },
    internalPaths: [],
    internalPathPrefixes: ["c:\\projeto\\packages\\service\\dist\\src"],
    commandLineMarkers: ["c:\\projeto\\packages\\service\\dist\\src", "get-ciminstance win32_process"],
    fallbackNames: ["explorer.exe", "taskmgr.exe"],
    systemPidThreshold: 100,
  };
}

describe("A1 — o falso positivo: irmao de ramificacao nao e internal", () => {
  test("Notepad com ppid = explorer.exe (ancestral do servico) NAO e protegido", () => {
    const razao = classifyKillTarget(NOTEPAD, contextoDev());
    // ANTES DO PATCH: "internal". O que faz este teste falhar e o bug.
    assert.equal(razao, null, `falso positivo: Notepad foi classificado como "${razao}"`);
  });

  test("o mesmo Notepad continua nao protegido mesmo com o path real do Windows", () => {
    // O path do WindowsApps NAO esta em internalPaths nem em prefixes: e um
    // caminho legitimo de uma app instalada. Nao pode virar "interno" so por
    // isso.
    const razao = classifyKillTarget(NOTEPAD, {
      ...contextoDev(),
      internalPathPrefixes: ["c:\\projeto\\packages\\service\\dist\\src"],
    });
    assert.equal(razao, null, `falso positivo: "${razao}"`);
  });

  test("uma app normal aberta na mesma sessao tambem nao e internal", () => {
    const paint = { pid: 9999, ppid: 1628, name: "mspaint.exe", path: "C:\\Windows\\System32\\mspaint.exe", commandLine: "mspaint.exe" };
    assert.equal(classifyKillTarget(paint, contextoDev()), null);
  });
});

describe("A2 — descendentes do servico a QUALQUER profundidade", () => {
  test("filho directo (profundidade 1) -> internal", () => {
    const filho = { pid: 2400, ppid: 2300, name: "node.exe", path: "C:\\Program Files\\nodejs\\node.exe", commandLine: "node.exe child.js" };
    assert.equal(classifyKillTarget(filho, contextoDev()), "internal");
  });

  test("T2 — NASCUNHO a PROFUNDIDADE 2 (servico -> helper -> worker) continua internal", () => {
    // Este e o teste que impede a regra de ser estreitada a
    // `parentPid === selfPid`. A proposta anterior do packet ERA essa, e
    // deixaria o worker DESPROTEGIDO: helper e worker sao o mesmo produto.
    const ctx = contextoDev();
    const comArvore = { ...ctx, parentOf: { ...ctx.parentOf, 2500: 2300, 2600: 2500 } };
    assert.equal(classifyKillTarget({ pid: 2500, ppid: 2300, name: "helper.exe" }, comArvore), "internal", "helper");
    assert.equal(
      classifyKillTarget({ pid: 2600, ppid: 2500, name: "worker.exe" }, comArvore),
      "internal",
      "worker a dois niveis: estreitar a ppid === selfPid deixaria este DESPROTEGIDO",
    );
  });

  test("T2b — profundidade 3 tambem (servico -> a -> b -> c)", () => {
    const ctx = contextoDev();
    const comArvore = { ...ctx, parentOf: { ...ctx.parentOf, 2500: 2300, 2600: 2500, 2700: 2600 } };
    assert.equal(classifyKillTarget({ pid: 2700, ppid: 2600, name: "c.exe" }, comArvore), "internal");
  });

  test("a caminhada tem guarda de ciclo (um pai malformado nao da RangeError)", () => {
    const ctx = contextoDev();
    const ciclo = { ...ctx, parentOf: { ...ctx.parentOf, 9000: 9001, 9001: 9000 } };
    const r = classifyKillTarget({ pid: 8000, ppid: 9000, name: "x.exe" }, ciclo);
    assert.equal(r, null, "ciclo nao pode ser protecao nem crash");
  });

  test("sem parentOf, so a profundidade 1 e provavel; a >1 nao e inventada", () => {
    // Sem `parentOf` nao ha como saber de quem e o pai do pai, e a protecao de
    // profundidade > 1 nao se inventa. A profundidade 1 E provavel so com o
    // alvo, e por isso continua protegida: o caso seguro e proteger o que se
    // pode provar.
    const ctx = { ...contextoDev(), parentOf: undefined };
    assert.equal(classifyKillTarget({ pid: 2400, ppid: 2300, name: "helper.exe" }, ctx), "internal", "profundidade 1 prova-se sem mapa");
    assert.equal(
      classifyKillTarget({ pid: 2600, ppid: 2500, name: "worker.exe" }, ctx),
      null,
      "profundidade 2 sem mapa: nao se inventa protecao, nem se bloqueia um processo legitimo",
    );
  });

  test("filho directo por ppid continua protegido mesmo sem nome conhecido", () => {
    const filho = { pid: 2401, ppid: 2300, name: "desconhecido.exe", path: "C:\\Temp\\desconhecido.exe", commandLine: "" };
    assert.equal(classifyKillTarget(filho, contextoDev()), "internal");
  });
});

describe("A3/A4 — as proteccoes genuinas nao regridem", () => {
  test("o proprio servico -> self", () => {
    assert.equal(classifyKillTarget({ pid: 2300, ppid: 2200, name: "node.exe", path: "C:\\node.exe" }, contextoDev()), "self");
  });

  test("um ancestral (o terminal que o lancou) -> ancestor, e continua recusado", () => {
    assert.equal(classifyKillTarget({ pid: 2000, ppid: 1628, name: "WindowsTerminal.exe", path: "C:\\wt.exe" }, contextoDev()), "ancestor");
  });

  test("PID de sistema -> system-pid", () => {
    assert.equal(classifyKillTarget({ pid: 4, ppid: 0, name: "System", path: "" }, contextoDev()), "system-pid");
  });

  test("path interno -> internal (regra de path intacta)", () => {
    const alvo = { pid: 3000, ppid: 3001, name: "node.exe", path: "c:\\projeto\\packages\\service\\dist\\src\\engine.js", commandLine: "" };
    assert.equal(classifyKillTarget(alvo, contextoDev()), "internal");
  });

  test("marker na command line -> internal (regra de command line intacta)", () => {
    const alvo = {
      pid: 3100, ppid: 3101, name: "node.exe", path: "C:\\node.exe",
      commandLine: "node.exe c:\\projeto\\packages\\service\\dist\\src\\index.js",
    };
    assert.equal(classifyKillTarget(alvo, contextoDev()), "internal");
  });

  test("nome protegido SEM caminho -> fallback-name (so quando nao ha caminho)", () => {
    const alvo = { pid: 3200, ppid: 3201, name: "explorer.exe", path: "", commandLine: "" };
    assert.equal(classifyKillTarget(alvo, contextoDev()), "fallback-name");
  });

  test("as cinco razoes continuam todas alcancaveis", () => {
    const razoes = new Set([
      classifyKillTarget({ pid: 2300, ppid: 2200, name: "n", path: "C:\\a" }, contextoDev()),
      classifyKillTarget({ pid: 2000, ppid: 1628, name: "n", path: "C:\\a" }, contextoDev()),
      classifyKillTarget({ pid: 2400, ppid: 2300, name: "n", path: "C:\\a" }, contextoDev()),
      classifyKillTarget({ pid: 4, ppid: 0, name: "n", path: "" }, contextoDev()),
      classifyKillTarget({ pid: 3200, ppid: 3201, name: "explorer.exe", path: "", commandLine: "" }, contextoDev()),
    ]);
    assert.equal(razoes.size, 5, `esperava 5 razoes alcancaveis, obtive ${[...razoes].join(",")}`);
    assert.ok(!razoes.has(null), "todas as razoes tem de ser reais");
  });
});
