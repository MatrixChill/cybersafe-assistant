import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regressão do arranque (P0 de 11/10/2026).
 *
 * O humano viu DUAS camadas de carregamento sobrepostas no executável: a janela
 * splash do Electron (sempre por cima, `alwaysOnTop`) e o BootScreen do renderer,
 * revelado independentemente ao `ready-to-show`. O splash fechava só depois de
 * o serviço responder; o BootScreen tinha um teto próprio. Uma desaparecia e a
 * outra continuava. Por cima disso, a barra de menu File/Edit/View/Window/Help
 * — o menu POR OMISSÃO do Electron, que nunca foi personalizado neste produto.
 *
 * main.ts não é carregável num teste (precisa do runtime Electron), por isso
 * este é um guarda ESTRUTURAL do arranque: as invariantes têm de se ler no
 * fonte, e não apenas estar "confirmadas em memória".
 *
 * ── REVISÃO QA2 (25/10/2026) ────────────────────────────────────────────────
 * Três guardas ficaram a descrever a implementação ANTIGA e falhavam contra a
 * actual. Em nenhum dos três a invariante se perdeu — o que mudou foi ONDE ela
 * vive. Cada guarda foi reescrito para a implementação real, com controles de
 * mutação que provam que não passaram a ser sempre-verdadeiros:
 *
 *   1. `<BootScreen steps={bootSteps} />` inline  →  BootScreen passou a receber
 *      `readiness` (o facto derivado) e `onEnterLimited` (o clique explícito de
 *      UNKNOWN). Continua a ser o único ecrã do arranque.
 *   2. O componente saiu de App.tsx para `components/BootScreen.tsx`; o teste
 *      procurava `function BootScreen` em App.tsx e comparava duas fatias vazias.
 *      A moldura comum (auth-page) continua a existir — agora medida nos dois
 *      ficheiros certos.
 *   3. O teto deixou de ser `setTimeout(..., 20_000)` inline e passou a
 *      `DEFAULT_STARTUP_TIMEOUT_MS` (20 s) com `bootPastDeadline` → UNKNOWN. O
 *      objetivo do guarda é MAIS forte agora: o relógio não pode promover o
 *      arranque a pronto, só a prontidão confirmada pode.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(HERE, "..", "..", "app", "src");
const MAIN = fs.readFileSync(path.join(HERE, "..", "src", "main.ts"), "utf8");
const APP = fs.readFileSync(path.join(APP_DIR, "App.tsx"), "utf8");
const BOOT_COMPONENT = fs.readFileSync(path.join(APP_DIR, "components", "BootScreen.tsx"), "utf8");
const LOADING_LIB = fs.readFileSync(path.join(APP_DIR, "lib", "loadingStates.ts"), "utf8");

const hasSplashLayer = (source) => /splashWindow|createSplashScreen/.test(source);

/** Bloco `if (bootPhase === "booting") { ... }` do renderer. */
function bootPhaseBlock(source) {
  const start = source.indexOf('if (bootPhase === "booting")');
  if (start < 0) return "";
  const end = source.indexOf("const isLiquid", start);
  return source.slice(start, end < 0 ? source.length : end);
}

/**
 * O arranque é desenhado pelo BootScreen e recebe os dois factos de que depende:
 * a prontidão derivada e os passos já confirmados.
 */
function rendersBootScreen(source) {
  const bloco = bootPhaseBlock(source);
  if (!bloco) return false;
  return (
    /return\s*\(\s*<BootScreen/.test(bloco) &&
    /readiness=\{bootReadiness\}/.test(bloco) &&
    /steps=\{bootSteps\}/.test(bloco)
  );
}

/** Teto do arranque declarado em `lib/loadingStates`. */
function startupCeilingMs(source) {
  const bruto = source.match(/DEFAULT_STARTUP_TIMEOUT_MS\s*=\s*([\d_]+)/)?.[1];
  return bruto === undefined ? null : Number(bruto.replace(/_/g, ""));
}

const frameClass = (source) => source.match(/className="(auth-page[^"]*)"/)?.[1];

