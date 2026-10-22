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
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = fs.readFileSync(path.join(HERE, "..", "src", "main.ts"), "utf8");
const APP = fs.readFileSync(path.join(HERE, "..", "..", "app", "src", "App.tsx"), "utf8");

const hasSplashLayer = (source) => /splashWindow|createSplashScreen/.test(source);

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
    assert.match(APP, /if \(bootPhase === "booting"\) \{\s*return <BootScreen steps=\{bootSteps\} \/>;/);
  });

  it("a verificação de sessão usa a mesma moldura, sem copy PT-BR", () => {
    const authLoading = APP.slice(
      APP.indexOf("function AuthLoadingScreen()"),
      APP.indexOf("function AppContent()"),
    );
    assert.ok(authLoading.length > 0, "AuthLoadingScreen tem de existir");
    const bootScreen = APP.slice(APP.indexOf("function BootScreen"), APP.indexOf("function AuthenticatedApp"));
    const frame = (source) => source.match(/className="(auth-page[^"]*)"/)?.[1];
    assert.equal(
      frame(authLoading),
      frame(bootScreen),
      "duas molduras diferentes fazem a troca de ecrã parecer um painel novo",
    );
    assert.doesNotMatch(authLoading, /Carregando/, "gerúndio PT-BR na copy de arranque");
  });

  it("o teto do arranque cobre o serviço empacotado a frio", () => {
    // O teto era 8 s; sem janela splash, o Painel abria com "Serviço
    // indisponível" a meio de um arranque que pode durar dezenas de segundos.
    assert.match(APP, /setBootPhase\("ready"\), 20_000\)/);
    assert.doesNotMatch(APP, /setBootPhase\("ready"\),\s*\}?,\s*8000\)/);
  });

  it("a janela nasce escondida e só é revelada depois do primeiro frame", () => {
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
    assert.match(createWindow, /mainWindow\?\.show\(\)/);
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
