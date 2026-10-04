import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { engineStatusText } from "../src/lib/protectionHealth";
import type { EngineSubsystemStatus } from "@cybersafe/shared-types";

/**
 * `engineStatusText` chamava-se assim e devolvia os tokens tecnicos crus em
 * maiusculas: "ACTIVE", "DEGRADED", "ERROR", "UNAVAILABLE". O nome da funcao
 * prometia texto humano e nao cumpria: o utilizador lia DEGRADED no ecra.
 *
 * Um estado de motor nao e um UUID e nao e um token. E PT-PT curto.
 */

const ESTADOS: EngineSubsystemStatus[] = ["active", "degraded", "unavailable", "error"];

function ler(pagina: string): string {
  return readFileSync(new URL(`../src/${pagina}`, import.meta.url), "utf8");
}

describe("1 — os quatro estados produzem texto PT-PT", () => {
  test("cada estado tem texto proprio, em portugues, curto", () => {
    const textos = ESTADOS.map((s) => engineStatusText(s));
    assert.deepEqual(textos, ["Ativo", "Degradado", "Indisponível", "Erro"]);
    for (const t of textos) {
      assert.ok(t.length > 0 && t.length <= 14, `"${t}" tem de ser curto e nao vazio`);
    }
  });

  test("NENHUM estado devolve o token ingles", () => {
    // A regressao exata: antes disto, cada estado devolvia o seu token em
    // maiusculas. O teste falha se algum voltar.
    for (const s of ESTADOS) {
      const texto = engineStatusText(s);
      assert.notEqual(texto, s.toUpperCase(), `devolveu o token cru: "${texto}"`);
      assert.doesNotMatch(texto, /ACTIVE|DEGRADED|UNAVAILABLE|ERROR/, `token ingles em "${texto}"`);
    }
  });

  test("os quatro textos sao distintos entre si", () => {
    assert.equal(new Set(ESTADOS.map((s) => engineStatusText(s))).size, 4);
  });

  test("PT-PT com acentos, e sem PT-BR", () => {
    const tudo = ESTADOS.map((s) => engineStatusText(s)).join(" ");
    assert.match(tudo, /Indisponível/, "o produto escreve com acento: 'Indisponível'");
    assert.doesNotMatch(tudo, /usuário|arquivo/i, "sem PT-BR");
  });

  test("um estado desconhecido NAO vira um estado inventado", () => {
    // A funcao nao pode aceitar um token que nao conhece e devolver um texto
    // que pareca um diagnostico. O unico fallback honesto e dizer que nao se
    // sabe — que e diferente de dizer "Indisponivel", que e uma affirmacao.
    const texto = engineStatusText("desconhecido" as EngineSubsystemStatus);
    assert.ok(texto.length > 0, "tem de devolver algo");
    assert.notEqual(texto, "Indisponível", `nao pode afirmar um estado que nao conhece: "${texto}"`);
  });
});

describe("2 — ReportsPage e MonitorPage nao passam raw status", () => {
  test("ReportsPage ja nao faz e.status.toUpperCase()", () => {
    const src = ler("pages/ReportsPage.tsx");
    assert.doesNotMatch(src, /e\.status\.toUpperCase\(\)/, "o status cru ainda e impresso em maiusculas");
    assert.ok(src.includes("engineStatusText"), "tem de passar pela fonte unica de verdade");
  });

  test("MonitorPage nao inventa um 'degraded' quando nao ha dados", () => {
    const src = ler("pages/MonitorPage.tsx");
    // O fallback `?? "degraded"` devolvia um ESTADO INVENTADO quando nao havia
    // ProtectionLevel: um diagnostico falso, do tipo que a packet proibiu.
    assert.doesNotMatch(src, /\?\?\s*"degraded"/, "ainda inventa 'degraded' sem dados");
    assert.ok(src.includes("engineStatusText"), "tem de passar pela fonte unica de verdade");
  });

  test("ProtectionDetails e o terceiro sitio, e usa a mesma fonte", () => {
    const src = ler("components/ProtectionDetails.tsx");
    // Os 4 badges chamam engineStatusText diretamente (a tabela STATUS_META).
    // O WFP NAO chama: delega em wfpModuleDisplay, que esta em
    // protectionHealth.ts e chama a MESMA funcao. Uma fonte, nao cinco palpites.
    const usos = src.match(/engineStatusText\(/g) ?? [];
    assert.equal(usos.length, 4, `esperava 4 badges, encontrei ${usos.length}`);
    assert.ok(src.includes("wfpModuleDisplay"), "o WFP tem de continuar delegado a protectionHealth");
  });

  test("a funcao nao volta a ser contornada por nenhuma das tres paginas", () => {
    for (const pagina of ["pages/ReportsPage.tsx", "pages/MonitorPage.tsx", "components/ProtectionDetails.tsx"]) {
      const src = ler(pagina);
      assert.doesNotMatch(src, /"(ACTIVE|DEGRADED|UNAVAILABLE)"/, `${pagina} tem um token ingles hard-coded`);
      // Copy do estado written a mao: e a duplicacao que criou este bug.
      assert.doesNotMatch(src, /\?\s*\(\s*sub\.status\s*===\s*"active"/, `${pagina} duplica a copy do estado`);
    }
  });
});

describe("3 — a copy do WFP nao leva mais 'modulo'", () => {
  test("o detalhe do WFP esta em PT-PT corrente", () => {
    const src = ler("lib/protectionHealth.ts");
    // Uma linha de cada vez: `[^"]*` sem restricao atravessava linhas e
    // apanhava comentarios, que nao sao copy de ecra.
    // WS-B: a copy principal passou a dizer "filtro de rede proprio do
    // CyberSafe" (packet), por isso a string com "WFP" no ecra e agora so a
    // de ausencia de telemetria. A regra mantem-se: nenhuma leva "modulo".
    const detalhes = src.match(/"[^"\n]*WFP[^"\n]*"/g) ?? [];
    assert.ok(detalhes.length >= 1, `esperava copy do WFP, encontrei ${detalhes.length}`);
    for (const d of detalhes) {
      assert.doesNotMatch(d, /\bmodulo\b/i, `copy PT-BR/PT antigo: ${d}`);
    }
  });
});