describe("arranque — uma só camada de carregamento", () => {
  it("não cria janela splash no main process", () => {
    assert.equal(
      hasSplashLayer(MAIN),
      false,
      "reaparecer uma janela splash volta a sobrepor-se ao BootScreen do renderer",
    );
  });

  it("controlo: uma segunda janela de arranque é detetada", () => {
    // Mutação apenas em memória: o guarda acima não é sempre-verdadeiro.
    assert.equal(hasSplashLayer(`${MAIN}\nlet splashWindow = null;`), true);
  });

  it("o BootScreen do renderer continua a ser o ecrã de arranque", () => {
    assert.equal(
      rendersBootScreen(APP),
      true,
      "o arranque tem de continuar a ser desenhado pelo BootScreen, com readiness e steps",
    );
  });

  it("controlo: trocar o ecrã de arranque ou perder a prontidão é detetado", () => {
    // (a) outro componente no lugar do BootScreen
    assert.equal(rendersBootScreen(APP.replace("<BootScreen", "<SplashScreen")), false);
    // (b) BootScreen sem a prontidão derivada — passaria a decidir sozinho
    assert.equal(rendersBootScreen(APP.replace("readiness={bootReadiness}", "")), false);
    // (c) sem passos deixa de mostrar o que já foi confirmado
    assert.equal(rendersBootScreen(APP.replace("steps={bootSteps}", "")), false);
  });

  it("a verificação de sessão usa a mesma moldura do BootScreen, sem copy PT-BR", () => {
    const authLoading = APP.slice(
      APP.indexOf("function AuthLoadingScreen()"),
      APP.indexOf("function AppContent()"),
    );
    assert.ok(authLoading.length > 0, "AuthLoadingScreen tem de existir");

    // O BootScreen vive em components/BootScreen.tsx desde a revisão de
    // prontidão; a moldura comum continua a ser medida, agora no ficheiro real.
    assert.ok(BOOT_COMPONENT.includes("auth-page"), "BootScreen tem de manter a moldura auth-page");
    assert.equal(
      frameClass(authLoading),
      frameClass(BOOT_COMPONENT),
      "duas molduras diferentes fazem a troca de ecrã parecer um painel novo",
    );
    assert.equal(
      frameClass(BOOT_COMPONENT),
      "auth-page relative overflow-hidden",
      "a moldura do arranque é uma só e não pode derivar em silêncio",
    );
    assert.doesNotMatch(authLoading, /Carregando/, "gerúndio PT-BR na copy de arranque");
    assert.doesNotMatch(BOOT_COMPONENT, /Carregando/, "gerúndio PT-BR na copy de arranque");
  });

  it("controlo: uma moldura diferente ou um gerúndio PT-BR são detetados", () => {
    assert.notEqual(frameClass('<div className="auth-page-outra">'), frameClass(BOOT_COMPONENT));
    assert.equal(/Carregando/.test(`${BOOT_COMPONENT} <p>Carregando</p>`), true);
  });

  it("o teto do arranque cobre o serviço empacotado a frio e não é 8 s", () => {
    // O teto era 8 s; sem janela splash, o Painel abria com "Serviço
    // indisponível" a meio de um arranque que pode durar dezenas de segundos.
    const teto = startupCeilingMs(LOADING_LIB);
    assert.equal(typeof teto, "number", "o teto tem de viver numa constante única (lib/loadingStates)");
    assert.ok(teto >= 20_000, `o teto tem de cobrir um arranque a frio (>= 20 s), veio ${teto}`);
    assert.notEqual(teto, 8000, "8 s é o teto que produzia 'indisponível' a meio do arranque");
    assert.match(
      APP,
      /setTimeout\(\(\) => setBootPastDeadline\(true\), DEFAULT_STARTUP_TIMEOUT_MS\)/,
      "o App tem de usar a MESMA constante, não um número mágico paralelo",
    );
    assert.doesNotMatch(APP, /setBootPastDeadline\(true\),\s*8_?000\)/);
  });

  it("o relógio nunca promove o arranque a pronto — só a prontidão confirmada", () => {
    // Ao esgotar o orçamento o estado passa a UNKNOWN (decisão em
    // lib/bootReadiness); abrir a moldura continua a ser um clique explícito.
    assert.match(APP, /setBootPastDeadline\(true\)/);
    assert.doesNotMatch(
      APP,
      /setBootPastDeadline\(true\)[\s\S]{0,200}?setBootPhase\("ready"\)/,
      "o temporizador não pode abrir a moldura por decurso de tempo",
    );
    const promocoes = APP.match(/setBootPhase\("ready"\)/g) ?? [];
    assert.equal(
      promocoes.length,
      2,
      `apenas prontidão inicial e recuperação confirmada de sessão limitada; encontrados ${promocoes.length}`,
    );
    assert.match(
      APP,
      /if \(bootReadiness\.opensShell\) setBootPhase\("ready"\)/,
      "esse caminho tem de estar condicionado a opensShell",
    );
    assert.match(APP, /if \(limitedSessionNowReady\(bootPhase, bootReadiness\)\) \{\s*setBootPhase\("ready"\);\s*\}/,
      "a segunda promoção exige recuperação confirmada da sessão limitada");
  });

  it("controlo: abrir a moldura pelo relógio é detetado", () => {
    const mutante = APP.replace(
      "setTimeout(() => setBootPastDeadline(true), DEFAULT_STARTUP_TIMEOUT_MS)",
      'setTimeout(() => { setBootPastDeadline(true); setBootPhase("ready"); }, 20_000)',
    );
    assert.equal((mutante.match(/setBootPhase\("ready"\)/g) ?? []).length, 3);
    assert.match(mutante, /setBootPastDeadline\(true\)[\s\S]{0,200}?setBootPhase\("ready"\)/);
  });

  it("a janela nasce escondida e delega revelação preferencial por frame com fallback limitado", () => {
    const createWindow = MAIN.slice(
      MAIN.indexOf("function createWindow()"),
      MAIN.indexOf("import { spawn"),
    );
    assert.match(createWindow, /show: false/, "janela visível antes do paint é a janela branca");
    assert.match(createWindow, /backgroundColor: "#090b12"/, "fundo coerente com o tema base");
    assert.match(
      createWindow,
      /once\("ready-to-show"[\s\S]*?\n  \}\);/,
      "a revelação tem de estar atrelada ao ready-to-show",
    );
    assert.match(createWindow, /installInitialWindowReveal\(mainWindow/);
    assert.ok(createWindow.indexOf("installInitialWindowReveal") < createWindow.indexOf("mainWindow.loadFile"), "listeners antes da carga");
  });
});

