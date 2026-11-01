/**
 * TP-DEV-BOOT-ISOLATION-20261023 — contrato de arranque do runner isolado.
 *
 * Porque este ficheiro existe além dos testes herdados do baseline publicado: o
 * runner RECUPERADO em U (sha e62cd88c) trouxe três perdas que o `start-windows-
 * readonly.mjs` externo detetou com `plano_incoerente_com_o_preflight`:
 *   1. `API_PORT_REQUIRED = 4000` — a porta da instalação pessoal. O desktop
 *      levava o renderer para o piso dev (4100) e a UI nunca falava com a API;
 *   2. `validarRaizReutilizavel` desapareceu do módulo, e o wrapper chama-o;
 *   3. a raiz imposta (`CYBERSAFE_DEV_RUN_ROOT`) era ignorada: o plano devolvia
 *      sempre uma raiz `mkdtemp` própria, logo `plano.root !== raiz` do wrapper.
 *
 * Nada aqui toca o SO de verdade: `deps` são espiões. Um teste que pedisse
 * `mkdtemp`/`mkdir`/`spawn` fora do permitido falha por contagem, não por sorte.
 * Sem portas reais, sem GUI, sem serviço, sem rede.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const modulo = await import("./dev-isolated-run.mjs");
const { buildPlan, run, cleanupAsync } = modulo;

const ELEtron_BIN = path.join("C:", "fake", "electron.exe");
const NPM_CLI = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");

/**
 * Espião central: conta TODA a interação com o mundo.
 *
 * O relógio é FALSO e `sleep` avança-o: sem isto, um teste que sem querer caia no
 * caminho de lançamento entra num ciclo de prontidão com `await` instantâneo e
 * esgota o heap (reproduzido: OOM aos 4 GB em ~28 s). Com relógio controlado o
 * ciclo termina em `orçamento/500` iterações — falha ruidosa em milissegundos,
 * nunca espera infinita. Nenhum teste daqui abre GUI, serviço, pipe ou porta.
 */
function criarDeps(overrides = {}) {
  const chamadas = { mkdtemp: 0, mkdir: 0, write: 0, rm: [], spawn: 0, spawnSync: 0, tcp: [], pipe: [], http: [], tempo: 0 };
  const bases = {
    execPath: process.execPath,
    pid: 4242,
    tmpdir: () => "C:\\Temp",
    homedir: () => "C:\\Users\\caioc",
    mkdtempSync: (p) => { chamadas.mkdtemp++; return path.join(p, "RRANDOM"); },
    mkdirSync: (p) => { chamadas.mkdir++; },
    existsSync: () => true,
    readFileSync: () => "",
    writeFileSync: (p) => { chamadas.write++; },
    rmSync: (p) => { chamadas.rm.push(p); },
    realpathSync: (p) => p,
    isAlive: () => false,
    spawnSync: () => { chamadas.spawnSync++; return { status: 0, stdout: "" }; },
    spawn: () => { chamadas.spawn++; return { pid: 999, once: () => {}, stdio: {} }; },
    requireElectron: () => ELEtron_BIN,
    probeTcp: async (h, p) => { chamadas.tcp.push(`${h}:${p}`); return false; },
    probePipe: async (p) => { chamadas.pipe.push(p); return false; },
    probeHttp: async (u) => { chamadas.http.push(u); return null; },
    killTree: async () => ({ ok: true, code: 0 }),
    now: () => chamadas.tempo,
    readinessDelayMs: 500,
    sleep: async (ms) => { chamadas.tempo += Math.max(1, Number(ms) || 500); },
    installSignalHandlers: () => ({ promise: new Promise(() => {}), dispose: () => {} }),
    log: () => {},
    ...overrides,
  };
  return { deps: bases, chamadas };
}

const ENV_BASE = { PATH: "x", NODE_ENV: "development", CYBERSAFE_DEV_ISOLATION: "1" };
const BASE_ENV = ENV_BASE;

/** Raiz candidata do wrapper: dentro de %TEMP%, dedicada, já criada. */
const raizWrapper = (deps) => path.join(deps.tmpdir(), "cs-ro-run-AAAA");
const comRaizImposta = (env, deps) => ({ ...env, CYBERSAFE_DEV_RUN_ROOT: raizImposta(deps) });
const raizImposta = (deps) => path.join(deps.tmpdir(), "cs-ro-run-BBBB");

