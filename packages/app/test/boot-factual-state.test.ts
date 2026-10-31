import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HardwareSnapshot, PcState, ProtectionState } from "@cybersafe/shared-types";
import { deriveBootReadiness, mostraAvisoDeModoLimitado } from "../src/lib/bootReadiness";
import { BOOT_BODY_COPY } from "../src/lib/loadingStates";
import { BootScreen, type BootStep } from "../src/components/BootScreen";
import { AppearanceProvider } from "../src/contexts/AppearanceContext";

/**
 * Ecrã de arranque FACTUAL (TP-HAIKU-BOOT-READINESS).
 *
 * Aqui o componente REAL é renderizado (SSR React, sem DOM): o que se verifica
 * é o que o utilizador lê. As duas promessas que este ficheiro guarda:
 *   · em UNKNOWN não há spinner nem verde — o tempo acabou sem confirmação;
 *   · a copy do arranque tem uma só fonte e o atraso artificial de 400 ms não
 *     volta a existir no App.
 */

const PASSOS: BootStep[] = [
  { label: "A verificar estado da proteção", status: "active" },
  { label: "A ligar ao serviço", status: "pending" },
  { label: "A verificar estado do computador", status: "pending" },
  { label: "A carregar sensores", status: "pending" },
];

const PC_STATE = { findings: [] } as unknown as PcState;
const HARDWARE = { cpu: { usage: 2 } } as unknown as HardwareSnapshot;

const PROTECAO = {
  status: "safe",
  protectionEnabled: true,
  engine: { serviceRunning: true, osLayerHealthy: true, degradedReasons: [], monitoredPaths: [] },
  stats: { riskScore: 95, totalEvents: 0, highSeverityEvents: 0, blockedExecutions: 0, quarantinedCount: 0, monitoredProcesses: 0 },
} as unknown as ProtectionState;

/** O componente real é renderizado, com o provider real que ele consome. */
function htmlDoEcra(props: Parameters<typeof BootScreen>[0]): string {
  return renderToStaticMarkup(createElement(AppearanceProvider, null, createElement(BootScreen, props)));
}

function render(estado: Parameters<typeof deriveBootReadiness>[0]) {
  const readiness = deriveBootReadiness(estado);
  return { readiness, html: htmlDoEcra({ readiness, steps: PASSOS, onEnterLimited: () => {} }) };
}