describe("arranque — aviso de modo limitado", () => {
  /**
   * O aviso pertence à PRONTIDÃO, não a um clique antigo: depois de o serviço
   * confirmar tudo, o painel não pode continuar a dizer «sem confirmação».
   */
  const usaAvisoDerivado = (source) =>
    /mostraAvisoDeModoLimitado\(bootPhase, bootReadiness\)/.test(source);

  it("o aviso de modo limitado é derivado da prontidão actual", () => {
    assert.equal(usaAvisoDerivado(APP), true);
    assert.match(APP, /import \{[^}]*mostraAvisoDeModoLimitado[^}]*\} from "\.\/lib\/bootReadiness"/s);
    assert.doesNotMatch(
      APP,
      /\{bootPhase === "limited" && \(/,
      "condicionar só a bootPhase mantém o aviso depois de o serviço confirmar tudo",
    );
    assert.match(
      APP,
      /bootReadiness\.(limitation|detail)/,
      "o texto do aviso tem de vir do facto derivado, não de uma afirmação fixa sobre o serviço",
    );
  });

  it("controlo: a condição antiga (só bootPhase) é detetada", () => {
    const mutante = APP.replace("mostraAvisoDeModoLimitado(bootPhase, bootReadiness)", 'bootPhase === "limited"');
    assert.equal(usaAvisoDerivado(mutante), false);
    assert.match(mutante, /\{bootPhase === "limited" && \(/);
  });
});

describe("arranque — menu nativo", () => {
  it("retira o menu por omissão APENAS no artefacto empacotado", () => {
    assert.match(
      MAIN,
      /if \(app\.isPackaged\) \{\s*\n\s*Menu\.setApplicationMenu\(null\);/,
      "o menu File/Edit/View/Window/Help é o menu por omissão do Electron; em DEV fica como estava",
    );
  });

  it("o menu contextual da tray não depende do menu da aplicação", () => {
    assert.match(MAIN, /tray\.setContextMenu\(Menu\.buildFromTemplate/);
  });
});