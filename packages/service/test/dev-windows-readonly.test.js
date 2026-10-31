/**
 * TP-WIN-P0-SERVICE-READONLY-GATE — guarda de leitura Windows (DEV).
 *
 * Corre contra `../dist/`. Não abre pipe, não faz listen, não ativa proteção,
 * não corre scans, não toca na rede: onde o motor chega a um limite externo, o
 * limite é duplado e a lista de duplos está escrita no próprio teste.
 *
 * Descoberta: `packages/service/package.json → scripts.test` é uma lista
 * explícita e foi acrescentada por escopo próprio; sem essa linha este ficheiro
 * não corre em `npm test`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LEITURAS_PERMITIDAS,
  METODOS_DO_SERVICO,
  READONLY_CODE,
  DevWindowsReadonlyError,
  validarConfigWindowsReadOnly,
  montarGuardaWindowsReadOnly,
  guardaWindowsReadOnlyMontada,
} from "../dist/dev-windows-readonly.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const TEMP = "C:\\Temp";
const RAIZ = path.join(TEMP, "cybersafe-dev-run-mock");
const SERVICE_DIR = path.join(RAIZ, "service");
const DB = path.join(RAIZ, "api", "cybersafe-test.db");
const PIPE = "\\\\.\\pipe\\cybersafe-dev-run-mock";

const envOK = (extra = {}) => ({
  NODE_ENV: "development",
  CYBERSAFE_DEV_ISOLATION: "1",
  CYBERSAFE_DEV_WINDOWS_READONLY: "1",
  CYBERSAFE_USB_PROTECTION: "0",
  CYBERSAFE_STARTUP_RESUME: "0",
  CYBERSAFE_DEV_SERVICE_DIR: SERVICE_DIR,
  CYBERSAFE_DB_PATH: DB,
  CYBERSAFE_DEV_PIPE_NAME: PIPE,
  ...extra,
});

/**
 * `process.env.X = undefined` NÃO apaga X: o Node converte para a string
 * "undefined", que é verdadeira para qualquer leitura. Os casos que precisam de
 * uma variável AUSENTE têm de a apagar de facto.
 */
function aplicarEnv(mapa) {
  for (const [chave, valor] of Object.entries(mapa)) {
    if (valor === undefined) delete process.env[chave];
    else process.env[chave] = String(valor);
  }
}

/**
 * FS simulado. `emFalta` marca caminhos inexistentes, `links` marca degraus que
 * são link/junction, `bdLinkPara` faz o ficheiro .DB ser um symlink para fora.
 * Quem decide a recusa tem de ser a validação, não a lista do mock.
 */
function depsMock({ realpathDiferente = false, links = [], emFalta = [], bdLinkPara = null } = {}) {
  const contagens = { existsSync: 0, statSync: 0, lstatSync: 0, realpathSync: 0 };
  const normal = (p) => path.normalize(p).toLowerCase();
  const plausivel = (p) => {
    const alvo = normal(p);
    return alvo === "c:\\" || alvo.startsWith("c:\\temp") || alvo.startsWith("c:\\users") || alvo.startsWith("d:\\");
  };
  const falta = (p) => emFalta.some((f) => normal(p).startsWith(normal(f)));
  const ehLink = (p) => links.some((l) => normal(l) === normal(p));
  const dentro = (p) => plausivel(p) && !falta(p);
  return {
    contagens,
    existsSync: (p) => {
      contagens.existsSync += 1;
      return dentro(p);
    },
    // `stat` SEGUE links, como no filesystem real: um link a um diretório é um
    // diretório para `stat`. Quem distingue link é `lstat` — é lá que o teste
    // marca o reparse (dizer `isSymbolicLink` no `stat` faria a validação recusar
    // por `nao_e_diretorio` antes de chegar ao varrimento, e o teste mediria o
    // mock em vez da validação).
    statSync: (p) => {
      contagens.statSync += 1;
      return { isDirectory: () => true, isSymbolicLink: () => false };
    },
    lstatSync: (p) => {
      contagens.lstatSync += 1;
      const ehFicheiro = normal(p) === normal(DB);
      if (ehFicheiro && bdLinkPara) return { isSymbolicLink: () => true, isFile: () => false };
      if (ehFicheiro) return { isSymbolicLink: () => false, isFile: () => true };
      return { isSymbolicLink: () => ehLink(p), isFile: () => false };
    },
    realpathSync: (p) => {
      contagens.realpathSync += 1;
      if (normal(p) === normal(DB) && bdLinkPara) return bdLinkPara;
      return realpathDiferente ? "D:\\fora\\da\\temperatura" : p;
    },
    homedir: () => "C:\\users\\tester",
    tmpdir: () => TEMP,
  };
}

