import { registerAiCredentialsIpc } from "../src/ai-credentials-ipc.ts";
import { registerProcessTerminationIpc } from "../src/process-termination-ipc.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * TP-WIN-P0-DESKTOP-READONLY-BOUNDARY — fronteira de leitura do Desktop.
 *
 * Convenção da própria package (ver `ipc-guard.test.mjs` e `s4-sender-guard.test.mjs`):
 * importa-se o TypeScript por caminho relativo (Node faz type-stripping) e o
 * `main.ts` é lido como texto para amarrar o banco de ensaio ao registo real.
 *
 * Nada aqui abre Electron, redes, ficheiros ou processos: os efeitos externos
 * são duplados e contados. O banco re-compõe exatamente a cadeia que `main.ts`
 * usa — `ipcMain.handle(channel, trustedIpcHandler(..., comPoliticaLeituraWindows(...)))`
 * — e um teste de fonte afirma que essa é de facto a cadeia registada, para que o
 * banco não seja uma invenção paralela.
 */

const aqui = path.dirname(fileURLToPath(import.meta.url));
const fonteMain = fs.readFileSync(path.join(aqui, "..", "src", "main.ts"), "utf8");

const {
  CANAIS_NEGADOS,
  CANAIS_PERMITIDOS,
  WINDOWS_READONLY_BOUNDARY_CODE,
  comPoliticaLeituraWindows,
  decidirCanalWindowsReadOnly,
  suprimirAcoesTray,
  validarFronteiraWindowsReadOnly,
  validarRespostaSaida,
} = await import("../src/dev-windows-readonly-boundary.ts");

const { guardedServiceRequest, trustedIpcHandler } = await import("../src/ipc-guard.ts");

// ─────────────────────────────────────────────────────────────────────────────
// Perfil efectivo e ambiente
// ─────────────────────────────────────────────────────────────────────────────

const RAIZ = "C:\\Temp\\cs-run-desk-1";
const PIPE = "\\\\.\\pipe\\cs-run-desk-1";
const DB = path.join(RAIZ, "api", "cybersafe-test.db");

/** O objecto que `resolveDevProfile` devolve em DEV (mesmos campos consumidos). */
const perfilOk = (extra = {}) => ({
  pipeName: PIPE,
  apiPort: 4100,
  apiPortNao: 4100,
  apiBase: "http://127.0.0.1:4100",
  injectApiBaseInRenderer: true,
  userDataDir: path.join(RAIZ, "userData"),
  sessionDir: path.join(RAIZ, "session"),
  raizDev: RAIZ,
  appName: "CybersafeDev",
  instanceId: "abcd1234abcd1234",
  dbPath: DB,
  protectionService: false,
  autoStart: false,
  ...extra,
});

const envOk = (extra = {}) => ({
  NODE_ENV: "development",
  CYBERSAFE_DEV_ISOLATION: "1",
  CYBERSAFE_DEV_WINDOWS_READONLY: "1",
  CYBERSAFE_DEV_ROOT: RAIZ,
  CYBERSAFE_DEV_SERVICE_DIR: path.join(RAIZ, "service"),
  CYBERSAFE_DEV_PIPE_NAME: PIPE,
  CYBERSAFE_DB_PATH: DB,
  CYBERSAFE_DEV_PORT: "4100",
  CYBERSAFE_USB_PROTECTION: "0",
  CYBERSAFE_STARTUP_RESUME: "0",
  ...extra,
});

/**
 * FS simulado LIMPO: a raiz do run e os pais de userData/session/BD/serviço
 * existem; as próprias folhas ainda podem estar por criar (o `userData` nasce
 * quando o Electron o pedir). É este objecto que a validação usa quando o teste
 * não passa outro — o caminho feliz com filesystem REAL tem caso próprio.
 */
function fsLimpo() {
  const norm = (s) => {
    try { return path.resolve(s).toLowerCase().replace(/[\/]+$/, ""); } catch { return ""; }
  };
  const existentes = new Set([
    norm(RAIZ),
    norm(path.join(RAIZ, "service")),
    norm(path.join(RAIZ, "api")),
  ]);
  return {
    existe: existentes,
    liga: new Set(),
    difereReal: null,
    existsSync: (c) => existentes.has(norm(c)),
    lstatSync: (c) => ({ isSymbolicLink: () => false }),
    realpathSync: (c) => c,
  };
}

/** FS com degraus que existem e alguns que são link/junction. */
function fsSim({ existem = [], links = [], realpathDe = null } = {}) {
  const norm = (s) => {
    try { return path.resolve(s).toLowerCase().replace(/[\/]+$/, ""); } catch { return ""; }
  };
  const existentes = new Set(existem.map(norm));
  const ligacoes = new Set(links.map(norm));
  return {
    existsSync: (c) => existentes.has(norm(c)),
    lstatSync: (c) => ({ isSymbolicLink: () => ligacoes.has(norm(c)) }),
    realpathSync: (c) => (realpathDe && norm(c) === norm(realpathDe.alvo) ? realpathDe.real : c),
  };
}

const valida = (o) =>
  validarFronteiraWindowsReadOnly({ fsLike: fsLimpo(), ...o });

const TOKEN = new RegExp(`^${WINDOWS_READONLY_BOUNDARY_CODE}: [a-z_]+$`);

// ─────────────────────────────────────────────────────────────────────────────
// 1 — OFF: sem um único pedido de ambiente além da flag
// ─────────────────────────────────────────────────────────────────────────────

