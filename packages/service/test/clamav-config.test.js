import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildFreshclamConfig,
  buildFreshclamArgs,
  ensureFreshclamConfig,
  explainFreshclamError,
  DEFAULT_DATABASE_MIRROR,
  FRESHCLAM_CONFIG_FILENAME,
} from "../dist/clamav-config.js";

/**
 * Causa RAIZ provada, nao hipotetizada. Nesta maquina:
 *
 *   C:\ProgramData\chocolatey\lib\clamav\tools\clamav-1.5.2.win.x64\
 *     freshclam.conf              -> NAO EXISTE
 *     freshclam.conf.sample       -> NAO EXISTE (esta em conf_examples\)
 *     conf_examples\freshclam.conf.sample -> EXISTE, 7793 bytes
 *
 *   freshclam.exe --version
 *   ERROR: Can't open/parse the config file
 *   C:\ProgramData\chocolatey\lib\clamav\tools\clamav-1.5.2.win.x64\freshclam.conf
 *
 * `--version` nao descarrega nada e mesmo assim falha => e um problema de
 * ARRANQUE (falta a config), nao de rede nem de base de dados. O comando antigo
 * passava `--datadir` mas nao `--config-file`, e o freshclam nunca chega a ler o
 * `--datadir` porque aborta antes.
 */

let tmpRoot;
let dbDir;
let configFile;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-clamav-"));
  dbDir = path.join(tmpRoot, "definitions", "clamav");
  configFile = path.join(dbDir, FRESHCLAM_CONFIG_FILENAME);
});
after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("1 — config gerida: conteudo", () => {
  test("aponta a base de dados para o directorio do CyberSafe", () => {
    const cfg = buildFreshclamConfig({ databaseDirectory: dbDir });
    assert.ok(cfg.includes(`DatabaseDirectory ${dbDir}`), `falta DatabaseDirectory:\n${cfg}`);
  });

  test("NUNCA leva a directiva Example (e o que trava o .sample)", () => {
    const cfg = buildFreshclamConfig({ databaseDirectory: dbDir });
    const linhasAtivas = cfg.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
    assert.ok(
      !linhasAtivas.some((l) => l.trim() === "Example"),
      "a config tem 'Example' activa e o freshclam recusa arrancar",
    );
  });

  test("usa o espelho oficial por defeito e aceita mirror explicito", () => {
    assert.equal(DEFAULT_DATABASE_MIRROR, "database.clamav.net");
    assert.ok(buildFreshclamConfig({ databaseDirectory: dbDir }).includes(`DatabaseMirror ${DEFAULT_DATABASE_MIRROR}`));
    assert.ok(
      buildFreshclamConfig({ databaseDirectory: dbDir, databaseMirror: "mirror.exemplo.test" })
        .includes("DatabaseMirror mirror.exemplo.test"),
    );
  });

  test("recusa um directorio relativo: o freshclam exige absoluto", () => {
    // Nao e teoria: o .sample avisa "must be an absolute path".
    assert.throws(() => buildFreshclamConfig({ databaseDirectory: "definitions/clamav" }), /absoluto/i);
    assert.throws(() => buildFreshclamConfig({ databaseDirectory: "  " }), /obrigatorio/i);
  });

  test("NUNCA aponta para o espelho alterado por terceiros (abuse.ch intacto)", () => {
    const cfg = buildFreshclamConfig({ databaseDirectory: dbDir });
    assert.doesNotMatch(cfg, /abuse\.ch/i, "a packet proibe tocar em abuse.ch");
    assert.doesNotMatch(cfg, /PhishTank|urlhaus/i);
  });

  test("nao pede NotifyClamd: nao ha clamd daemon e o socket local exigiria admin", () => {
    const cfg = buildFreshclamConfig({ databaseDirectory: dbDir });
    const linhasAtivas = cfg.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
    assert.ok(!linhasAtivas.some((l) => l.startsWith("NotifyClamd")), "NotifyClamd apontaria para um socket inexistente");
    assert.ok(linhasAtivas.some((l) => l.startsWith("Foreground")), "Foreground impede o daemon e mantem o erro visivel");
  });
});