/** Serviço falso com spy ao dispatch: conta quantas vezes o motor FOI CHAMADO. */
function servicoFalso(respostaOriginal = { ok: true, result: "do motor" }) {
  const chamadas = [];
  const servico = {
    handleRequest: async (pedido) => {
      chamadas.push(pedido?.method ?? "?");
      return { id: String(pedido?.id ?? ""), type: "response", ...respostaOriginal };
    },
  };
  return { servico, chamadas, original: servico.handleRequest };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 — OFF: zero efeito, zero IO
// ─────────────────────────────────────────────────────────────────────────────

describe("modo desligado", () => {
  it("sem a flag não monta e não faz UMA operação de filesystem", () => {
    const deps = depsMock();
    const { servico, original } = servicoFalso();
    assert.equal(montarGuardaWindowsReadOnly(servico, { NODE_ENV: "development" }, () => {}, deps), false);
    assert.equal(Object.values(deps.contagens).reduce((a, b) => a + b, 0), 0, "off não pode tocar no fs");
    assert.equal(servico.handleRequest, original, "handleRequest intacto");
    assert.equal(guardaWindowsReadOnlyMontada(servico, {}, deps).montado, false);
  });

  it("flag com valor que não é '1' não liga (e não lê o fs)", () => {
    const deps = depsMock();
    const { servico, original } = servicoFalso();
    for (const valor of ["0", "true", "yes", "", " 1 "]) {
      assert.equal(montarGuardaWindowsReadOnly(servico, envOK({ CYBERSAFE_DEV_WINDOWS_READONLY: valor }), () => {}, deps), false, valor);
    }
    assert.equal(servico.handleRequest, original);
    assert.equal(deps.contagens.existsSync, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 — Configuração negativa: cada recusa tem CAUSA nomeada, sem valores nem caminhos
// ─────────────────────────────────────────────────────────────────────────────

describe("configuração inválida recusa com causa nomeada", () => {
  const casos = [
    ["NODE_ENV=production", { NODE_ENV: "production" }, "exige_node_env_development"],
    ["NODE_ENV ausente", { NODE_ENV: undefined }, "exige_node_env_development"],
    ["sem isolamento", { CYBERSAFE_DEV_ISOLATION: undefined }, "exige_isolamento_de_dev"],
    ["isolamento != 1", { CYBERSAFE_DEV_ISOLATION: "true" }, "exige_isolamento_de_dev"],
    ["conflito fixture scan", { CYBERSAFE_REALDEV_FIXTURE_SCAN: "1" }, "conflito_com_sessao_de_fixture"],
    ["conflito fixture root", { CYBERSAFE_REALDEV_FIXTURE_ROOT: "C:\\Temp\\fix" }, "conflito_com_raiz_de_fixture"],
    ["conflito corpus canário", { CYBERSAFE_DEV_TEST_YARA_PATH: "C:\\Temp\\c.yar" }, "conflito_com_corpus_canario"],
    ["poll USB não cortado", { CYBERSAFE_USB_PROTECTION: undefined }, "exige_poll_usb_cortado"],
    ["poll USB = 1", { CYBERSAFE_USB_PROTECTION: "1" }, "exige_poll_usb_cortado"],
    ["retoma não cortada", { CYBERSAFE_STARTUP_RESUME: undefined }, "exige_retoma_de_protecao_cortada"],
    ["retoma = 1", { CYBERSAFE_STARTUP_RESUME: "1" }, "exige_retoma_de_protecao_cortada"],
    ["pipe default", { CYBERSAFE_DEV_PIPE_NAME: "\\\\.\\pipe\\cybersafe-protection-dev-v2" }, "pipe_coincide_com_default"],
    ["pipe remoto", { CYBERSAFE_DEV_PIPE_NAME: "\\\\servidor\\pipe\\x" }, "pipe_nao_local_estrito"],
    ["pipe sem forma", { CYBERSAFE_DEV_PIPE_NAME: "pipe-x" }, "pipe_nao_local_estrito"],
    ["falta service dir", { CYBERSAFE_DEV_SERVICE_DIR: undefined }, "config_parcial"],
    ["falta db", { CYBERSAFE_DB_PATH: undefined }, "config_parcial"],
    ["falta pipe", { CYBERSAFE_DEV_PIPE_NAME: undefined }, "config_parcial"],
    ["service dir relativo", { CYBERSAFE_DEV_SERVICE_DIR: "service" }, "caminhos_nao_absolutos"],
    ["db relativo", { CYBERSAFE_DB_PATH: "api/x.db" }, "caminhos_nao_absolutos"],
    ["outro disco", { CYBERSAFE_DEV_SERVICE_DIR: "D:\\outro\\service" }, "raiz_do_run_fora_da_base_temporaria"],
    ["fora de TEMP noutro caminho", { CYBERSAFE_DEV_SERVICE_DIR: "C:\\Windows\\service" }, "raiz_do_run_fora_da_base_temporaria"],
    ["raiz == TEMP inteiro (TEMP\\service)", { CYBERSAFE_DEV_SERVICE_DIR: path.join(TEMP, "service") }, "raiz_do_run_e_a_base_temporaria"],
    ["service dir == raiz (sem subpasta)", { CYBERSAFE_DEV_SERVICE_DIR: RAIZ }, "raiz_do_run_e_a_base_temporaria"],
    ["pessoal exato", { CYBERSAFE_DEV_SERVICE_DIR: "C:\\users\\tester" }, "raiz_e_o_pessoal"],
    ["sob o serviço instalado", { CYBERSAFE_DEV_SERVICE_DIR: "C:\\users\\tester\\.cybersafe-service\\x" }, "raiz_esta_no_servico_instalado"],
    ["BD noutro run", { CYBERSAFE_DB_PATH: path.join(TEMP, "outro-run", "api", "x.db") }, "bd_fora_da_raiz_do_run"],
    ["BD no TEMP todo", { CYBERSAFE_DB_PATH: path.join(TEMP, "api.db") }, "bd_fora_da_raiz_do_run"],
    ["BD sem extensão", { CYBERSAFE_DB_PATH: path.join(RAIZ, "api", "tabela") }, "bd_sem_extensao_explicita"],
  ];
  for (const [nome, extra, causa] of casos) {
    it(nome, () => {
      assert.throws(
        () => validarConfigWindowsReadOnly(envOK(extra), depsMock()),
        (erro) => erro instanceof DevWindowsReadonlyError && erro.causa === causa,
      );
    });
  }

  // — filesystem: raiz e BD, cada um com o seu motivo —
  const casosFs = [
    ["raiz inexistente", { emFalta: [RAIZ] }, "raiz_inexistente"],
    ["raiz com junction num ancestral", { links: [TEMP] }, "raiz_reparse"],
    ["raiz com junction nela própria", { links: [RAIZ] }, "raiz_reparse"],
    ["realpath da raiz difere do léxico", { realpathDiferente: true }, "raiz_realpath_difere"],
  ];
  for (const [nome, mock, causa] of casosFs) {
    it(nome, () => {
      assert.throws(
        () => validarConfigWindowsReadOnly(envOK(), depsMock(mock)),
        (erro) => erro instanceof DevWindowsReadonlyError && erro.causa === causa,
      );
    });
  }

  it("pai da BD com junction recusa (comparação léxica sozinha deixava escapar)", () => {
    assert.throws(
      () => validarConfigWindowsReadOnly(envOK(), depsMock({ links: [path.join(RAIZ, "api")] })),
      (erro) => erro instanceof DevWindowsReadonlyError && String(erro.causa).startsWith("pai_da_bd"),
    );
  });

  it("ficheiro .DB que é symlink para fora do run recusa", () => {
    assert.throws(
      () => validarConfigWindowsReadOnly(envOK(), depsMock({ bdLinkPara: "C:\\users\\tester\\real.db" })),
      (erro) => erro instanceof DevWindowsReadonlyError && String(erro.causa).startsWith("bd_"),
    );
  });

  it("caso positivo: run dedicado com service e api por baixo passa", () => {
    const config = validarConfigWindowsReadOnly(envOK(), depsMock());
    assert.equal(config.runRoot.toLowerCase(), path.resolve(RAIZ).toLowerCase());
    assert.equal(config.pipe, PIPE);
  });

  it("nenhuma mensagem de erro contém caminhos nem o valor recebido do ambiente", () => {
    const vozes = [];
    for (const extra of [
      { NODE_ENV: "production" },
      { CYBERSAFE_USB_PROTECTION: undefined },
      { CYBERSAFE_DEV_SERVICE_DIR: "D:\\segredo\\run\\service" },
      { CYBERSAFE_DEV_PIPE_NAME: "\\\\servidor\\pipe\\x" },
    ]) {
      try {
        validarConfigWindowsReadOnly(envOK(extra), depsMock());
      } catch (erro) {
        vozes.push(erro.message);
      }
    }
    assert.equal(vozes.length, 4, "todos os casos têm de recusar");
    for (const texto of vozes) {
      assert.match(texto, /^dev_windows_readonly: [a-z_]+$/, `fora do vocabulário de causas: ${texto}`);
      assert.doesNotMatch(texto, /C:\\|D:\\|\\\\\./, `caminho exposto: ${texto}`);
      assert.doesNotMatch(texto, /recebido|segredo/, `valor do chamador ecoado: ${texto}`);
    }
  });

  it("validar não escreve as ENV que exige (não corrige o launcher por trás dele)", () => {
    const env = envOK({ CYBERSAFE_USB_PROTECTION: undefined, CYBERSAFE_STARTUP_RESUME: undefined });
    assert.throws(() => validarConfigWindowsReadOnly(env, depsMock()), /exige_poll_usb_cortado/);
    assert.equal(env.CYBERSAFE_USB_PROTECTION, undefined);
    assert.equal(env.CYBERSAFE_STARTUP_RESUME, undefined);
  });

  it("montar com config má não substitui handleRequest", () => {
    const { servico, original } = servicoFalso();
    assert.throws(
      () => montarGuardaWindowsReadOnly(servico, envOK({ CYBERSAFE_USB_PROTECTION: "1" }), () => {}, depsMock()),
      DevWindowsReadonlyError,
    );
    assert.equal(servico.handleRequest, original);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 — B1: ordem dentro de index.ts, antes do primeiro efeito de logging
// ─────────────────────────────────────────────────────────────────────────────

describe("bootstrap: validação antes dos efeitos", () => {
  // Medido no FONTE, não no compilado: `index.ts` tem declarações `import`
  // ABALADAS pelo ficheiro (uma delas, `./engine.js`, vem depois do bloco de
  // LOG HYGIENE). Em ESM todas as importações são içadas e avaliadas antes do
  // corpo, pelo que procurar texto no `dist` só diria «o import veio antes» — que
  // é verdade para todos os módulos e não é a garantia que este modo pretende.
  // A garantia é a ordem das instruções que `index.ts` ele próprio produz.
  const fonte = fs.readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
  const linhas = fonte.split(/\r?\n/);
  const linhaDe = (procuro) => {
    const i = linhas.findIndex((l) => l.includes(procuro));
    assert.ok(i >= 0, `marcador em falta no fonte: ${procuro}`);
    return i;
  };

  it("a validação antecede BASE_DIR, mkdir, rotação e escrita de log, construtor e pipe", () => {
    const validacao = linhaDe("validarConfigWindowsReadOnly(process.env)");
    for (const [nome, marcador] of [
      ["serviceBaseDir() → BASE_DIR", "const BASE_DIR = serviceBaseDir()"],
      ["mkdir de BASE_DIR", "fs.mkdirSync(BASE_DIR"],
      ["rotação de error.log", "reclaimOversizedLog(ERROR_LOG"],
      ["rotação de boot-debug.log", "reclaimOversizedLog(DEBUG_LOG"],
      ["primeira escrita no log de boot", "bootDebug.write"],
      ["escritores de log", "new SyncLogWriter"],
      ["mkdir de LOG_DIR", "fs.mkdirSync(LOG_DIR"],
      ["construtor do serviço", "new ProtectionEngineService()"],
      ["init do serviço", "await service.init()"],
      ["pipe server", "service.startPipeServer()"],
    ]) {
      assert.ok(validacao < linhaDe(marcador), `a validação (linha ${validacao}) tem de anteceder ${nome}`);
    }
  });

  it("a decisão é condicional à flag: sem ela o corpo não chama a validação", () => {
    const validacao = linhaDe("validarConfigWindowsReadOnly(process.env)");
    const guardas = linhas.slice(Math.max(0, validacao - 2), validacao + 1).join("\n");
    assert.match(guardas, /CYBERSAFE_DEV_WINDOWS_READONLY\s*===\s*"1"/, "tem de ser teste à flag, não chamada incondicional");
  });

  it("limite declarado: a anterioridade é sobre o corpo de index.ts, não sobre os módulos importados", () => {
    // O que NÃO está provado: que nenhum código de módulo importado correu antes.
    // `import "dotenv/config"` e o topo de `./log-writer.js`/`./engine.js` são
    // avaliados antes de qualquer instrução deste corpo, seja qual for a
    // colocação — um processo com config inválida pode portanto ter lido `.env`
    // e aberto descritores internos antes de lançar. O que se garante é que a
    // máquina de logging e o construtor/pipe do serviço não correm.
    assert.ok(linhas.some((l) => l.includes('import "dotenv/config"')), "se isto falhar, o limite documentado mudou e a nota acima tem de ser reescrita");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 — Allowlist cerrada: ZERO dispatch para o que não é leitura
// ─────────────────────────────────────────────────────────────────────────────

describe("allowlist cerrada", () => {
  it("as permitidas são um subconjunto do dispatch real, sem nomes inventados", () => {
    assert.equal(METODOS_DO_SERVICO.size, 42, "o vocabulário do dispatch mudou");
    assert.equal(new Set(METODOS_DO_SERVICO).size, METODOS_DO_SERVICO.size);
    for (const m of LEITURAS_PERMITIDAS) assert.ok(METODOS_DO_SERVICO.has(m), `permitida fora do dispatch: ${m}`);
  });

  for (const metodo of METODOS_DO_SERVICO) {
    const permitida = LEITURAS_PERMITIDAS.has(metodo);
    it(`${metodo}: ${permitida ? "leitura passa" : "recusada sem tocar no motor"}`, async () => {
      const { servico, chamadas } = servicoFalso();
      assert.equal(montarGuardaWindowsReadOnly(servico, envOK(), () => {}, depsMock()), true);
      const resposta = await servico.handleRequest({ id: "p1", type: "request", method: metodo });
      if (permitida) {
        assert.deepEqual(chamadas, [metodo], "leitura permitida tem de chegar ao motor");
        assert.equal(resposta.ok, true);
      } else {
        assert.deepEqual(chamadas, [], "nenhuma mutação pode ser TENTADA");
        assert.equal(resposta.ok, false);
        assert.ok(String(resposta.error).startsWith(`${READONLY_CODE}:`));
        assert.doesNotMatch(String(resposta.error), /C:\\|D:\\/, "recusa sem caminhos");
      }
    });
  }

  it("mutações conhecidas estão todas vetadas", () => {
    for (const m of [
      "monitor.start", "monitor.stop", "monitor.pause", "monitor.resume", "protectionIntent.setOptIn",
      "process.analyze", "process.killTree", "exclusions.update", "definitions.update", "events.clear",
      "quarantine.restore", "quarantine.delete", "trust.allowHash", "trust.allowPublisher", "threat.action",
      "usb.configure", "usb.scan", "usb.cancel", "scan.start", "scan.cancel", "scan.fullSystem",
      "scan.artifact", "analysis.restricted", "service.shutdown",
    ]) {
      assert.equal(LEITURAS_PERMITIDAS.has(m), false, `mutação permitida: ${m}`);
    }
  });

  it("método desconhecido é recusado sem ecoar o valor do pedido", async () => {
    const linhas = [];
    const { servico, chamadas } = servicoFalso();
    montarGuardaWindowsReadOnly(servico, envOK(), (l) => linhas.push(l), depsMock());
    const r = await servico.handleRequest({ id: "p", type: "request", method: "C:\\pessoal\\pedido-privado" });
    assert.deepEqual(chamadas, []);
    assert.equal(r.ok, false);
    const texto = linhas.join("\n") + String(r.error);
    assert.doesNotMatch(texto, /pessoal|pedido-privado/, "o valor arbitrário do método não pode aparecer no log nem na resposta");
    assert.match(texto, /metodo_desconhecido/);
  });

  for (const [nome, pedido] of [
    ["sem pedido", undefined],
    ["não-objeto", 7],
    ["sem método", { id: "x", type: "request" }],
    ["método vazio", { id: "x", type: "request", method: "" }],
    ["type errado", { id: "x", type: "response", method: "processes.list" }],
  ]) {
    it(`${nome} → recusado sem dispatch`, async () => {
      const { servico, chamadas } = servicoFalso();
      montarGuardaWindowsReadOnly(servico, envOK(), () => {}, depsMock());
      const r = await servico.handleRequest(pedido);
      assert.equal(chamadas.length, 0);
      assert.equal(r.ok, false);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 — O marcador não é autoridade
// ─────────────────────────────────────────────────────────────────────────────

describe("prova de posse da instalação", () => {
  it("outra raiz no mesmo processo recusa, em vez de confiar no '1'", async () => {
    const env = envOK();
    const { servico, chamadas } = servicoFalso();
    assert.equal(montarGuardaWindowsReadOnly(servico, env, () => {}, depsMock()), true);
    env.CYBERSAFE_DEV_SERVICE_DIR = path.join(TEMP, "outro-run", "service");
    env.CYBERSAFE_DB_PATH = path.join(TEMP, "outro-run", "api", "x.db");
    const r = await servico.handleRequest({ id: "p", type: "request", method: "processes.list" });
    assert.deepEqual(chamadas, []);
    assert.equal(r.ok, false);
    assert.match(String(r.error), /raiz_do_ambiente_nao_e_a_raiz_registada/);
  });

  it("USB re-ligado depois de montar recusa a leitura", async () => {
    const env = envOK();
    const { servico, chamadas } = servicoFalso();
    montarGuardaWindowsReadOnly(servico, env, () => {}, depsMock());
    env.CYBERSAFE_USB_PROTECTION = "1";
    await servico.handleRequest({ id: "p", type: "request", method: "processes.list" });
    assert.deepEqual(chamadas, []);
  });

  it("wrapper trocado por imitação não conta como montado", () => {
    const { servico } = servicoFalso();
    assert.equal(guardaWindowsReadOnlyMontada(servico, envOK(), depsMock()).montado, false);
    montarGuardaWindowsReadOnly(servico, envOK(), () => {}, depsMock());
    assert.equal(guardaWindowsReadOnlyMontada(servico, envOK(), depsMock()).montado, true);
    servico.handleRequest = async () => ({ ok: true });
    const prova = guardaWindowsReadOnlyMontada(servico, envOK(), depsMock());
    assert.equal(prova.montado, false);
    assert.equal(prova.causa, "wrapper_nao_e_o_registado");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6 — B3: init REAL do ProtectionEngineService, com limites externos duplados
// ─────────────────────────────────────────────────────────────────────────────

describe("ProtectionEngineService.init real (limites duplados)", () => {
  /**
   * O que é real: o `init()` do serviço, a leitura de ambiente, o `ProtectionStartup`
   * REAL com o `ProtectionIntentStore` REAL e a intenção `{desired:"enabled"}` escrita
   * em disco no raiz sintética, e o `decidirArranque` real.
   * O que é duplo, e só isto, são as FRONTEIRAS EXTERNAS que o init atravessa:
   * runtime USB (poll PowerShell/CIM), o `startProtection` que ligaria vigilância e
   * scanners, YARA-X (carrega regras), ClamAV (sonda um binário externo), o
   * agendador de actualizações (rede) e `startPipeServer` (escuta). A decisão de os
   * chamar ou não é toda do `init()` real — e o controlo de não-vacuidade prova que
   * com os cortes em falta ELAS SÃO chamadas.
   */
  async function motorRealParaInit() {
    const [mod, intent] = await Promise.all([
      import("../dist/engine.js"),
      import("../dist/protection-intent.js"),
    ]);
    const raiz = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cs-wr-init-"));
    const duplos = { usb: 0, start: 0, yaraLoad: 0, clamav: 0, pipe: 0, updater: 0 };
    const servico = new mod.ProtectionEngineService(raiz);

    // Fronteiras externas, uma a uma. `startProtection` é a única porta pela qual
    // o `ProtectionStartup` real pode ligar proteção: o closure do construtor faz
    // `this.startProtection()`, logo a substituição na instância é respeitada.
    servico.usbRuntime = { iniciar: async () => { duplos.usb += 1; } };
    servico.startProtection = async () => { duplos.start += 1; servico.protectionState = true; return { ok: true }; };
    // O spread só copia propriedades PRÓPRIAS: `health` é um getter do protótipo
    // de YaraEngine, por isso perde-se e o `init()` rebentava em
    // `this.yara.health.coverage` (dist/engine.js). O duplo declara então o health
    // que corresponde a um_corpus cuja leitura foi fingida: nada medido, logo
    // `unknown` — e é esse valor que impede o init de chamar a recuperação de
    // rede (`coverage === "limited"`), que este caso não quer exercitar.
    servico.yara = {
      ...(servico.yara ?? {}),
      health: { status: "active", coverage: "unknown", detail: "duplo: o load é fingido, nada foi medido" },
      load: async () => { duplos.yaraLoad += 1; },
    };
    servico.clamav = { ...(servico.clamav ?? {}), isAvailable: async () => { duplos.clamav += 1; return false; } };
    servico.updater = { startScheduler: () => { duplos.updater += 1; } };
    servico.startPipeServer = async () => { duplos.pipe += 1; };

    // Intenção ATIVA escrita pelo caminho legítimo (o mesmo que o controlo de
    // Definições usa), no store real apontado para a raiz sintética desta corrida.
    await servico.protectionStartup.definirOptin(true);
    const lerIntent = JSON.parse(
      fs.readFileSync(path.join(raiz, "protection-intent.json"), "utf8"),
    );
    assert.equal(lerIntent.desired, "enabled", "o pré-condicionado do caso é uma intenção enabled escrita em disco");

    servico.__duplos = duplos;
    servico.__raiz = raiz;
    assert.equal(intent.protectionIntentPath(raiz), path.join(raiz, "protection-intent.json"));
    return servico;
  }

  it("CONTROLO de não-vacuidade: sem os cortes, o init real ALCANÇA as fronteiras", async () => {
    const anterior = { ...process.env };
    let servico = null;
    try {
      aplicarEnv({
        ...envOK(),
        CYBERSAFE_USB_PROTECTION: undefined,
        CYBERSAFE_STARTUP_RESUME: undefined,
        CYBERSAFE_DEV_WINDOWS_READONLY: undefined,
        CYBERSAFE_DEV_TEST_YARA_PATH: undefined,
        CYBERSAFE_REALDEV_FIXTURE_SCAN: undefined,
        CYBERSAFE_REALDEV_FIXTURE_ROOT: undefined,
        NODE_ENV: "development",
      });
      servico = await motorRealParaInit();
      await servico.init();
      assert.ok(servico.__duplos.usb >= 1, "o poll USB tinha de ser chamado sem CYBERSAFE_USB_PROTECTION=0 — a não ser assim, o assert do caso positivo é vazio");
      assert.ok(servico.__duplos.start >= 1, "com intenção enabled escrita em disco, o init real tinha de chegar a startProtection");
      assert.equal(servico.protectionState, true, "o controlo tem de mostrar o efeito, não só a contagem");
    } finally {
      if (servico) fs.rmSync(servico.__raiz, { recursive: true, force: true });
      process.env = anterior;
    }
  });

  it("com USB=0 e RETOMA=0 o init real não alcança NEM o poll NEM a proteção", async () => {
    const anterior = { ...process.env };
    let servico = null;
    try {
      const ambiente = envOK({ CYBERSAFE_DEV_WINDOWS_READONLY: undefined });
      // A mesma env é aceite pela validação do modo ANTES de init (B1) — senão
      // estaríamos a testar um modo que o próprio modo recusa.
      validarConfigWindowsReadOnly(ambiente, depsMock());
      aplicarEnv(ambiente);
      servico = await motorRealParaInit();
      await servico.init();
      assert.equal(servico.__duplos.usb, 0, "o poll USB não pode arrancar neste modo");
      assert.equal(servico.__duplos.start, 0, "a retoma não pode ligar proteção neste modo");
      assert.equal(servico.__duplos.pipe, 0, "init() não abre o pipe");
      // O agendador de DEFINIÇÕES passou a arrancar com o SERVIÇO (causa medida
      // TP-RETOMA-01: a proteção OFF deixava a base ClamAV envelhecer). USB=0 e
      // RETOMA=0 cortam o poll e a proteção, não as assinaturas. Nos modos
      // readonly/fixture/teste ele continua a NÃO nascer (teste de wiring).
      assert.equal(servico.__duplos.updater, 1, "o agendador de definições arranca com o serviço; USB/retoma não o desligam");
      assert.ok(servico.__duplos.yaraLoad >= 1, "o resto do init tem de ter corrido (YARA carregado) — senão o 0 acima foi por init ter parado cedo");
      assert.ok(servico.__duplos.clamav >= 1, "idem para a sonda ClamAV");
      assert.equal(servico.protectionState, false, "proteção continua desligada após init");
      // A intenção continua escrita em disco: o corte é no arranque, não no dado.
      const lerIntent = JSON.parse(
        fs.readFileSync(path.join(servico.__raiz, "protection-intent.json"), "utf8"),
      );
      assert.equal(lerIntent.desired, "enabled", "USB=0/RETOMA=0 corta o efeito, não apaga a intenção do utilizador");
    } finally {
      if (servico) fs.rmSync(servico.__raiz, { recursive: true, force: true });
      process.env = anterior;
    }
  });

  it("a validação do modo exige precisamente estes dois cortes, antes de init", () => {
    assert.throws(() => validarConfigWindowsReadOnly(envOK({ CYBERSAFE_USB_PROTECTION: undefined }), depsMock()), /exige_poll_usb_cortado/);
    assert.throws(() => validarConfigWindowsReadOnly(envOK({ CYBERSAFE_STARTUP_RESUME: undefined }), depsMock()), /exige_retoma_de_protecao_cortada/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7 — Métricas e privacidade na fronteira (sem afirmações falsas)
// ─────────────────────────────────────────────────────────────────────────────

describe("fronteira processes.list", () => {
  it("passa o contrato existente sem inventar nem apagar campos", async () => {
    const doProvider = [{ pid: 1, ppid: 0, name: "x.exe", path: "C:\\x", commandLine: "C:\\x --segredo", cpu: 12.5, memoryMb: 34, startedAt: "2026-10-21T00:00:00.000Z", trusted: "unknown" }];
    const { servico } = servicoFalso({ ok: true, result: doProvider });
    montarGuardaWindowsReadOnly(servico, envOK(), () => {}, depsMock());
    const r = await servico.handleRequest({ id: "p", type: "request", method: "processes.list" });
    assert.equal(r.result, doProvider, "a guarda não altera a resposta das leituras permitidas");
  });

  it("a guarda não escreve payloads nem caminhos no log", async () => {
    const linhas = [];
    const { servico } = servicoFalso({ ok: true, result: [{ pid: 1, commandLine: "C:\\pessoal\\segredo.txt" }] });
    montarGuardaWindowsReadOnly(servico, envOK(), (l) => linhas.push(l), depsMock());
    await servico.handleRequest({ id: "p", type: "request", method: "processes.list" });
    await servico.handleRequest({ id: "q", type: "request", method: "monitor.start" });
    assert.doesNotMatch(linhas.join("\n"), /segredo|C:\\pessoal|commandLine/i, "log da guarda não pode conter payload");
    assert.match(linhas.join("\n"), /recusou monitor\.start/);
  });

  it("declaração medida: o provider tem métricas REAIS por enriquecimento, e 0 é só fallback", (t) => {
    // Revisão da Root (B4): a fase (b) de `snapshotProcesses` enriquece com
    // `si.processes()` e atribui cpu/memoryMb/path/ppid/user. `cpu: 0`/
    // `memoryMb: 0` são o valor inicial do registo CIM, não o resultado final do
    // provider. A afirmação anterior («o provider não tem métricas») estava errada
    // e foi retirada deste candidato.
    const candidatos = [
      new URL("../../native-windows/src/index.ts", import.meta.url),
      "C:/Users/caioc/.cybersafe-integration/realdev-qoder-20261019/repo/packages/native-windows/src/index.ts",
    ];
    let codigo = null;
    for (const origem of candidatos) {
      const p = typeof origem === "string" ? origem : fileURLToPath(origem);
      if (fs.existsSync(p)) { codigo = fs.readFileSync(p, "utf8"); break; }
    }
    if (codigo === null) {
      // A lane não contém `packages/native-windows`: sem o fonte, este caso não
      // pode afirmar nada e fica LABELADO como skip — não é uma passagem.
      t.skip("fonte do provider indisponível na lane; nada se afirma sobre enriquecimento");
      return;
    }
    assert.match(codigo, /si\.processes\(\)/, "o enriquecimento tem de existir para este caso fazer sentido");
    assert.match(codigo, /existing\.cpu = /, "cpu é atribuído no enriquecimento");
    assert.match(codigo, /existing\.memoryMb = /, "memoryMb é atribuído no enriquecimento");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8 — Exclusividade com o fixture e resposta inalterada
// ─────────────────────────────────────────────────────────────────────────────

describe("coexistência", () => {
  it("recusa montar com o gate de fixture ligado", () => {
    assert.throws(
      () => montarGuardaWindowsReadOnly(servicoFalso().servico, envOK({ CYBERSAFE_REALDEV_FIXTURE_SCAN: "1" }), () => {}, depsMock()),
      /conflito_com_sessao_de_fixture/,
    );
  });

  it("resposta das leituras permitidas mantém o que o motor devolve", async () => {
    const { servico } = servicoFalso({ ok: true, result: { x: 1 } });
    montarGuardaWindowsReadOnly(servico, envOK(), () => {}, depsMock());
    const r = await servico.handleRequest({ id: "abc", type: "request", method: "pcstate.get" });
    assert.equal(r.ok, true);
    assert.deepEqual(r.result, { x: 1 });
  });
});