describe("porta do dev isolado — fail-closed a partir do piso 4100, sem 4000", () => {
  it("configuração por omissão usa 4100, não a porta da instalação pessoal", () => {
    const { deps } = criarDeps();
    const plano = buildPlan({ env: BASE_ENV, dryRun: true, deps });
    assert.equal(plano.apiPort, 4100, "4000 é a porta da instalação pessoal: o dev isolado não a pode usar");
    assert.equal(plano.isolationEnv.CYBERSAFE_API_PORT, "4100");
    assert.equal(plano.isolationEnv.CYBERSAFE_DEV_PORT, "4100",
      "o desktop lê CYBERSAFE_DEV_PORT; sem ele caía no piso e injectava 4100 no renderer contra uma API em 4000");
    assert.equal(plano.portValid, true);
  });

  it("4310 é válida e é a porta que vai para o env de TODOS os filhos", () => {
    const { deps } = criarDeps();
    const plano = buildPlan({ env: { ...BASE_ENV, CYBERSAFE_API_PORT: "4310" }, dryRun: true, deps });
    assert.equal(plano.portValid, true);
    assert.equal(plano.apiPort, 4310);
    const passos = [...plano.steps.spawn, plano.steps.desktopBuild, plano.preflight];
    for (const p of passos) {
      assert.equal(p.env.CYBERSAFE_API_PORT, "4310", `${p.name} ficou com outra porta`);
      assert.equal(p.env.CYBERSAFE_DEV_PORT, "4310", `${p.name} não recebeu a porta pedida`);
    }
  });

  it("4000 e valores abaixo do piso são RECUSADOS antes de qualquer IO", async () => {
    for (const bruto of ["4000", "1", "4099", "abc", "0", "65536"]) {
      const { deps, chamadas } = criarDeps();
      const r = await run({ argv: ["--start"], env: { ...BASE_ENV, CYBERSAFE_API_PORT: bruto }, deps });
      assert.ok(r.blocked, `porta "${bruto}" tinha de ser recusada`);
      assert.match(r.blocked, /port-/, `motivo inesperado para "${bruto}": ${r.blocked}`);
      assert.equal(chamadas.mkdtemp, 0, `criou raiz antes de recusar "${bruto}"`);
      assert.equal(chamadas.mkdir, 0, `mkdir antes de recusar "${bruto}"`);
      assert.equal(chamadas.spawn, 0, `spawn antes de recusar "${bruto}"`);
      assert.equal(chamadas.spawnSync, 0, `spawnSync antes de recusar "${bruto}"`);
      assert.equal(chamadas.write, 0, `escrita antes de recusar "${bruto}"`);
    }
  });

  it("o runner recusa 4000 MESMO onde o gate do API a deixaria passar", () => {
    // `packages/api/src/dev-isolation.ts:203` isenta a porta de produção
    // (`porta !== PRODUCTION_API_PORT`), logo só o runner segura o piso. Testar o
    // runner por tabela do API seria o falso verde que abriu esta missão.
    const { deps } = criarDeps();
    const plano = buildPlan({ env: { ...BASE_ENV, CYBERSAFE_API_PORT: "4000" }, dryRun: true, deps });
    assert.equal(plano.portValid, true, "4000 é um número de porta legítimo");
    assert.equal(plano.portSupported, false, "…mas não é porta de dev isolado");
  });

  it("chave presente mas vazia vale como omissão e cai no piso — nunca em 4000", () => {
    // Os consumidores tratam-na assim (`desktop:157` e `api:163` usam
    // `env.CYBERSAFE_API_PORT ? …`); reescrever a semântica só no runner criaria
    // um terceiro comportamento para a mesma string. O que tem de ser invariante é
    // o destino: o piso dev, nunca a porta da instalação pessoal.
    const { deps } = criarDeps();
    const plano = buildPlan({ env: { ...BASE_ENV, CYBERSAFE_API_PORT: "" }, dryRun: true, deps });
    assert.equal(plano.apiPort, 4100);
    assert.equal(plano.isolationEnv.CYBERSAFE_API_PORT, "4100", "o env dos filhos nunca pode ficar vazio");
    assert.equal(plano.portSupported, true);
  });
});