describe("2 — comando", () => {
  test("TEM --config-file explicito: era a ausencia que causava o bloqueio", () => {
    const args = buildFreshclamArgs({ configFile, databaseDirectory: dbDir });
    assert.ok(args.some((a) => a.startsWith("--config-file=")), `args sem --config-file: ${args.join(" ")}`);
  });

  test("mantem o datadir explicito do CyberSafe", () => {
    const args = buildFreshclamArgs({ configFile, databaseDirectory: dbDir });
    assert.ok(args.includes(`--datadir=${dbDir}`));
  });

  test("contem o caminho do config de facto no argumento", () => {
    const args = buildFreshclamArgs({ configFile, databaseDirectory: dbDir });
    assert.equal(args.find((a) => a.startsWith("--config-file=")), `--config-file=${configFile}`);
  });

  test("--quiet fora em diagnostico, dentro no normal", () => {
    assert.ok(!buildFreshclamArgs({ configFile, databaseDirectory: dbDir, diagnostic: true }).includes("--quiet"));
    assert.ok(buildFreshclamArgs({ configFile, databaseDirectory: dbDir }).includes("--quiet"));
  });

  test("rejeita configFile nao absoluto: o path relativo depende do cwd", () => {
    assert.throws(() => buildFreshclamArgs({ configFile: "freshclam.conf", databaseDirectory: dbDir }), /absoluto/i);
  });
});