describe("BootScreen — desenha o facto recebido", () => {
  test("à espera: passos, marca e copy única, sem prometer pronto", () => {
    const { html } = render({
      serviceConnected: null,
      protection: null,
      pcState: null,
      hardware: null,
      loadingState: "INITIALIZING",
    });
    assert.match(html, new RegExp(BOOT_BODY_COPY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(html, /A verificar estado da proteção/, "os passos visíveis são os reais");
    assert.match(html, /data-boot-state="INITIALIZING"/);
    assert.match(html, /aria-live="polite"/);
    assert.doesNotMatch(html, /data-boot-ready="true"/, "ainda não há prontidão nenhuma");
  });

  test("UNKNOWN: sem spinner, sem verde, com a limitação e o clique explícito", () => {
    const { html } = render({
      serviceConnected: null,
      protection: null,
      pcState: null,
      hardware: null,
      loadingState: "INITIALIZING",
      pastDeadline: true,
    });
    assert.match(html, /data-boot-state="UNKNOWN"/);
    assert.match(html, /data-boot-ready="false"/);
    assert.doesNotMatch(html, /animate-spin/, "o tempo acabou: não há trabalho a decorrer para mostrar");
    assert.doesNotMatch(html, /text-cyber-green/, "nada de verde sem confirmação");
    assert.match(html, /Continuar para o painel/, "continuar é um clique explícito");
    assert.match(html, /sem confirmação|Não há garantia/i, "a limitação fica escrita ao lado do botão");
  });

  test("UNKNOWN só falta hardware: diz «sensores», não acusa o serviço de estar ausente", () => {
    const readiness = deriveBootReadiness({
      serviceConnected: true,
      protection: PROTECAO,
      pcState: PC_STATE,
      hardware: null,
      loadingState: "INITIALIZING",
      pastDeadline: true,
    });
    assert.equal(readiness.state, "UNKNOWN");
    const html = htmlDoEcra({ readiness, steps: PASSOS, onEnterLimited: () => {} });
    assert.match(html, /sensores/, "a limitação nomeia a leitura em falta");
    assert.doesNotMatch(html, /Sem confirmação do serviço/, "o serviço está confirmado: não se afirma o contrário");
  });

  test("sem `onEnterLimited` não se oferece uma saída que não existe", () => {
    const readiness = deriveBootReadiness({
      serviceConnected: null,
      protection: null,
      pcState: null,
      hardware: null,
      loadingState: "INITIALIZING",
      pastDeadline: true,
    });
    const html = htmlDoEcra({ readiness, steps: PASSOS });
    assert.doesNotMatch(html, /Continuar para o painel/);
    assert.match(html, /data-boot-state="UNKNOWN"/);
  });

  test("pronto: a moldura não é o ecrã de arranque e não inventa nada", () => {
    const readiness = deriveBootReadiness({
      serviceConnected: true,
      protection: PROTECAO,
      pcState: PC_STATE,
      hardware: HARDWARE,
      loadingState: "READY",
    });
    assert.equal(readiness.state, "READY");
    assert.equal(readiness.claimsReady, true);
  });
});

describe("App — arranque sem atraso artificial e com o componente real", () => {
  const APP = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const COMPONENTE = readFileSync(new URL("../src/components/BootScreen.tsx", import.meta.url), "utf8");

  test("o atraso de 400 ms saiu do App", () => {
    assert.doesNotMatch(APP, /setTimeout\(\s*\(\)\s*=>\s*setBootPhase\("ready"\)\s*,\s*400\)/, "o atraso artificial de 400 ms não pode voltar");
    assert.doesNotMatch(APP, /setTimeout\([^)]*,\s*400\s*\)/, "nenhum tecto de 400 ms no arranque");
  });

  test("o tecto de 20 s já não promove a pronto", () => {
    assert.doesNotMatch(APP, /setBootPhase\("ready"\),\s*20_000/, "20 s nunca pode valer READY");
    assert.doesNotMatch(APP, /setTimeout\([^)]*setBootPhase\("ready"\)[^)]*20_000/);
    assert.match(APP, /setBootPastDeadline\(true\)/, "o prazo passa a produzir UNKNOWN");
  });

  test("o App usa o componente e a política puros, e abre por facto", () => {
    assert.match(APP, /import \{ BootScreen, type BootStep \} from "\.\/components\/BootScreen"/);
    // A importação da política deixou de ser uma lista fechada de dois nomes: a
    // decisão do aviso do modo limitado passou para `mostraAvisoDeModoLimitado`
    // em lib/bootReadiness (revisão QA2). O que se exige é que os três nomes
    // continuem a vir da POLÍTICA PURA — não que a lista esteja bit-a-bit igual.
    const politica = APP.match(/import \{([^}]*)\} from "\.\/lib\/bootReadiness"/);
    assert.ok(politica, "o App tem de importar a política de ./lib/bootReadiness");
    for (const nome of ["deriveBootReadiness", "BOOT_COPY", "mostraAvisoDeModoLimitado"]) {
      assert.match(politica[1], new RegExp(`\\b${nome}\\b`), `${nome} tem de vir da política pura`);
    }
    assert.match(APP, /deriveBootReadiness\(\{/);
    assert.match(APP, /readiness=\{bootReadiness\}/);
    assert.match(APP, /onEnterLimited=\{\(\) => setBootPhase\("limited"\)\}/);
    assert.match(APP, /bootReadiness\.opensShell\) setBootPhase\("ready"\)/, "a moldura abre por facto, não por relógio");
    // Sem reimplementação local da decisão: o App chama, não decide.
    assert.doesNotMatch(APP, /bootPhase === "limited" &&/,
      "a condição do aviso voltou a ser duplicada no App em vez de viver na política");
  });

  test("a copy do arranque vive numa só fonte (componente), não duplicada", () => {
    assert.match(COMPONENTE, /import \{ BOOT_BODY_COPY \} from "\.\.\/lib\/loadingStates"/);
    assert.match(COMPONENTE, /\{BOOT_BODY_COPY\}/);
    assert.doesNotMatch(APP, /A preparar o seu centro de segurança\.\.\./, "a copy voltou a ser duplicada no App");
    assert.doesNotMatch(COMPONENTE, /A preparar o seu centro de segurança\.\.\./, "a copy voltou a ser duplicada no componente");
  });

  test("o modo limitado mantém a limitação visível no painel, pelo estado actual", () => {
    const POLITICA = readFileSync(new URL("../src/lib/bootReadiness.ts", import.meta.url), "utf8");
    // Local de chamada no App: o aviso é gateado pela política pura.
    assert.match(APP, /\{mostraAvisoDeModoLimitado\(bootPhase, bootReadiness\) && \(/,
      "o aviso do modo limitado tem de ser decidido pela política, no sítio certo");
    assert.match(APP, /BOOT_COPY\.limitedBannerTitle/);
    assert.match(APP, /bootReadiness\.limitation \?\? BOOT_COPY\.limitedBannerDetail/,
      "o painel mostra a limitação REAL; a copy é só o texto de recurso");
    // A regra vive numa só fonte.
    assert.match(POLITICA, /bootPhase === "limited" && !readiness\.claimsReady/,
      "em limitado continua visível, e deixa de afirmar quando a prontidão é alegada");

    // Comportamento, não apenas forma.
    const semConfirmacao = deriveBootReadiness({
      serviceConnected: null, protection: null, pcState: null, hardware: null,
      loadingState: "INITIALIZING", pastDeadline: true,
    });
    assert.equal(semConfirmacao.claimsReady, false, "base do raciocínio: sem confirmação");
    assert.equal(mostraAvisoDeModoLimitado("limited", semConfirmacao), true,
      "limitado sem confirmação tem de avisar");
    assert.equal(mostraAvisoDeModoLimitado("booting", semConfirmacao), false,
      "durante o arranque não existe aviso de modo limitado");
    const confirmado = deriveBootReadiness({
      serviceConnected: true, protection: PROTECAO, pcState: PC_STATE, hardware: HARDWARE,
      loadingState: "READY", pastDeadline: false,
    });
    assert.equal(confirmado.claimsReady, true, "base do raciocínio: prontidão alegada");
    assert.equal(mostraAvisoDeModoLimitado("limited", confirmado), false,
      "o aviso não pode afirmar para sempre uma ausência que já se resolveu");
  });

  test("controlo: um aviso sempre-visível ou sempre-escondido é detetado", () => {
    const POLITICA = readFileSync(new URL("../src/lib/bootReadiness.ts", import.meta.url), "utf8");
    const REGRA = /bootPhase === "limited" && !readiness\.claimsReady/;
    assert.match(POLITICA, REGRA, "a regra existe");
    // (a) sempre-visível em limitado: perde a condição de prontidão.
    assert.doesNotMatch(POLITICA.replace(' && !readiness.claimsReady', ""), REGRA,
      "o controlo tem de apanhar um aviso que nunca se cala");
    // (b) sempre-escondido: perde a condição de fase.
    assert.doesNotMatch(POLITICA.replace('bootPhase === "limited" && ', ""), REGRA,
      "o controlo tem de apanhar um aviso que desaparece");
    // (c) o App sem o gate da política volta a ser acentrado na velha forma.
    assert.doesNotMatch(APP.replace("{mostraAvisoDeModoLimitado(bootPhase, bootReadiness) && (", "(() => true) && ("),
      /\{mostraAvisoDeModoLimitado\(bootPhase, bootReadiness\) && \(/);
  });
});