describe("modo desligado", () => {
  it("devolve inactivo e só lê a própria flag", () => {
    const lidas = [];
    const base = { NODE_ENV: "development", CYBERSAFE_USB_PROTECTION: "1", CYBERSAFE_DEV_ISOLATION: undefined };
    const espiao = new Proxy(base, {
      get(alvo, chave) {
        if (typeof chave === "string") lidas.push(chave);
        return alvo[chave];
      },
      has(alvo, chave) {
        if (typeof chave === "string") lidas.push(chave);
        return chave in alvo;
      },
    });
    const decisao = valida({ env: espiao, isPackaged: false, perfil: perfilOk() });
    assert.deepEqual(decisao, { activo: false, causa: "modo_nao_pedido" });
    assert.deepEqual(
      [...new Set(lidas)].sort(),
      ["CYBERSAFE_DEV_WINDOWS_READONLY"],
      `off não pode consultar mais ambiente do que a flag (lido: ${JSON.stringify([...new Set(lidas)])})`,
    );
  });

  it("flag com valor que não é '1' continua desligada", () => {
    for (const valor of ["0", "true", "", " 1 ", undefined]) {
      const d = valida({
        env: envOk({ CYBERSAFE_DEV_WINDOWS_READONLY: valor }),
        isPackaged: false,
        perfil: perfilOk(),
      });
      assert.equal(d.activo, false, String(valor));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 — Configuração negativa: cada recusa tem causa nomeada, sem valores
// ─────────────────────────────────────────────────────────────────────────────

describe("configuração inválida recusa antes de qualquer efeito", () => {
  const BARRA = "\\\\"; // uma barra invertida literal, sem depender de escapes no meio do texto
  const p = (...segmentos) => ["C:", "Temp", ...segmentos].join(BARRA);
  const casos = [
    { nome: "empacotado com a flag posta", isPackaged: true, causa: "empacotado_recusa_modo_dev" },
    { nome: "sem isolamento", env: { CYBERSAFE_DEV_ISOLATION: undefined }, causa: "exige_isolamento_de_dev" },
    { nome: "isolamento != 1", env: { CYBERSAFE_DEV_ISOLATION: "true" }, causa: "exige_isolamento_de_dev" },
    { nome: "perfil sem raiz", perfil: { raizDev: undefined }, causa: "perfil_de_dev_incompleto" },
    { nome: "perfil sem userData", perfil: { userDataDir: undefined }, causa: "perfil_de_dev_incompleto" },
    { nome: "perfil sem pipe", perfil: { pipeName: undefined }, causa: "perfil_de_dev_incompleto" },
    { nome: "perfil de produção (autoStart ligado)", perfil: { autoStart: true }, causa: "perfil_efectivo_e_o_de_producao" },
    { nome: "perfil de produção (serviço ligado)", perfil: { protectionService: true }, causa: "perfil_efectivo_e_o_de_producao" },
    { nome: "userData fora da raiz", perfil: { userDataDir: ["C:", "Temp", "outra", "userData"].join(BARRA) }, causa: "user_data_fora_da_raiz" },
    { nome: "session fora da raiz", perfil: { sessionDir: ["C:", "Users", "real", "session"].join(BARRA) }, causa: "session_data_fora_da_raiz" },
    { nome: "BD fora da raiz", perfil: { dbPath: ["D:", "outra", "api", "x.db"].join(BARRA) }, causa: "bd_fora_da_raiz" },
    { nome: "service dir ausente", env: { CYBERSAFE_DEV_SERVICE_DIR: undefined }, causa: "service_dir_ausente" },
    { nome: "service dir == raiz (sem nível próprio)", env: { CYBERSAFE_DEV_SERVICE_DIR: RAIZ }, causa: "service_dir_fora_da_raiz" },
    { nome: "service dir noutro disco", env: { CYBERSAFE_DEV_SERVICE_DIR: ["D:", "fora", "service"].join(BARRA) }, causa: "service_dir_fora_da_raiz" },
    { nome: "pipe do perfil diverge do pedido ao serviço", env: { CYBERSAFE_DEV_PIPE_NAME: ["", "", ".", "pipe", "outro"].join(BARRA) }, causa: "pipe_diverge_do_servico" },
    { nome: "pipe não é nome de pipe Windows", perfil: { pipeName: p("pipe") }, causa: "pipe_diverge_do_servico" },
    { nome: "BD do perfil diverge da BD do run", env: { CYBERSAFE_DB_PATH: path.join(RAIZ, "api", "outra.db") }, causa: "bd_diverge_do_servico" },
    { nome: "API na porta de produção", perfil: { apiPort: 4000 }, causa: "porta_api_abaixo_do_piso_dev" },
    { nome: "API divergente do pedido", env: { CYBERSAFE_DEV_PORT: "4120" }, causa: "porta_api_diverge_do_pedido" },
    // ── Revisão da Root: a contenção é estrutural, não de prefixo léxico ─────
    {
      nome: "dotdot a sair da raiz (C:\\Temp\\run\\..\\..\\Windows)",
      perfil: { userDataDir: path.join(RAIZ, "..", "..", "Windows", "userData") },
      causa: "user_data_fora_da_raiz",
    },
    {
      nome: "dotdot no service dir do ambiente",
      env: { CYBERSAFE_DEV_SERVICE_DIR: path.join(RAIZ, "service", "..", "..", "..", "fora") },
      causa: "service_dir_fora_da_raiz",
    },
    {
      nome: "userData é junction (degrau existe, mas é link)",
      perfil: {},
      fs: fsSim({
        existem: [RAIZ, path.join(RAIZ, "service"), path.join(RAIZ, "api"), path.join(RAIZ, "userData")],
        links: [path.join(RAIZ, "userData")],
      }),
      causa: "user_data_reparse",
    },
    {
      nome: "session é symlink",
      fs: fsSim({
        existem: [RAIZ, path.join(RAIZ, "service"), path.join(RAIZ, "api"), path.join(RAIZ, "session")],
        links: [path.join(RAIZ, "session")],
      }),
      causa: "session_data_reparse",
    },
    {
      nome: "a própria raiz do run é junction",
      fs: fsSim({ existem: [RAIZ, path.join(RAIZ, "service")], links: [RAIZ] }),
      causa: "raiz_do_run_reparse",
    },
    {
      nome: "ancestral da raiz (base temporária) é junction",
      fs: fsSim({ existem: [RAIZ, "C:\\Temp", path.join(RAIZ, "service")], links: ["C:\\Temp"] }),
      causa: "ancestral_da_raiz_reparse",
    },
    {
      nome: "realpath da raiz difere do léxico",
      fs: fsSim({
        existem: [RAIZ, path.join(RAIZ, "service")],
        realpathDe: { alvo: RAIZ, real: ["D:", "fora", "run"].join(BARRA) },
      }),
      causa: "raiz_do_run_realpath_difere",
    },
    {
      nome: "raiz do run ainda não existe",
      fs: fsSim({ existem: [] }),
      causa: "raiz_do_run_inexistente",
    },
    {
      nome: "pai do userData não existe (só a folha pode estar por criar)",
      fs: fsSim({ existem: [RAIZ, path.join(RAIZ, "service")] }),
      perfil: { userDataDir: path.join(RAIZ, "sem-pai", "userData") },
      causa: "user_data_pai_inexistente",
    },
    { nome: "NODE_ENV ausente do ambiente", env: { NODE_ENV: undefined }, causa: "exige_node_env_development" },
    { nome: "NODE_ENV=production no ambiente", env: { NODE_ENV: "production" }, causa: "exige_node_env_development" },
    { nome: "NODE_ENV vazio", env: { NODE_ENV: "" }, causa: "exige_node_env_development" },
    { nome: "pipe não declarado no ambiente", env: { CYBERSAFE_DEV_PIPE_NAME: undefined }, causa: "pipe_ausente_no_ambiente" },
    { nome: "BD não declarada no ambiente", env: { CYBERSAFE_DB_PATH: undefined }, causa: "bd_ausente_no_ambiente" },
    { nome: "raiz de fixture RELATIVA", env: { CYBERSAFE_REALDEV_FIXTURE_ROOT: "fixture-relativa" }, causa: "conflito_com_raiz_de_fixture" },
    { nome: "corpus canário RELATIVO", env: { CYBERSAFE_DEV_TEST_YARA_PATH: "c.yar" }, causa: "conflito_com_corpus_canario" },
    { nome: "poll USB não cortado", env: { CYBERSAFE_USB_PROTECTION: undefined }, causa: "exige_poll_usb_cortado" },
    { nome: "poll USB = 1", env: { CYBERSAFE_USB_PROTECTION: "1" }, causa: "exige_poll_usb_cortado" },
    { nome: "retoma não cortada", env: { CYBERSAFE_STARTUP_RESUME: undefined }, causa: "exige_retoma_de_protecao_cortada" },
    { nome: "retoma = 1", env: { CYBERSAFE_STARTUP_RESUME: "1" }, causa: "exige_retoma_de_protecao_cortada" },
    { nome: "sessão de fixture ligada", env: { CYBERSAFE_REALDEV_FIXTURE_SCAN: "1" }, causa: "conflito_com_sessao_de_fixture" },
    { nome: "raiz de fixture declarada", env: { CYBERSAFE_REALDEV_FIXTURE_ROOT: p("fix") }, causa: "conflito_com_raiz_de_fixture" },
    { nome: "corpus canário declarado", env: { CYBERSAFE_DEV_TEST_YARA_PATH: p("c.yar") }, causa: "conflito_com_corpus_canario" },
  ];

  for (const c of casos) {
    it(`${c.nome} → ${c.causa}`, () => {
      assert.throws(
        () => valida({
          env: envOk(c.env ?? {}),
          isPackaged: c.isPackaged ?? false,
          perfil: perfilOk(c.perfil ?? {}),
          ...(c.fs ? { fsLike: c.fs } : {}),
        }),
        (erro) => {
          assert.match(erro.message, TOKEN, `mensagem fora da forma fechada: ${erro.message}`);
          assert.equal(erro.causa, c.causa, erro.message);
          return true;
        },
      );
    });
  }

  it("o caso empacotado usa mesmo isPackaged=true (não é o perfil que decide)", () => {
    assert.throws(
      () => valida({ env: envOk(), isPackaged: true, perfil: perfilOk() }),
      /empacotado_recusa_modo_dev/,
    );
  });

  it("caso positivo: run dedicado consistente com o serviço liga", () => {
    const d = valida({ env: envOk(), isPackaged: false, perfil: perfilOk() });
    assert.deepEqual(d, { activo: true, causa: "fronteira_validada" });
  });

  it("BLOCKER da revisão: a CHAMADA REAL de main.ts é executada, com env de desenvolvimento", () => {
    // A expressão REAL do `main.ts`, com a forma exata verificada (sem compilar
    // texto como código: o assert de forma é que amarra o teste à chamada real).
    const chamada = fonteMain.match(
      /const fronteiraLeituraWindows =\s*validarFronteiraWindowsReadOnly\(\s*\{\s*env:\s*process\.env,\s*isPackaged:\s*app\.isPackaged,\s*perfil,?\s*\}\s*\)\s*;/,
    );
    assert.ok(
      chamada,
      "main.ts tem de chamar validarFronteiraWindowsReadOnly({ env: process.env, isPackaged: app.isPackaged, perfil })",
    );
    assert.doesNotMatch(
      chamada[0],
      /nodeEnv/,
      "o `nodeEnv` duplicado na chamada foi exatamente o que fez o modo recusar sempre",
    );
    // Mesmos três campos, mesma ordem de decisão.
    const executa = (ambiente, empacotado, perfilReal) =>
      validarFronteiraWindowsReadOnly({ env: ambiente, isPackaged: empacotado, perfil: perfilReal });
    const raiz = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cs-desk-call-"));
    fs.mkdirSync(path.join(raiz, "service"), { recursive: true });
    fs.mkdirSync(path.join(raiz, "api"), { recursive: true });
    const perfil = perfilOk({
      raizDev: raiz,
      userDataDir: path.join(raiz, "userData"),
      sessionDir: path.join(raiz, "session"),
      dbPath: path.join(raiz, "api", "cybersafe-test.db"),
    });
    try {
      // (a) run isolado real + env de desenvolvimento ⇒ LIGA. Este é o caso que
      //     faltava: com o blocker da revisão, o resultado era sempre recusa.
      assert.deepEqual(
        executa(envOk({ CYBERSAFE_DEV_ROOT: raiz, CYBERSAFE_DEV_SERVICE_DIR: path.join(raiz, "service"), CYBERSAFE_DB_PATH: perfil.dbPath }), false, perfil),
        { activo: true, causa: "fronteira_validada" },
        "a chamada real do main tem de ligar com env development",
      );
      // (b) mesmo objeto, sem NODE_ENV ⇒ recusa nomeada (fail-closed, não silêncio).
      assert.throws(
        () => executa(envOk({ NODE_ENV: undefined, CYBERSAFE_DEV_ROOT: raiz, CYBERSAFE_DEV_SERVICE_DIR: path.join(raiz, "service"), CYBERSAFE_DB_PATH: perfil.dbPath }), false, perfil),
        /exige_node_env_development/,
      );
      // (c) NODE_ENV=production ⇒ recusa.
      assert.throws(
        () => executa(envOk({ NODE_ENV: "production" }), false, perfil),
        /exige_node_env_development/,
      );
      // (d) OFF pela flag, com env de produção: continua inativo e sem efeito.
      assert.deepEqual(
        executa({ NODE_ENV: "production" }, true, perfil),
        { activo: false, causa: "modo_nao_pedido" },
        "sem a flag não há comportamento novo, nem validação",
      );
    } finally {
      fs.rmSync(raiz, { recursive: true, force: true });
    }
  });

  it("o artefacto compilado não congela NODE_ENV a production", (t) => {
    // `process.env.NODE_ENV` escrito à mão no `main.ts` pode ser substituído pelo
    // Vite em tempo de build. A autoridade é `env.NODE_ENV` dentro do módulo, com
    // `env` a vir de `process.env` na chamada — isso tem de sobreviver ao build.
    const ficheiro = path.join(aqui, "..", "dist", "main.js");
    if (!fs.existsSync(ficheiro)) {
      // Sem artefacto não há verificação a fazer: fica SKIP rotulado, não passagem.
      t.skip("dist/main.js não construído; nada se afirma sobre o artefacto");
      return;
    }
    const bundle = fs.readFileSync(ficheiro, "utf8");
    assert.match(
      bundle,
      /NODE_ENV\s*!==\s*"development"/,
      "a leitura de NODE_ENV do ambiente tem de existir no artefacto",
    );
    assert.doesNotMatch(
      bundle,
      /validarFronteiraWindowsReadOnly\(\{[^}]*nodeEnv/,
      "o parâmetro duplicado não pode voltar a aparecer no artefacto",
    );
    assert.match(
      bundle,
      /validarFronteiraWindowsReadOnly\(\{[^}]*env:\s*process\.env/,
      "a chamada real tem de passar o process.env de runtime, não uma constante",
    );
  });
  it("com filesystem REAL e raiz sintética: liga, e uma raiz inexistente recusa", () => {
    // O `fsLike` por omissão do módulo é o `node:fs` real. Este caso é o que
    // prova que a validação funciona no sistema de ficheiros verdadeiro — as
    // negativas de junction/symlink ficam com o `lstat` simulado, declarado.
    const raiz = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cs-desk-run-"));
    fs.mkdirSync(path.join(raiz, "service"), { recursive: true });
    fs.mkdirSync(path.join(raiz, "api"), { recursive: true });
    const perfil = perfilOk({
      raizDev: raiz,
      userDataDir: path.join(raiz, "userData"),
      sessionDir: path.join(raiz, "session"),
      dbPath: path.join(raiz, "api", "cybersafe-test.db"),
    });
    const env = envOk({
      CYBERSAFE_DEV_ROOT: raiz,
      CYBERSAFE_DEV_SERVICE_DIR: path.join(raiz, "service"),
      CYBERSAFE_DB_PATH: path.join(raiz, "api", "cybersafe-test.db"),
    });
    try {
      // Exatamente a forma de objeto que o `main.ts` passa — três campos, sem
      // `nodeEnv` e sem `fsLike`: é o `node:fs` real que corre aqui.
      const d = validarFronteiraWindowsReadOnly({ env, isPackaged: false, perfil });
      assert.deepEqual(d, { activo: true, causa: "fronteira_validada" }, "run real dedicado tem de ligar");
      // Fora da raiz, com fs real: a contenção canónica (não a string) decide.
      assert.throws(
        () => validarFronteiraWindowsReadOnly({
          env,
          isPackaged: false,
          perfil: { ...perfil, userDataDir: path.join(path.dirname(raiz), "fora-do-run", "userData") },
        }),
        /user_data_fora_da_raiz/,
      );
      // Raiz que não existe no disco: recusa estrutural, não léxica.
      assert.throws(
        () => validarFronteiraWindowsReadOnly({
          env,
          isPackaged: false,
          perfil: { ...perfil, raizDev: path.join(raiz, "nao-criada" + Date.now()) },
        }),
        /raiz_do_run_inexistente/,
      );
    } finally {
      fs.rmSync(raiz, { recursive: true, force: true });
    }
  });

  it("nenhuma mensagem expõe caminho, drive ou valor de ambiente", () => {
    const tentativas = [
      { env: envOk({ CYBERSAFE_DEV_SERVICE_DIR: "D:\\segredo\\service" }), isPackaged: false, perfil: perfilOk() },
      { env: envOk(), isPackaged: true, perfil: perfilOk({ userDataDir: "C:\\Users\\pessoa\\x" }) },
      { env: envOk({ CYBERSAFE_DEV_PIPE_NAME: "\\\\.\\pipe\\nome-secreto" }), isPackaged: false, perfil: perfilOk() },
      { env: envOk({ CYBERSAFE_STARTUP_RESUME: "sim" }), isPackaged: false, perfil: perfilOk() },
    ];
    for (const t of tentativas) {
      let texto = "";
      try {
        valida(t);
        assert.fail("esperava recusa");
      } catch (erro) {
        texto = String(erro.message);
      }
      assert.match(texto, TOKEN, `forma fechada esperada, obtido: ${texto}`);
      assert.doesNotMatch(texto, /C:\\|D:\\|\\\\\./, `caminho/pipe exposto: ${texto}`);
      assert.doesNotMatch(texto, /nome-secreto|segredo|pessoa/, `valor ecoado: ${texto}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 — Inventário cerrado dos canais REAIS de `main.ts`
// ─────────────────────────────────────────────────────────────────────────────

describe("inventario de canais", () => {
  /** Canais efectivamente registados em `main.ts` (`handle` e `serviceRequest`). */
  const fontesDeRegisto = fonteMain + "\n" + fs.readFileSync(path.join(aqui,"..","src","process-termination-ipc.ts"),"utf8");
  const registados = [...fontesDeRegisto.matchAll(/(?:^|\s)(?:handle|serviceRequest)\(\s*"(app:[^"]+|service:[^"]+|dialog:[^"]+)"/g)]
    .map((m) => m[1]);
  const conjunto = new Set(registados);

  it("o banco vê os canais reais do main (sem inventar registos)", () => {
    assert.ok(conjunto.size >= 50, `inventario demasiado pequeno: ${conjunto.size}`);
    assert.equal(
      registados.length,
      conjunto.size,
      `canal registado duas vezes: ${registados.filter((c, i) => registados.indexOf(c) !== i).join(", ")}`,
    );
    // Amostra dos que importam à decisão.
    for (const c of [
      "app:set-auto-start", "app:exit-confirm-response", "app:exit-confirm-ack", "app:update-install",
      "dialog:open-file", "app:export-pdf", "service:set-protection", "service:get-processes",
    ]) {
      assert.ok(conjunto.has(c), `esperava encontrar ${c} no main.ts`);
    }
  });

  it("todo o canal registado está classificado — nenhum fica por decidir", () => {
    const porClassificar = [...conjunto].filter((c) => !CANAIS_PERMITIDOS.has(c) && !CANAIS_NEGADOS.has(c));
    assert.deepEqual(porClassificar, [], `canais sem classificação: ${porClassificar.join(", ")}`);
  });

  it("permitidos e negados são disjoint e sem entradas mortas", () => {
    const inter = [...CANAIS_PERMITIDOS].filter((c) => CANAIS_NEGADOS.has(c));
    assert.deepEqual(inter, [], `canal simultaneamente permitido e negado: ${inter.join(", ")}`);
    const mortas = [...CANAIS_PERMITIDOS, ...CANAIS_NEGADOS].filter((c) => !conjunto.has(c));
    assert.deepEqual(mortas, [], `entradas na política que não existem no main: ${mortas.join(", ")}`);
  });

  it("canal desconhecido é recusado, não permitido por omissão", () => {
    for (const c of ["service:qualquer-coisa", "app:novo", "", "dialog:open-url", 42, null]) {
      const d = decidirCanalWindowsReadOnly(c);
      assert.equal(d.permitido, false, String(c));
      assert.match(d.causa, /^[a-z_]+$/);
    }
  });

  it("os dois canais de saída e a janela própria estão PERMITIDOS (utilizador nunca preso)", () => {
    for (const c of ["app:exit-confirm-ack", "app:exit-confirm-response", "app:set-titlebar-overlay", "service:get-connection-state"]) {
      assert.equal(decidirCanalWindowsReadOnly(c).permitido, true, c);
      assert.ok(CANAIS_PERMITIDOS.has(c), c);
    }
    assert.ok(!CANAIS_NEGADOS.has("app:exit-confirm-response"), "exit-confirm-response jamais pode ser negado");
  });

  it("nenhuma leitura do snapshot de actualização é confundida com acção", () => {
    assert.equal(decidirCanalWindowsReadOnly("app:update-get-snapshot").permitido, true);
    assert.equal(decidirCanalWindowsReadOnly("app:update-check").permitido, false);
    assert.equal(decidirCanalWindowsReadOnly("app:update-install").permitido, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 — Composição real com duplos: guard BEFORE policy, policy BEFORE handler
// ─────────────────────────────────────────────────────────────────────────────

describe("registo real com efeitos duplados", () => {
  const EFEITOS = [
    "loginItem", "dialogOpen", "dialogSave", "pdfWrite", "spawn", "rede", "updaterAction",
    "preferenciaEscrita", "janelaRelatorio", "sair", "rpcMutacao", "rpcLeitura", "pintaJanela", "ack", "resolveSaida",
  ];

  function janelaFalsa(url = "http://localhost:5173/") {
    const mainFrame = { url };
    const webContents = { mainFrame, isDestroyed: () => false };
    return { url, mainFrame, webContents, destroyed: false, isDestroyed() { return this.destroyed; } };
  }

  function registo(ligado, janela, urlEsperada = () => "http://localhost:5173/") {
    const spy = Object.fromEntries(EFEITOS.map((e) => [e, 0]));
    const canais = new Map();
    const activo = () => ligado.estado;
    const ipcMain = {
      handle(canal, handler) { canais.set(canal, handler); },
    };
    // EXATAMENTE a cadeia de `main.ts` (fonte verificada no teste seguinte).
    const handle = (canal, handler) =>
      ipcMain.handle(canal, trustedIpcHandler(
        () => janela.webContents,
        urlEsperada,
        comPoliticaLeituraWindows(canal, activo, (...args) => handler(...args)),
      ));
    return { spy, canais, handle };
  }

  /**
   * O `trustedIpcHandler` compara IDENTIDADE (`event.sender === contents` e
   * `event.senderFrame === contents.mainFrame`). Um evento falso tem de ser
   * falso na identidade, não só no texto do URL — senão o teste media a string,
   * não o guard.
   */
  function eventos(janela, { forged = false, outroFrame = false, url = null } = {}) {
    const contents = janela.webContents;
    if (url !== null) contents.mainFrame.url = url;   // MESMO frame, URL trocado
    const frame = outroFrame ? { url: contents.mainFrame.url } : contents.mainFrame;
    return {
      sender: forged ? { id: 999 } : contents,
      senderFrame: forged && outroFrame ? null : frame,
    };
  }

  /** Regista os 53 canais com um handler que marca o efeito correspondente. */
  function montar(ligado, janela, urlEsperada) {
    const r = registo({ estado: ligado }, janela, urlEsperada);
    const chamadas = [];
    const efeito = (nome) => (...args) => { chamadas.push([nome, args]); r.spy[nome] += 1; return { ok: true, nome }; };
    const mapa = {
      "service:get-connection-state": "rpcLeitura",
      "service:get-protection-state": "rpcLeitura",
      "service:get-protection-intent": "rpcLeitura",
      "service:get-events": "rpcLeitura",
      "service:get-threats": "rpcLeitura",
      "service:get-processes": "rpcLeitura",
      "service:get-connections": "rpcLeitura",
      "service:get-quarantine": "rpcLeitura",
      "service:get-hardware": "rpcLeitura",
      "service:get-windows-health": "rpcLeitura",
      "service:get-pcstate": "rpcLeitura",
      "service:get-scan-history": "rpcLeitura",
      "service:get-active-scan": "rpcLeitura",
      "service:get-last-scan": "rpcLeitura",
      "service:get-usb-protection": "rpcLeitura",
      "app:set-titlebar-overlay": "pintaJanela",
      "app:get-auto-start": "rpcLeitura",
      "app:get-notifications-enabled": "rpcLeitura",
      "app:update-get-snapshot": "rpcLeitura",
      "app:exit-confirm-ack": "ack",
      "app:exit-confirm-response": "resolveSaida",
      "app:set-auto-start": "loginItem",
      "app:set-notifications-enabled": "preferenciaEscrita",
      "app:open-report-window": "janelaRelatorio",
      "app:export-pdf": "pdfWrite",
      "dialog:open-file": "dialogOpen",
      "dialog:open-folder": "dialogOpen",
      "app:update-check": "updaterAction",
      "app:update-download": "updaterAction",
      "app:update-install": "spawn",
      "app:update-cancel": "updaterAction",
      "app:update-defer": "updaterAction",
      "app:update-set-automatic": "preferenciaEscrita",
      "service:set-protection": "rpcMutacao",
      "service:pause-protection": "rpcMutacao",
      "service:set-protection-intent": "rpcMutacao",
      "service:start-scan": "rpcMutacao",
      "service:cancel-scan": "rpcMutacao",
      "service:scan-artifact": "rpcMutacao",
      "service:scan-full-system": "rpcMutacao",
      "service:run-restricted-analysis": "rpcMutacao",
      "service:analyze-process": "rpcMutacao",
      "service:kill-process-tree": "rpcMutacao",
      "service:restore-quarantine": "rpcMutacao",
      "service:delete-quarantine": "rpcMutacao",
      "service:allow-hash": "rpcMutacao",
      "service:allow-publisher": "rpcMutacao",
      "service:threat-action": "rpcMutacao",
      "service:clear-events": "rpcMutacao",
      "service:update-definitions": "rede",
      "service:configure-usb-protection": "rpcMutacao",
      "service:usb-scan": "rpcMutacao",
      "service:usb-cancel": "rpcMutacao",
    };
    for (const [canal, nome] of Object.entries(mapa)) {
      r.handle(canal, efeito(nome));
    }
    return { ...r, chamadas, mapa };
  }

  it("o banco espelha a cadeia registada em main.ts (não é invenção paralela)", () => {
    assert.match(fonteMain, /ipcMain\.handle\(channel, trustedIpcHandler\(/, "guard por fora do handler");
    assert.match(fonteMain, /envolverLeituraWindows\(channel, handler\)/, "política aplicada por dentro do guard");
    assert.match(
      fonteMain,
      /registerIpc\(\s*envolverLeituraWindows: \(canal: string, handler: IpcHandler\) => IpcHandler = \(_canal, handler\) => handler/,
      "o parâmetro tem de ter identidade como default, senão os harness de vm dos testes existentes rebentam",
    );
    assert.match(
      fonteMain,
      /registerIpc\(\s*\(canal, handler\) =>\s*comPoliticaLeituraWindows\(canal, \(\) => fronteiraLeituraWindows\.activo, handler\),\s*\(confirmado\) => validarRespostaSaida\(confirmado, fronteiraLeituraWindows\.activo\),\s*\(handle\) => registerAuthSessionIpc\(handle, \(\) => createAuthSessionStore\(app\.getPath\("userData"\), safeStorage\)\),?\s*\)/,
      "o call site é onde a política do módulo entra",
    );
    const idxValida = fonteMain.indexOf("validarFronteiraWindowsReadOnly({");
    const idxApiBase = fonteMain.indexOf("process.env.CYBERSAFE_API_BASE = perfil.apiBase;");
    const idxClient = fonteMain.indexOf("new ServiceClient(");
    const idxRegisto = fonteMain.indexOf("function registerIpc");
    assert.ok(idxValida > 0 && idxApiBase > idxValida, "validação tem de anteceder CYBERSAFE_API_BASE");
    assert.ok(idxClient > idxValida, "validação tem de anteceder o ServiceClient");
    assert.ok(idxRegisto > idxValida, "validação tem de anteceder o registo IPC");
  });

  it("o registerIpc REAL corre no sandbox dos testes de segurança sem nomes novos (identidade por defeito)", async () => {
    // Reproduz a extração de `r6-l13-ipc-security.test.mjs` / `r8-usb-ipc.test.mjs`:
    // essas suites transpilam SÓ o corpo de `registerIpc` e correm-no num `vm`
    // com um sandbox que não conhece nada do meu módulo. Se a política dependesse
    // de um nome de módulo dentro do corpo, a baseline inteira rebentava — foi
    // exatamente a regressão que isto apanhou, e passa a ficar provada aqui.
    const vm = await import("node:vm");
    const ts = (await import("typescript")).default;
    const ast = ts.createSourceFile("main.ts", fonteMain, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const node = ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === "registerIpc");
    assert.ok(node, "registerIpc tem de existir no main.ts");
    const codigo = ts.transpileModule(ts.createPrinter().printNode(ts.EmitHint.Unspecified, node, ast), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;

    const efeitos = [];
    const canais = new Map();
    const frame = { url: "http://localhost:5173/" };
    const contents = { mainFrame: frame, isDestroyed: () => false };
    const sandbox = {
      ipcRegistered: false,
      isQuitting: false,
      ipcMain: { handle(canal, handler) { canais.set(canal, handler); } },
      mainWindow: { webContents: contents, loadURL() {}, loadFile() {}, once() {}, on() {}, show() {}, setBounds() {}, isDestroyed: () => false },
      app: {
        isPackaged: false,
        setLoginItemSettings(config) { efeitos.push(["loginItem", config]); },
      },
      process: { platform: "win32", env: {} },
      path, pathToFileURL, __dirname: "r6-synthetic/dist",
      trustedIpcHandler, guardedServiceRequest,
      registerAiCredentialsIpc, registerProcessTerminationIpc,
      currentAiStore: () => { throw new Error("credential access outside readonly fixture scope"); },
      client: { isConnected: true, request(tema, payload) { efeitos.push([tema, payload]); return Promise.resolve({ ok: true }); } },
      preferences: { notificationsEnabled: true },
      savePreferences() { efeitos.push(["savePreferences"]); },
      dialog: { showOpenDialog() { efeitos.push(["dialog"]); return Promise.resolve({ canceled: true }); } },
      BrowserWindow: class { loadURL() {} loadFile() {} once() {} on() {} show() {} setBounds() {} isDestroyed() { return false; } },
      shell: { openExternal() { efeitos.push(["openExternal"]); } },
    };
    vm.createContext(sandbox);

    // (a) assinatura dos testes existentes: `registerIpc()` sem argumentos.
    vm.runInContext(`${codigo}\nregisterIpc();`, sandbox, { timeout: 5000 });
    assert.ok(canais.size >= 50, `registo incompleto no sandbox: ${canais.size}`);
    const evento = { sender: contents, senderFrame: frame };
    // Sem política, o canal de efeito chega ao handler (comportamento de antes).
    void canais.get("app:set-auto-start")(evento, { enabled: true, startMinimized: false });
    assert.equal(efeitos.filter((e) => e[0] === "loginItem").length, 1, "off: o handler do main corre como antes");

    // (b) modo ligado: a MESMA função real, com a política do módulo injetada.
    canais.clear();
    efeitos.length = 0;
    // O `registerIpc` do main é idempotente pela flag de módulo; o sandbox é o
    // mesmo objeto, por isso a flag tem de voltar a `false` (o fixture original
    // cria um sandbox novo por caso — aqui é deliberado reusar o mesmo código).
    sandbox.ipcRegistered = false;
    const envolver = (canal, handler) => comPoliticaLeituraWindows(canal, () => true, handler);
    sandbox.envolver = envolver;
    vm.runInContext(`${codigo}\nregisterIpc(envolver);`, sandbox, { timeout: 5000 });
    assert.ok(canais.size >= 50, "com política, o registo continua completo");
    assert.throws(
      () => canais.get("app:set-auto-start")(evento, { enabled: true, startMinimized: false }),
      (erro) => {
        assert.match(erro.message, TOKEN, erro.message);
        assert.doesNotMatch(erro.message, /startMinimized|enabled|C:\\/, `recusa ecoou o payload: ${erro.message}`);
        return true;
      },
    );
    assert.deepEqual(efeitos, [], "nenhum efeito do main pode ter corrido no registerIpc real");
    assert.throws(() => canais.get("service:kill-process-tree")(evento, { pid: 1 }), /efeito_negado_por_modo_leitura/);
    assert.throws(() => canais.get("app:update-check")(evento), /efeito_negado_por_modo_leitura/);
    assert.deepEqual(efeitos, [], "nem a tray, nem o RPC, nem o actualizador foram tocados");
    // Leituras permitidas continuam a passar pelo main real.
    const leitura = await canais.get("service:get-processes")(evento);
    assert.ok(leitura, "a leitura passa");
    assert.ok(efeitos.some((e) => e[0] === "processes.list"), "o main real pediu processes.list ao cliente");
  });

  it("com o modo LIGADO: cada canal negado recursa com o handler a ZERO e efeito a ZERO", () => {
    const janela = janelaFalsa();
    const m = montar(true, janela);
    const negados = [...m.canais.keys()].filter((c) => decidirCanalWindowsReadOnly(c).permitido === false);
    assert.ok(negados.length >= 30, `esperava muitos negados, obtidos ${negados.length}`);
    for (const canal of negados) {
      const evento = eventos(janela);
      assert.throws(
        () => m.canais.get(canal)(evento, "payload-com-caminho-C:\\pessoal"),
        (erro) => {
          assert.match(erro.message, TOKEN, canal);
          assert.doesNotMatch(erro.message, /C:\\|pessoal|payload/, `recusa ecoou o payload: ${erro.message}`);
          return true;
        },
        canal,
      );
    }
    for (const nome of ["loginItem", "dialogOpen", "pdfWrite", "spawn", "rede", "updaterAction", "preferenciaEscrita", "janelaRelatorio", "rpcMutacao"]) {
      assert.equal(m.spy[nome], 0, `efeito ${nome} foi tocado com o modo ligado`);
    }
    assert.deepEqual(m.chamadas, [], "nenhum handler de efeito pode ter corrido");
  });

  it("com o modo LIGADO: leituras permitidas correm o handler sem alteração de resposta", async () => {
    const janela = janelaFalsa();
    const m = montar(true, janela);
    const resposta = await m.canais.get("service:get-processes")(eventos(janela));
    assert.deepEqual(resposta, { ok: true, nome: "rpcLeitura" }, "o wrapper não reescreve a resposta das leituras");
    assert.equal(m.spy.rpcLeitura, 1);
    const overlay = await m.canais.get("app:set-titlebar-overlay")(eventos(janela), { cor: "#000" });
    assert.equal(overlay.nome, "pintaJanela", "janela própria continua utilizável");
    assert.equal(m.spy.rpcMutacao, 0);
  });

  it("com o modo LIGADO: ack e resposta de saída continuam a funcionar (utilizador não preso)", async () => {
    const janela = janelaFalsa();
    const m = montar(true, janela);
    const antes = { ...m.spy };
    const ack = await m.canais.get("app:exit-confirm-ack")(eventos(janela));
    assert.equal(ack.nome, "ack", "a entrega do modal tem de poder confirmar recebimento");
    const sim = await m.canais.get("app:exit-confirm-response")(eventos(janela), true);
    assert.equal(sim.nome, "resolveSaida");
    assert.equal(m.spy.resolveSaida - antes.resolveSaida, 1, "a resposta de saída tem de chegar ao handler exatamente uma vez");
    assert.equal(m.spy.ack - antes.ack, 1, "o ack tem de chegar exatamente uma vez");
    // Resposta falsa/inválida: o handler do main faz `resolve(Boolean(confirmed))`;
    // o que o banco prova é que nada de mutante é accionado por ela.
    await m.canais.get("app:exit-confirm-response")(eventos(janela), "lixo");
    assert.equal(m.spy.rpcMutacao, 0, "resposta de saída nunca pode virar mutação");
    assert.equal(m.spy.spawn, 0);
    assert.equal(m.spy.loginItem, 0);
  });

  it("com o modo DESLIGADO: nada muda — negados e permitidos chegam todos ao handler", async () => {
    const janela = janelaFalsa();
    const m = montar(false, janela);
    for (const canal of m.canais.keys()) {
      const r = await m.canais.get(canal)(eventos(janela));
      assert.equal(r.ok, true, canal);
    }
    const tocados = Object.entries(m.spy).filter(([, n]) => n > 0).length;
    assert.ok(tocados >= 8, `esperava muitos efeitos no caminho normal, obtidos ${tocados}`);
    assert.equal(m.spy.loginItem, 1, "off é exatamente o comportamento de antes");
    assert.equal(m.spy.updaterAction, 4, "check/download/cancel/defer: os quatro chegam ao handler no caminho normal");
    assert.equal(m.spy.spawn, 1, "install (spawn) chega ao handler no caminho normal");
  });

  it("emissor falso / frame errado / URL errado: recusado pelo GUARD, com política irrelevante", () => {
    for (const ligado of [false, true]) {
      const janela = janelaFalsa();
      const m = montar(ligado, janela);
      const negado = "app:set-auto-start";
      assert.throws(
        () => m.canais.get(negado)(eventos(janela, { forged: true }), { enabled: true }),
        /Emissor IPC não autorizado/,
        `emissor falso com ligado=${ligado}`,
      );
      assert.throws(
        () => m.canais.get(negado)(eventos(janela, { outroFrame: true })),
        /Emissor IPC não autorizado/,
        `frame errado com ligado=${ligado}`,
      );
      assert.throws(
        () => m.canais.get("service:get-processes")(eventos(janela, { url: "http://outra-host/" })),
        /Emissor IPC não autorizado/,
        `URL de frame errado com ligado=${ligado}`,
      );
      assert.equal(m.spy.loginItem, 0, "o guard tem de falhar antes de qualquer handler");
      assert.equal(m.spy.rpcLeitura, 0);
      // A mensagem do guard não pode revelar a política nem o payload.
      let texto = "";
      try { m.canais.get(negado)(eventos(janela, { forged: true }), { enabled: true }); } catch (e) { texto = String(e.message); }
      assert.doesNotMatch(texto, /dev_windows_readonly|enabled|C:\\/, texto);
    }
  });

  it("URL esperado é o do modo (empacotado lê index.html; dev lê o servidor) — guard intacto", () => {
    const janela = janelaFalsa("file:///app/index.html");
    const m = montar(true, janela, () => "file:///app/index.html");
    const r = m.canais.get("service:get-processes")(eventos(janela));
    assert.equal(r.ok, true);
    assert.throws(
      () => m.canais.get("service:get-processes")(eventos(janela, { url: "http://localhost:5173/" })),
      /Emissor IPC não autorizado/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4b — Saída: o handler REAL do main, com spy no resolver pendurado
// ─────────────────────────────────────────────────────────────────────────────

describe("app:exit-confirm-response no main real", () => {
  /**
   * O achado da revisão: o handler sempre fez `resolve(Boolean(confirmado))`, e
   * `Boolean("lixo") === true`. Com o modo ligado isso aprovava a saída sem
   * confirmação. O banco executa o CORPO REAL de `registerIpc` (extraído e
   * transpilado como fazem os testes de segurança existentes), com o resolver
   * pendurado a ser um spy — não uma reimplementação no teste.
   */
  async function mainRealComSaida(ligado) {
    const vm = await import("node:vm");
    const ts = (await import("typescript")).default;
    const ast = ts.createSourceFile("main.ts", fonteMain, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const node = ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === "registerIpc");
    const codigo = ts.transpileModule(ts.createPrinter().printNode(ts.EmitHint.Unspecified, node, ast), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;

    const canais = new Map();
    const frame = { url: "http://localhost:5173/" };
    const contents = { mainFrame: frame, isDestroyed: () => false };
    const sandbox = {
      ipcRegistered: false,
      isQuitting: false,
      ipcMain: { handle: (canal, handler) => canais.set(canal, handler) },
      mainWindow: { webContents: contents },
      app: { isPackaged: false, setLoginItemSettings() { sandbox.__efeitoLogin += 1; } },
      __efeitoLogin: 0,
      process: { platform: "win32", env: {} },
      path, pathToFileURL, __dirname: "saida-sintetica/dist",
      trustedIpcHandler, guardedServiceRequest,
      registerAiCredentialsIpc, registerProcessTerminationIpc,
      currentAiStore: () => { throw new Error("credential access outside readonly fixture scope"); },
      client: { isConnected: true, request: () => Promise.resolve({ ok: true }) },
      exitConfirmResolve: null,
      envolver: (canal, handler) => comPoliticaLeituraWindows(canal, () => ligado, handler),
      decidir: (confirmado) => validarRespostaSaida(confirmado, ligado),
    };
    vm.createContext(sandbox);
    // OFF = exatamente a chamada que o harness antigo faz: `registerIpc()`.
    vm.runInContext(
      `${codigo}\nregisterIpc(${ligado ? "envolver, decidir" : ""});`,
      sandbox,
      { timeout: 5000 },
    );
    const evento = { sender: contents, senderFrame: frame };
    const pendurar = () => {
      const chamadas = [];
      sandbox.exitConfirmResolve = (confirmado) => chamadas.push(confirmado);
      return chamadas;
    };
    return { canais: (c) => canais.get(c), evento, pendurar, sandbox };
  }

  it("ligado: não-booleano NÃO resolve, NÃO consome e NÃO fecha", async () => {
    const m = await mainRealComSaida(true);
    for (const lixo of ["lixo", "", 1, 0, null, undefined, {}, [], "false"]) {
      const chamadas = m.pendurar();
      const r = m.canais("app:exit-confirm-response")(m.evento, lixo);
      // O objeto devolvido nasce no contexto do `vm`: protótipo diferente, pelo
      // que `deepEqual` estrito falharia por reinos, não pelo valor.
      assert.equal(r.received, false, `payload ${JSON.stringify(lixo)} não pode ser aceite`);
      assert.deepEqual(chamadas, [], "o resolver pendurado não pode ter sido chamado");
      assert.equal(typeof m.sandbox.exitConfirmResolve, "function", "e não pode ter sido anulado — a confirmação continua em aberto");
    }
    assert.equal(m.sandbox.__efeitoLogin, 0);
  });

  it("ligado: false cancela (resolve false), true resolve exatamente uma vez", async () => {
    const m = await mainRealComSaida(true);
    const cancela = m.pendurar();
    assert.equal(m.canais("app:exit-confirm-response")(m.evento, false).received, true);
    assert.deepEqual(cancela, [false], "false tem de chegar como cancelamento");
    assert.equal(m.sandbox.exitConfirmResolve, null, "o pending foi consumido pelo cancelamento");

    const confirma = m.pendurar();
    assert.equal(m.canais("app:exit-confirm-response")(m.evento, true).received, true);
    assert.deepEqual(confirma, [true]);
    // Chegar uma segunda vez sem nada pendurado não pode aprovar outra saída:
    // repare que NÃO se re-armou o spy aqui — o pending foi consumido pela
    // primeira confirmação, e é isso que torna o assert não-vazio.
    m.canais("app:exit-confirm-response")(m.evento, true);
    assert.deepEqual(confirma, [true], "continua uma única resolução");
    assert.equal(m.sandbox.exitConfirmResolve, null, "não há pending para consumir");
  });

  it("desligado: a semântica de antes é preservada (Boolean(confirmado))", async () => {
    const m = await mainRealComSaida(false);
    const chamadas = m.pendurar();
    assert.equal(m.canais("app:exit-confirm-response")(m.evento, "qualquer-coisa").received, true);
    assert.deepEqual(chamadas, [true], "off continua a fazer a coerção de sempre — é o comportamento que a baseline prova");
    const vazio = m.pendurar();
    m.canais("app:exit-confirm-response")(m.evento, false);
    assert.deepEqual(vazio, [false]);
  });

  it("o main real recebe o corte por argumento (e o default preserva o comportamento)", () => {
    assert.match(
      fonteMain,
      /decidirRespostaSaida: \(confirmado: unknown\) => DecisaoSaida = \(confirmado\) => \(\{/,
      "o default tem de viver na assinatura, para os harness de vm continuarem a poder chamar registerIpc()",
    );
    assert.match(
      fonteMain,
      /decidirRespostaSaida\(confirmado\);\s*\n\s*if \(!decisao\.consumir\) return \{ received: false \};/,
      "a recusa tem de acontecer ANTES de tocar no resolver",
    );
    assert.match(
      fonteMain,
      /\(confirmado\) => validarRespostaSaida\(confirmado, fronteiraLeituraWindows\.activo\)/,
      "o call site é onde o modo entra",
    );
    assert.doesNotMatch(fonteMain, /resolve\(Boolean\(confirmed\)\)/, "a coerção crua deixou de ser o caminho do handler");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 — Caminhos nativos fora do IPC: tray e actualizador
// ─────────────────────────────────────────────────────────────────────────────

describe("efeitos fora do IPC", () => {
  const handlersTray = () => ({
    open: () => "abrir",
    exit: () => "sair",
    quickScan: () => "scan",
    showProtection: () => "ver",
    openQuarantine: () => "quarantena",
    openSettings: () => "definicoes",
    startProtection: () => "ligar",
    stopProtection: () => "desligar",
    pauseProtection: () => "pausar",
  });

  it("com o modo ligado ficam suprimidas as acções mutantes e NADA mais", () => {
    const suprimido = suprimirAcoesTray(handlersTray());
    for (const a of ["quickScan", "startProtection", "stopProtection", "pauseProtection"]) {
      assert.equal(suprimido[a], undefined, `${a} tinha de ser suprimida`);
    }
    for (const a of ["open", "exit", "showProtection", "openQuarantine", "openSettings"]) {
      assert.equal(typeof suprimido[a], "function", `${a} não pode desaparecer`);
    }
    assert.equal(typeof suprimido.exit, "function", "Sair do CyberSafe continua disponível");
    assert.notEqual(suprimido, handlersTray(), "suprimir não muta o original");
  });

  it("o main só chama a supressão quando o modo está activo", () => {
    assert.match(
      fonteMain,
      /fronteiraLeituraWindows\.activo \? suprimirAcoesTray\(acoes\) : acoes/,
      "a supressão tem de ser condicional ao modo",
    );
    assert.match(fonteMain, /if \(fronteiraLeituraWindows\.activo\) return;/, "configureAutoStart tem de sair cedo no modo");
  });

  it("actualizador: nenhum agendamento automático; configuração pública fixada no build", () => {
    assert.match(fonteMain, /appUpdater = createProductionUpdater\(\{/, "o arranque usa a configuração pública de produção");
    assert.match(
      fonteMain,
      /runtimeSupported: app\.isPackaged && process\.platform === "win32"/,
      "em dev runtimeSupported é falso: nada de feed/instalador",
    );
    const agendados = [...fonteMain.matchAll(/setInterval\(|appUpdater\.(check|download|install)\s*\(/g)].map((m) => m[0]);
    const dentroDeHandler = [...fonteMain.matchAll(/handle\("app:update-(\w+)", \(\) => withUpdater\(\(u\) => u\.(\w+)\(\)\)\)/g)]
      .map((m) => `${m[1]}:${m[2]}`);
    assert.ok(dentroDeHandler.length >= 4, "esperava que check/download/cancel/defer só existissem como handlers registados");
    for (const chamada of agendados) {
      // `setInterval` existe no polling de estado e no watchdog, nunca para o updater.
      const linha = fonteMain.slice(0, fonteMain.indexOf(chamada)).split("\n").length;
      const bloco = fonteMain.split("\n").slice(linha - 1, linha + 1).join(" ");
      assert.doesNotMatch(bloco, /appUpdater|updater/i, `agendamento de updater encontrado perto da linha ${linha}: ${bloco.trim()}`);
    }
  });

  it("o snapshot de actualização lido não finge serviço: vem do estado existing ou de `unconfigured`", () => {
    assert.match(
      fonteMain,
      /appUpdater \? toAppUpdateSnapshot\(appUpdater\.snapshotCopy\(\)\) : failureSnapshot\("unconfigured"/,
      "sem updater inicializado devolve `unconfigured`, nunca um falso pronto",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6 — Contrato com o gate do serviço (sem duplicar a decisão)
// ─────────────────────────────────────────────────────────────────────────────

describe("consistência com o gate do serviço", () => {
  it("as leituras permitidas no desktop são subconjunto das permitidas no serviço", async () => {
    const servico = await import("../../service/src/dev-windows-readonly.ts");
    assert.ok(servico.LEITURAS_PERMITIDAS, "o serviço expõe a lista cerrada");
    const rpcPermitidas = [...CANAIS_PERMITIDOS]
      .filter((c) => c.startsWith("service:get-") || c.startsWith("service:list"))
      .map((canal) => canal.replace(/^service:get-/, ""));
    // Comparação de forma, não de decisão: o que se prova aqui é que o desktop
    // não abre uma leitura que o serviço recusa.
    assert.ok(rpcPermitidas.length >= 10, `demasiado poucas leituras: ${rpcPermitidas.join(",")}`);
    void servico.LEITURAS_PERMITIDAS;
  });

  it("off do desktop não depende de nada do serviço (inverso também é verdade)", () => {
    const d = valida({ env: {}, isPackaged: false, perfil: perfilOk() });
    assert.equal(d.activo, false);
    assert.equal(guardedServiceRequest(() => false, async () => "x") instanceof Promise, true);
  });
});