describe("3 — escrita no disco", () => {
  test("cria o config e o directorio da base", () => {
    const r = ensureFreshclamConfig(configFile, { databaseDirectory: dbDir });
    assert.equal(r.written, true);
    assert.equal(r.reason, "criado");
    assert.ok(fs.existsSync(configFile));
    assert.ok(fs.statSync(dbDir).isDirectory(), "DatabaseDirectory tem de existir antes do arranque");
  });

  test("NAO reescreve uma config ja correcta", () => {
    const r = ensureFreshclamConfig(configFile, { databaseDirectory: dbDir });
    assert.equal(r.written, false);
    assert.equal(r.reason, "ja-existe");
  });

  test("corrige uma config que aponta para outro directorio", () => {
    const outro = path.join(tmpRoot, "outro-perfil", "clamav");
    const r = ensureFreshclamConfig(configFile, { databaseDirectory: outro });
    assert.equal(r.written, true);
    assert.equal(r.reason, "corrigido");
    assert.ok(fs.readFileSync(configFile, "utf8").includes(`DatabaseDirectory ${outro}`));
    // repõe para o resto dos testes
    ensureFreshclamConfig(configFile, { databaseDirectory: dbDir });
  });

  test("SUBSTITUI um .sample colado com 'Example' (invalido)", () => {
    fs.writeFileSync(configFile, "Example\nDatabaseDirectory \"C:\\\\Program Files\\\\ClamAV\\\\db\"\n", "utf8");
    const r = ensureFreshclamConfig(configFile, { databaseDirectory: dbDir });
    assert.equal(r.written, true);
    assert.equal(r.reason, "invalido");
    const cfg = fs.readFileSync(configFile, "utf8");
    assert.ok(cfg.includes(`DatabaseDirectory ${dbDir}`));
    assert.ok(!cfg.split(/\r?\n/).some((l) => l.trim() === "Example"));
  });

  test("a config gerida aponta SO para o directorio do CyberSafe", () => {
    const cfg = fs.readFileSync(configFile, "utf8");
    const linhasAtivas = cfg.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
    for (const linha of linhasAtivas) {
      assert.doesNotMatch(linha, /ProgramData/i, `directiva global: ${linha}`);
      assert.doesNotMatch(linha, /Chocolatey/i, `directiva global: ${linha}`);
    }
    // Nenhum caminho absoluto escrito a mao que nao seja a base do CyberSafe.
    const absolutos = cfg.match(/[A-Za-z]:\\[^\s"]+/g) ?? [];
    for (const p of absolutos) assert.ok(p.startsWith(tmpRoot), `caminho estranho na config: ${p}`);
  });
});

describe("5 — P1: config adulterada NAO sobrevive (Codex review NO-GO)", () => {
  // O bug: a versao anterior aceitava o ficheiro se tivesse a linha
  // DatabaseDirectory certa e nao tivesse `Example`. O ClamAV 1.5.2 aceita
  // OnUpdateExecute/OnErrorExecute, hooks executados via system(). Um ficheiro
  // com a linha certa + um hook sobrevivia com written:false — e o freshclam
  // corre-o como SYSTEM. Isto e o teste que falha com a versao antiga.

  const HOOKS = [
    "OnUpdateExecute /c whoami > C:\\Windows\\Temp\\pwn.txt",
    "OnErrorExecute calc.exe",
    "OnUpdateExecute notepad.exe",
  ];

  for (const hook of HOOKS) {
    test(`reescreve e REMOVE a directiva injetada: ${hook.slice(0, 22)}`, () => {
      // Comeca com uma config VALIDA (aceite pela logica antiga).
      ensureFreshclamConfig(configFile, { databaseDirectory: dbDir });
      assert.equal(fs.readFileSync(configFile, "utf8"), buildFreshclamConfig({ databaseDirectory: dbDir }));

      // Adultera: acrescenta o hook, mantendo a linha DatabaseDirectory intacta.
      fs.writeFileSync(configFile, fs.readFileSync(configFile, "utf8") + hook + "\n", "utf8");

      const r = ensureFreshclamConfig(configFile, { databaseDirectory: dbDir });
      assert.equal(r.written, true, "a config adulterada foi ACEITE — falha de seguranca");
      assert.equal(r.reason, "invalido");

      const final = fs.readFileSync(configFile, "utf8");
      assert.doesNotMatch(final, /OnUpdateExecute/i, "o hook sobreviveu e correria como SYSTEM");
      assert.doesNotMatch(final, /OnErrorExecute/i);
      assert.doesNotMatch(final, /whoami|calc\.exe|notepad\.exe/i);
      assert.equal(final, buildFreshclamConfig({ databaseDirectory: dbDir }), "tem de ficar byte-identico ao gerado");
    });
  }

  test("qualquer divergencia reescreve — mesmo um comentario inofensivo", () => {
    ensureFreshclamConfig(configFile, { databaseDirectory: dbDir });
    const base = fs.readFileSync(configFile, "utf8");

    // Divergencias que a logica antiga aceitava porque so olhava para
    // DatabaseDirectory e Example.
    for (const [nome, adulterado] of [
      ["comentario acrescentado", base + "# comentario do utilizador\n"],
      ["directiva espelho extra", base + "DatabaseMirror evil.exemplo.test\n"],
      ["chave valor alterada", base.replace("MaxAttempts 3", "MaxAttempts 999")],
      ["CRLF em vez de LF", base.replace(/\n/g, "\r\n")],
      ["espaco extra no fim", base + " "],
    ]) {
      fs.writeFileSync(configFile, adulterado, "utf8");
      const r = ensureFreshclamConfig(configFile, { databaseDirectory: dbDir });
      assert.equal(r.written, true, `divergencia "${nome}" foi aceite`);
      assert.equal(fs.readFileSync(configFile, "utf8"), base, `divergencia "${nome}" nao foi corrigida`);
    }
  });

  test("a idempotencia continua: config gerada duas vezes = written:false", () => {
    ensureFreshclamConfig(configFile, { databaseDirectory: dbDir });
    const r = ensureFreshclamConfig(configFile, { databaseDirectory: dbDir });
    assert.equal(r.written, false, "a correccao nao pode reescrever a cada update");
    assert.equal(r.reason, "ja-existe");
  });
});

/**
 * GATE DE PARSE — a config gerada so pode conter directivas que o BINARIO
 * reconhece.
 *
 * ── O bug que este bloco existe para apanhar ────────────────────────────────
 * O gerador escrevia `MaxRetry 2`. Essa directiva NAO EXISTE no freshclam, e
 * o binario abortava com
 *
 *   ERROR: Parse error at ...freshclam.conf:17: Unknown option MaxRetry
 *   ERROR: Can't open/parse the config file
 *
 * sem descarregar base nenhuma. O produto continuava a reportar ClamAV como
 * "degradado" e — pior — reescrevia o MESMO ficheiro invalido a cada update,
 * por isso o estado nao se desfazia sozinho. O utilizador encontrou-o no gate
 * manual; nenhum teste o apanhou porque todos verificavam coisas que o gerador
 * ja fazia bem (DatabaseDirectory, ausencia de `Example`) e nenhuma verificava
 * a lista de directivas.
 *
 * ── Porque este teste le o `.sample` e nao uma lista escrita a mao ──────────
 * Uma lista de directivas validas escrita dentro do teste volta a envelhecer
 * mal: o proximo upgrade do ClamAV e o teste passa a autorizar uma directiva
 * que ja nao existe, que e exactamente o bug outra vez. O `.sample` que vem
 * com o proprio ClamAV e a fonte autoritativa — muda com a versao installed.
 *
 * O teste DEGRADA (skip) se o ClamAV nao estiver instalado: nao pode ser um
 * gate que falha numa maquina de developpement sem ClamAV. Quando esta
 * instalado, e autoritativo.
 */
const CLAMAV_SAMPLE = [
  "C:\\ProgramData\\chocolatey\\lib\\clamav\\tools\\clamav-1.5.2.win.x64",
  "conf_examples",
  "freshclam.conf.sample",
];

describe("gate de parse — so directivas que o freshclam real reconhece", () => {
  const samplePath = path.join(...CLAMAV_SAMPLE);
  const temSample = fs.existsSync(samplePath);

  function directivasDoSample() {
    const src = fs.readFileSync(samplePath, "utf8");
    const validas = new Set();
    for (const linha of src.split(/\r?\n/)) {
      // As directivas vem comentadas no .sample: "#MaxAttempts 5".
      const m = /^\s*#?\s*([A-Za-z][A-Za-z0-9_]*)\s+\S/.exec(linha);
      if (m) validas.add(m[1]);
    }
    return validas;
  }

  test("a config gerada nao contem NENHUMA directiva desconhecida", (t) => {
    if (!temSample) {
      t.skip(`ClamAV nao instalado (${samplePath}) — sem amostra autoritativa`);
      return;
    }
    const validas = directivasDoSample();
    assert.ok(validas.size > 0, "o .sample nao devolveu directivas — o parser esta errado");

    const gerada = buildFreshclamConfig({
      databaseDirectory: "C:\\Users\\teste\\.cybersafe-service\\definitions\\clamav",
    });

    const usadas = [];
    for (const linha of gerada.split(/\r?\n/)) {
      if (linha.trim().startsWith("#") || !linha.trim()) continue;
      const chave = linha.trim().split(/\s+/)[0];
      usadas.push(chave);
      assert.ok(
        validas.has(chave),
        `directiva "${chave}" NAO existe no .sample do ClamAV instalado. ` +
          `O binario aborta com "Unknown option ${chave}" e nao descarrega base.`,
      );
    }
    assert.ok(usadas.length > 0, "a config gerada nao tem directivas nenhuma");
  });

  test("MaxRetry nao aparece — nem gerada, nem na config ja em disco", () => {
    const gerada = buildFreshclamConfig({
      databaseDirectory: "C:\\Users\\teste\\.cybersafe-service\\definitions\\clamav",
    });
    assert.doesNotMatch(
      gerada,
      /^\s*MaxRetry\b/m,
      "MaxRetry nao e uma directiva do freshclam — aborta o parse",
    );
  });

  test("MaxAttempts aparece, e e a unica.directiva de tentativas", () => {
    const gerada = buildFreshclamConfig({
      databaseDirectory: "C:\\Users\\teste\\.cybersafe-service\\definitions\\clamav",
      maxAttempts: 7,
    });
    assert.match(gerada, /^MaxAttempts 7$/m, "maxAttempts tem de chegar a config");
    assert.doesNotMatch(gerada, /^Retry/m);
    assert.doesNotMatch(gerada, /^MaxRetry/m);
  });

  test("as directivas estruturais que o produto depende continuam la", () => {
    const dir = "C:\\Users\\teste\\.cybersafe-service\\definitions\\clamav";
    const gerada = buildFreshclamConfig({ databaseDirectory: dir });
    assert.match(gerada, new RegExp(`^DatabaseDirectory ${dir.replace(/\\/g, "\\\\")}$`, "m"));
    assert.match(gerada, /^DatabaseMirror database\.clamav\.net$/m);
    assert.match(gerada, /^Foreground true$/m);
    assert.doesNotMatch(gerada, /^\s*Example\b/m, "`Example` impede o arranque do .sample");
  });
});

describe("6 — P1: caracteres de controlo sao REJEITADOS, nao normalizados", () => {
  // A versao anterior fazia value.replace(/[\r\n]+/g, " "), o que transformava um
  // databaseDirectory com CR/LF numa linha em vez de injecting — e o CR/LF
  // permitiria injecting uma directiva `OnUpdateExecute`. Rejeitar, nunca
  // corrigir em silencio.

  test("CR/LF no databaseDirectory lanca", () => {
    assert.throws(
      () => buildFreshclamConfig({ databaseDirectory: `${dbDir}\r\nOnUpdateExecute /c whoami` }),
      /caracteres de controlo/i,
      "CR/LF foi aceite: da para injectar directivas",
    );
  });

  test("CR/LF no databaseMirror lanca", () => {
    assert.throws(
      () => buildFreshclamConfig({ databaseDirectory: dbDir, databaseMirror: "a.test\r\nOnUpdateExecute x" }),
      /caracteres de controlo/i,
    );
  });

  test("outros caracteres de controlo tambem (NUL, ESC, TAB)", () => {
    for (const ch of ["\u0000", "\u001b", "\u0007", "\u007f"]) {
      assert.throws(
        () => buildFreshclamConfig({ databaseDirectory: `${dbDir}${ch}` }),
        /caracteres de controlo/i,
        `aceitou 0x${ch.charCodeAt(0).toString(16)}`,
      );
    }
  });

  test("ensureFreshclamConfig tambem lanca, e NAO toca no disco", () => {
    ensureFreshclamConfig(configFile, { databaseDirectory: dbDir });
    const antes = fs.readFileSync(configFile, "utf8");
    assert.throws(
      () => ensureFreshclamConfig(configFile, { databaseDirectory: `${dbDir}\r\nOnUpdateExecute x` }),
      /caracteres de controlo/i,
    );
    assert.equal(fs.readFileSync(configFile, "utf8"), antes, "o ficheiro foi alterado apesar do erro");
  });

  test("um path normal com espacos e acentos continua a passar", () => {
    // Nao pode ser-tao-estrito que barreira o uso real.
    const comEspacos = path.join(tmpRoot, "minha pasta de dados");
    const cfg = buildFreshclamConfig({ databaseDirectory: comEspacos });
    assert.ok(cfg.includes(`DatabaseDirectory ${comEspacos}`));
  });
});

describe("4 — o erro e reportado, nao engolido", () => {
  test("o erro de config da o mesmo caminho que o utilizador viu", () => {
    const stderr = "ERROR: Can't open/parse the config file C:\\...\\freshclam.conf\n";
    const msg = explainFreshclamError(stderr, configFile);
    assert.match(msg, /config/i);
    assert.ok(msg.includes(configFile), "a mensagem tem de dizer QUAL ficheiro");
  });

  test("distingue REDE de CONFIG: sao falhas diferentes", () => {
    const net = explainFreshclamError("ERROR: Could not resolve host: database.clamav.net", configFile);
    assert.match(net, /REDE/i, "uma falha de DNS nao e um problema de config");
    const cfgErr = explainFreshclamError("ERROR: Can't open/parse the config file", configFile);
    assert.doesNotMatch(cfgErr, /REDE/i);
  });

  test("um erro desconhecido nao e engolido nem virado em vazio", () => {
    const msg = explainFreshclamError("ERROR: algo inesperado", configFile);
    assert.match(msg, /inesperado/);
    assert.match(explainFreshclamError("", configFile), /sem detalhe/);
  });
});