describe("raiz imposta pelo harness — validada antes de mkdir/SQLite/spawn", () => {
  it("CYBERSAFE_DEV_RUN_ROOT é a raiz do plano; nenhuma raiz nova é criada", () => {
    const { deps, chamadas } = criarDeps();
    const raiz = raizImposta(deps);
    const plano = buildPlan({ env: { ...BASE_ENV, CYBERSAFE_DEV_RUN_ROOT: raiz }, dryRun: true, deps });
    assert.ok(!plano.blocked, `raiz válida recusada: ${plano.blocked}`);
    assert.equal(plano.root, raiz, "o wrapper exige plano.root === raiz dele");
    assert.equal(chamadas.mkdtemp, 0, "raiz imposta não pode gerar mkdtemp");
    assert.equal(plano.isolationEnv.CYBERSAFE_DEV_ROOT, raiz);
    for (const alvo of [plano.serviceDir, plano.apiDbPath, plano.userDataDir, plano.sessionDataDir]) {
      assert.ok(alvo.toLowerCase().startsWith(raiz.toLowerCase()), `fora da raiz: ${alvo}`);
    }
    assert.ok(plano.isolationEnv.CYBERSAFE_DEV_SESSION_DATA_DIR, "a sessão tem de ser dedicada e declarada");
  });

  it("raiz fora de %TEMP% bloqueia com ZERO interação e sem spawn", async () => {
    const { deps, chamadas } = criarDeps();
    const r = await run({ argv: ["--start"], env: { ...BASE_ENV, CYBERSAFE_DEV_RUN_ROOT: "C:\\Users\\caioc\\outra-coisa" }, deps });
    assert.ok(r.blocked, "raiz fora da base temporária tinha de bloquear");
    assert.match(r.blocked, /run-root-invalida/);
    assert.equal(chamadas.mkdir + chamadas.mkdtemp + chamadas.spawn + chamadas.spawnSync + chamadas.write, 0,
      `houve IO/spawn antes da recusa: ${JSON.stringify(chamadas)}`);
  });

  it("raiz = %TEMP% em geral é recusada (não é uma raiz dedicada)", () => {
    const { deps } = criarDeps();
    assert.equal(typeof modulo.validarRaizReutilizavel, "function",
      "o wrapper chama runner.validarRaizReutilizavel(); sem ela a tentativa morre em TypeError");
    const r = modulo.validarRaizReutilizavel("C:\\Temp", deps, {});
    assert.equal(r.ok, false);
    assert.match(r.motivo, /base temporária|dedicada/);
  });

  it("o validador do runner recusa junction, caminho inexistente, diretório pessoal e dono vivo", () => {
    const { deps } = criarDeps({
      // A inexistência é detetada pelo `realpathSync` a lançar (runner:78), NÃO pelo
      // `existsSync` — esse só é chamado no manifesto, já dentro de uma raiz válida.
      // Espiar o hook errado é o género de teste que passa contra um validador partido.
      realpathSync: (p) => {
        if (p.toLowerCase().includes("junction")) return "C:\\Temp\\alvo-real";
        if (p.toLowerCase().includes("nao-existe")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return p;
      },
    });
    const rJunction = modulo.validarRaizReutilizavel(path.join("C:\\Temp", "junction"), deps, {});
    assert.equal(rJunction.ok, false);
    assert.match(rJunction.motivo, /reparse/);
    const rInexistente = modulo.validarRaizReutilizavel(path.join("C:\\Temp", "nao-existe"), deps, {});
    assert.equal(rInexistente.ok, false);
    assert.equal(rInexistente.motivo, "não existe");
    const rPessoal = modulo.validarRaizReutilizavel("C:\\Users\\caioc", deps, {});
    assert.equal(rPessoal.ok, false);
    assert.match(rPessoal.motivo, /diretório pessoal|fora da base temporária/,
      "tem de recusar, e nomear a fronteira violada");
    // O `%TEMP%` real fica POR DEBAIXO do diretório pessoal, por isso a igualdade com
    // `homedir()` é quase sempre inalcançável — o que importa provar é que o caminho
    // do serviço instalado é recusado quando uma base temporária larga o allows.
    const baseLarga = criarDeps({ tmpdir: () => "C:\\", homedir: () => "C:\\Users\\caioc" });
    const rServico = modulo.validarRaizReutilizavel("C:\\Users\\caioc\\.cybersafe-service", baseLarga.deps, {});
    assert.equal(rServico.ok, false);
    assert.match(rServico.motivo, /serviço instalado|diretório pessoal/);
    assert.equal(modulo.validarRaizReutilizavel("relativa", deps, {}).ok, false);
    const comDonoVivo = criarDeps({
      isAlive: () => true,
      readFileSync: () => JSON.stringify({ pid: 777 }),
    });
    const r = modulo.validarRaizReutilizavel(path.join("C:\\Temp", "raiz-alheia"), comDonoVivo.deps, {});
    assert.equal(r.ok, false);
    assert.match(r.motivo, /outro run vivo|777/);
  });

  it("dry-run do harness não escreve nem cria (os espiões do wrapper rebentariam)", () => {
    const explosivos = {
      mkdtempSync: () => { throw new Error("dry-run criou raiz"); },
      mkdirSync: () => { throw new Error("dry-run criou diretório"); },
      writeFileSync: () => { throw new Error("dry-run escreveu ficheiro"); },
      spawn: () => { throw new Error("dry-run deu spawn"); },
      spawnSync: () => { throw new Error("dry-run deu spawnSync"); },
    };
    const { deps } = criarDeps(explosivos);
    const plano = buildPlan({ env: comRaizImposta(BASE_ENV, deps), dryRun: true, deps });
    assert.ok(!plano.blocked);
    assert.equal(plano.root, raizImposta(deps));
  });
});

describe("filhos herdam o plano; porta ocupada bloqueia; cleanup só da árvore própria", () => {
  it("pipe, DB, userData, sessão e strictPort chegam a quem é lançado", () => {
    const { deps } = criarDeps();
    const plano = buildPlan({ env: comRaizImposta(BASE_ENV, deps), dryRun: true, deps });
    const porNome = Object.fromEntries(plano.steps.spawn.map((s) => [s.name, s]));
    for (const nome of ["service", "api", "app", "desktop"]) {
      const passo = porNome[nome];
      assert.ok(passo, `falta o passo ${nome}`);
      assert.equal(passo.env.CYBERSAFE_DEV_PIPE_NAME, plano.pipeName);
      assert.equal(passo.env.CYBERSAFE_DEV_ROOT, plano.root);
      assert.equal(passo.env.CYBERSAFE_DB_PATH, plano.apiDbPath);
      assert.equal(passo.env.CYBERSAFE_DEV_USER_DATA_DIR, plano.userDataDir);
    }
    assert.ok(porNome.app.args.includes("--strictPort"), "o Vite não pode cair para 5174 em silêncio");
    assert.ok(porNome.desktop.args.some((a) => a.startsWith("--user-data-dir=")), "Electron com userData dedicado");
    assert.equal(plano.addedKeys.includes("CYBERSAFE_DEV_ROOT"), true, "o plano tem de descrever o que acrescenta");
  });

  it("API com porta ocupada → bloqueio, nenhum filho lançado", async () => {
    const { deps, chamadas } = criarDeps({ probeTcp: async (h, p) => p === 4100 });
    const r = await run({ argv: ["--start"], env: BASE_ENV, deps });
    assert.equal(r.blocked, "port-busy:127.0.0.1:4100");
    assert.equal(chamadas.spawn, 0);
  });

  it("cleanup: apaga apenas a raiz própria, e nunca sem prova de morte", async () => {
    const { deps, chamadas } = criarDeps();
    const plano = buildPlan({ env: comRaizImposta(BASE_ENV, deps), dryRun: false, deps });
    const morto = { name: "api", pid: 11, exited: Promise.resolve({ kind: "exit", code: 0 }) };
    const optado = { name: "app", pid: 12, exited: new Promise(() => {}) };

    await cleanupAsync(plano, [morto], deps, () => {}, { removeRoot: true });
    assert.deepEqual(chamadas.rm, [plano.root], "só a raiz desta corrida pode ser apagada");

    chamadas.rm.length = 0;
    const r2 = await cleanupAsync({ ...plano, root: plano.root }, [morto, optado], deps, () => {}, { removeRoot: true });
    assert.equal(r2.status, "FAIL");
    assert.deepEqual(chamadas.rm, [], "filho sem prova de morte → raiz preservada, nada apagado");
  });

  it("o preflight do repo recebe o ambiente EXACTO do plano e o veredito manda", async () => {
    const vistos = [];
    const { deps, chamadas } = criarDeps({
      spawnSync: (cmd, args, opts) => {
        if (String(args[0] || "").includes("dev-isolated-preflight")) { vistos.push({ env: opts.env, cmd, args, cwd: opts.cwd }); return { status: 1, stdout: "BLOCK teste" }; }
        chamadas.spawnSync++;
        return { status: 0, stdout: "" };
      },
    });
    const r = await run({ argv: ["--start"], env: { ...BASE_ENV, CYBERSAFE_API_PORT: "4310" }, deps });
    assert.equal(vistos.length, 1, "o gate do repo tem de ser chamado uma vez, antes de qualquer filho");
    const envVisto = vistos[0].env;
    assert.equal(envVisto.CYBERSAFE_API_PORT, "4310");
    assert.equal(envVisto.CYBERSAFE_DEV_PORT, "4310");
    assert.equal(envVisto.CYBERSAFE_DEV_PIPE_NAME.startsWith("\\\\.\\pipe\\"), true);
    assert.equal(envVisto.CYBERSAFE_DEV_ISOLATION, "1");
    assert.equal(chamadas.spawn, 0, "preflight !== 0 não pode ser ignorado");
    assert.equal(r.blocked, "preflight");
    assert.deepEqual(chamadas.rm, [r.plan.root], "raiz vazia desta corrida é apagada quando o gate recusa");
  });

  it("veredito 0 no gate e falha no build: ainda zero spawn, blocked=desktop-build", async () => {
    const ehPreflight = (args) => (args || []).some((a) => String(a).includes("dev-isolated-preflight"));
    const { deps, chamadas } = criarDeps({
      spawnSync: (cmd, args) => (ehPreflight(args) ? { status: 0, stdout: "" } : { status: 1, stdout: "" }),
    });
    const r = await run({ argv: ["--start"], env: BASE_ENV, deps });
    assert.equal(r.blocked, "desktop-build", `ordem dos gates partida: ${r.blocked}`);
    assert.equal(chamadas.spawn, 0, "nenhum filho antes do build do desktop passar");
  });
});

describe("contrato com o wrapper externo (start-windows-readonly)", () => {
  it("o predicado de coerência do wrapper passa com o plano por omissão", () => {
    const { deps } = criarDeps();
    const raiz = raizWrapper(deps);
    const pipeNome = "\\\\.\\pipe\\cybersafe-ro-1234-abc";
    const portaCdp = 9333;
    const plano = buildPlan({
      env: { ...BASE_ENV, CYBERSAFE_DEV_RUN_ROOT: raiz, CYBERSAFE_DEV_PIPE_NAME: pipeNome, CYBERSAFE_DEV_DEBUG_PORT: String(portaCdp) },
      dryRun: true,
      deps,
    });
    assert.ok(!plano.blocked, `plano bloqueado: ${plano.blocked}`);
    // Cópia literal do predicado em copia-runner/start-windows-readonly.mjs:512-514.
    const coerente = plano.root === raiz && plano.pipeName === pipeNome
      && plano.apiPort === 4100 && plano.rendererPort === 5173 && plano.debugPort === portaCdp
      && !plano.personalTouched && !plano.electron?.error && !!plano.npmCli;
    assert.equal(coerente, true, `plano_incoerente_com_o_preflight: ${JSON.stringify({
      root: plano.root === raiz, apiPort: plano.apiPort, renderer: plano.rendererPort, cdp: plano.debugPort,
      pipe: plano.pipeName === pipeNome, pessoal: plano.personalTouched, electron: plano.electron, npm: !!plano.npmCli,
    })}`);
  });

  it("o wrapper é lido de facto: as chaves que ele exige existem no plano", (t) => {
    const { deps } = criarDeps();
    const plano = buildPlan({ env: comRaizImposta(BASE_ENV, deps), dryRun: true, deps });
    // Lista CONGELADA a partir da cópia em `copia-runner/` no dia 23/10 (sha do
    // excerto em PREPOST). Serve de contratante quando o patch aterrar em U, onde
    // essa cópia não existe: sem ela este teste simplesmente desapareceria do repo.
    const EXIGIDAS = ["apiDbPath", "apiPort", "blocked", "debugPort", "electron", "isolationEnv",
      "npmCli", "personalTouched", "pipeName", "rendererPort", "root", "serviceDir", "userDataDir"];
    for (const chave of EXIGIDAS) {
      // `blocked` só aparece num plano RECUSADO — é assim que o runner se descreve.
      // O que o wrapper precisa de saber é que um plano bom lê falsy, não undefined.
      if (chave === "blocked") { assert.ok(!plano.blocked, `plano válido veio bloqueado: ${plano.blocked}`); continue; }
      assert.ok(chave in plano, `o wrapper lê plano.${chave} e o plano não tem essa chave`);
    }
    assert.equal(typeof modulo.validarRaizReutilizavel, "function",
      "runner.validarRaizReutilizavel() é chamado pelo wrapper; sem ela a tentativa morre em TypeError");

    const URL_WRAPPER = new URL("../../copia-runner/start-windows-readonly.mjs", import.meta.url);
    if (!fs.existsSync(URL_WRAPPER)) {
      t.diagnostic("cópia do wrapper ausente deste checkout — verificadas apenas as chaves congeladas.");
      return;
    }
    const textoWrapper = fs.readFileSync(URL_WRAPPER, "utf8");
    const dinamicas = [...new Set([...textoWrapper.matchAll(/plano\.([A-Za-z]+)/g)].map((m) => m[1]))]
      .filter((c) => c && c !== "undefined").sort();
    assert.deepEqual(dinamicas, [...EXIGIDAS].sort(),
      "o wrapper passou a ler outra chave — atualizar a lista congelada E o runner em conjunto");
    assert.equal(textoWrapper.includes("runner.validarRaizReutilizavel("), true, "referência do wrapper mudou?");
  });
});

/**
 * O plano a chegar ao CONSUMIDOR REAL, sem espiões.
 *
 * Porque isto não é redundante com os testes de spy: os spies provam que o runner
 * DESCREVE um ambiente; só os módulos verdadeiros do desktop e do API provam que
 * esse ambiente É lido como o runner julga. Foi exatamente este fosso que atirou
 * o renderer para 4100 contra uma API em 4000, e é o `perfilBatePlano` do wrapper
 * que apanha a recaída. Raiz REAL dentro de %TEMP%, criada e apagada por este
 * teste; nenhuma porta, pipe ou GUI aberta.
 */
describe("consumidores reais do ambiente do plano (dev-isolation do desktop e do API)", () => {
  const depsReais = {
    execPath: process.execPath,
    pid: process.pid,
    tmpdir: () => os.tmpdir(),
    homedir: () => os.homedir(),
    mkdtempSync: (p) => fs.mkdtempSync(p),
    mkdirSync: (p) => fs.mkdirSync(p, { recursive: true }),
    existsSync: (p) => fs.existsSync(p),
    readFileSync: (p, o) => fs.readFileSync(p, o),
    writeFileSync: () => {},
    rmSync: (p, o) => fs.rmSync(p, o),
    realpathSync: (p) => fs.realpathSync(p),
    isAlive: () => false,
    spawnSync: () => ({ status: 0, stdout: "" }),
    spawn: () => ({ pid: 1 }),
    requireElectron: () => "C:\\fake\\electron.exe",
    probeTcp: async () => false, probePipe: async () => false, probeHttp: async () => null,
    log: () => {},
  };

  /** Raiz dedicada real; o teste paga-a no `t.after`. */
  function raizReal(t) {
    const criada = fs.mkdtempSync(path.join(os.tmpdir(), "cs-boot-contract-"));
    const real = fs.realpathSync(criada);
    t.after(() => { fs.rmSync(real, { recursive: true, force: true }); });
    return real;
  }

  async function importarRelativo(t, rel) {
    try {
      return await import(new URL(rel, import.meta.url).href);
    } catch (erro) {
      // Sem type-stripping (Node < 23.6) os `.ts` não abrem; dizer isso é melhor do
      // que validar o contrato contra um duplicado meu do fonte.
      t.diagnostic(`módulo real indisponível neste runtime (${rel}): ${String(erro.message).slice(0, 100)}`);
      return null;
    }
  }

  it("o perfil do desktop bate com o plano: pipe, userData, session, DB e porta", async (t) => {
    const devIso = await importarRelativo(t, "../packages/desktop/src/dev-isolation.ts");
    if (!devIso) return;
    const raiz = raizReal(t);
    for (const porta of [undefined, "4310"]) {
      const plano = buildPlan({
        env: { ...BASE_ENV, CYBERSAFE_DEV_RUN_ROOT: raiz, ...(porta ? { CYBERSAFE_API_PORT: porta } : {}) },
        dryRun: true, deps: depsReais,
      });
      assert.ok(!plano.blocked, `plano recusado: ${plano.blocked}`);
      const perfil = devIso.resolveDevProfile({ isPackaged: false, env: plano.isolationEnv });
      const esperada = porta ? Number(porta) : 4100;
      assert.equal(perfil.apiPort, plano.apiPort, `desktop em ${perfil.apiPort}, plano em ${plano.apiPort} (${esperada})`);
      assert.equal(perfil.apiPort, esperada);
      assert.equal(perfil.pipeName, plano.pipeName, "pipe do desktop diferente do pipe do serviço = ENOENT eterno");
      assert.equal(path.resolve(perfil.userDataDir), path.resolve(plano.userDataDir));
      assert.equal(path.resolve(perfil.sessionDir), path.resolve(plano.sessionDataDir),
        "sessão partilhada entre corridas é o leveldb de uma a aparecer como restauro na outra");
      assert.equal(path.resolve(perfil.dbPath), path.resolve(plano.apiDbPath));
      assert.equal(perfil.raizDev, plano.root);
    }
  });

  it("o gate do API aceita o plano e devolve a MESMA porta", async (t) => {
    const apiIso = await importarRelativo(t, "../packages/api/src/dev-isolation.ts");
    if (!apiIso || typeof apiIso.validarArranqueApi !== "function") { t.diagnostic("validarArranqueApi não exportado"); return; }
    const raiz = raizReal(t);
    for (const porta of [undefined, "4310"]) {
      const plano = buildPlan({
        env: { ...BASE_ENV, CYBERSAFE_DEV_RUN_ROOT: raiz, ...(porta ? { CYBERSAFE_API_PORT: porta } : {}) },
        dryRun: false, deps: depsReais,
      });
      assert.ok(!plano.blocked, `plano recusado: ${plano.blocked}`);
      for (const d of plano.dirsToCreate) fs.mkdirSync(d, { recursive: true });
      const r = apiIso.validarArranqueApi({ entrypoint: fileURLToPath(new URL("../packages/api/src/index.ts", import.meta.url)), env: plano.isolationEnv });
      assert.equal(r.modo, "dev", `o gate não viu isto como dev: ${JSON.stringify(r)}`);
      assert.equal(r.porta, plano.apiPort, `API em ${r.porta}, plano em ${plano.apiPort}`);
      assert.equal(path.resolve(r.dbPath), path.resolve(plano.apiDbPath));
    }
  });

  it("a porta 4000 é recusada nas duas camadas: runner e gate do API", async (t) => {
    /* Este caso afirmava o oposto — que o gate do API ACEITARIA 4000 («tem a
       recusa comentada») e e que o piso teria de ser seguro apenas pelo runner. Não era
       uma premissa inventada: estava certa na altura. `3a95692` (2026-10-30)
       acrescentou a recusa ao gate (`packages/api/src/dev-isolation.ts:201`), e
       como NENHUM script do `package.json` corria este ficheiro, a asserção
       envelheceu sem ninguém a ver — é exatamente o custo de uma suite fora do
       comando padrão. O invariante agora dito é o mais forte dos dois: recusam
       as duas camadas, cada uma por si. */
    const apiIso = await importarRelativo(t, "../packages/api/src/dev-isolation.ts");
    if (!apiIso) return;
    const raiz = raizReal(t);
    const plano = buildPlan({ env: { ...BASE_ENV, CYBERSAFE_DEV_RUN_ROOT: raiz, CYBERSAFE_API_PORT: "4000" }, dryRun: true, deps: depsReais });
    assert.equal(plano.portSupported, false, "o runner tem de marcar 4000 como não suportada");
    for (const d of plano.dirsToCreate ?? []) fs.mkdirSync(d, { recursive: true });
    assert.throws(
      () => apiIso.validarArranqueApi({ entrypoint: fileURLToPath(new URL("../packages/api/src/index.ts", import.meta.url)), env: plano.isolationEnv }),
      (erro) => erro.code === "CYBERSAFE_ISOLAMENTO_RECUSADO" && /4000/.test(erro.message),
      "o gate tem de recusar 4000 por si, não por herança do runner",
    );
  });
});
