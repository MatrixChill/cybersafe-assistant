import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EngineHealth, EngineSubsystemCoverage, EngineSubsystemStatus } from "@cybersafe/shared-types";
import ProtectionDetails from "../src/components/ProtectionDetails";
import { engineContextCopy } from "@cybersafe/shared-types";

// Ver o task-manager-page.test.ts: o `tsx` compila o JSX dos fontes com o
// runtime classico e e este global que o satisfaz fora do Vite.
(globalThis as Record<string, unknown>).React = React;

/**
 * GATE DO CORPO DE REGRAS — a cobertura que o utilizador le.
 *
 * `status` e `coverage` sao dois eixos, e a confusao entre eles e o modo de
 * falha que importa aqui:
 *
 *   status    responde a "o motor carregou?"
 *   coverage  responde a "o que ele carregou cobre malware de verdade?"
 *
 * Um motor pode estar ACTIVO e ter dentro so a regra de canario de teste. O
 * `status` sozinho diz "activo" — verdadeiro e enganador. E `coverage` ausente
 * (servico antigo) nao e evidencia de cobertura: e ausencia de evidencia. Por
 * isso o campo ausente NUNCA pode virar "normal".
 *
 * Este ficheiro fixa os quatro casos reais e, mais importante, as combinacoes
 * que nunca podem chegar ao ecra. Um guard que so prova o caminho feliz deixa
 * passar o caminho que mente.
 *
 * As medem-se no HTML RENDERIZADO, nao na funcao: o que interessa e o que o
 * utilizador le (ver ws-b-rendered-copy.test.ts para o mesmo principio).
 */

type Cobertura = EngineSubsystemCoverage | undefined;

function engineCom(yaraStatus: EngineSubsystemStatus, coverage: Cobertura, detail = "Loaded 1 rule(s) from file") {
  const yara = { status: yaraStatus, detail, coverage } as unknown as EngineHealth["yara"];
  return {
    serviceRunning: true,
    anyEngineDegraded: false,
    degradedReasons: [],
    monitoredPaths: [],
    yara,
    hashDb: { status: "active", detail: "Loaded 4 signature(s) from default.json" },
    nativeEngine: { status: "active", detail: "scan-engine.exe" },
    clamav: { status: "active", detail: "ok" },
    wfp: { status: "unavailable", detail: "WFP filter not started" },
    firewall: { status: "unavailable", detail: "WFP filter not started" },
  } as unknown as EngineHealth;
}

function renderizar(yaraStatus: EngineSubsystemStatus, coverage: Cobertura, detail?: string): string {
  return renderToStaticMarkup(
    createElement(ProtectionDetails, {
      engine: engineCom(yaraStatus, coverage, detail),
      // O nivel global nao é o que este gate testa: o alvo e a cobertura do
      // YARA. Passamos sempre um nivel VALIDO para o componente nao rebentar
      // antes de chegar a linha da cobertura.
      level: "degraded",
      open: true,
      onClose: () => {},
      score: 80,
    }),
  );
}

/** Combinações medidas e legado, com a mensagem que o utilizador deve ver. */
const REAIS: {
  nome: string;
  status: EngineSubsystemStatus;
  coverage: Cobertura;
  detalhe: string;
  frase: string;
  statusText: string;
}[] = [
  {
    nome: "fallback/canario: motor DEGRADADO, cobertura LIMITADA",
    status: "degraded",
    coverage: "limited",
    detalhe: "Loaded 1 rule(s) from fallback (canário de teste)",
    frase: "Cobertura limitada: só regras de canário de teste",
    statusText: "Degradado",
  },
  {
    nome: "corpus sem proveniência validada: motor ACTIVO, cobertura NÃO VERIFICADA",
    status: "active",
    coverage: "unknown",
    detalhe: "Loaded 842 rule(s) from file",
    frase: "Cobertura não verificada: a origem e o alcance das definições carregadas não foram validados.",
    statusText: "Ativo",
  },
  {
    nome: "valor normal legado: cobertura não verificada sem evidência",
    status: "active",
    coverage: "normal",
    detalhe: "Loaded 842 rule(s) from file",
    frase: "Cobertura não verificada: a origem e o alcance das definições carregadas não foram validados.",
    statusText: "Ativo",
  },
  {
    nome: "indisponivel: cobertura DESCONHECIDA",
    status: "unavailable",
    coverage: "unknown",
    detalhe: "YARA não inicializado",
    frase: "Cobertura não verificada: o motor não está ativo.",
    statusText: "Indisponível",
  },
  {
    nome: "serviço antigo: campo AUSENTE diz que não foi comunicada",
    status: "active",
    coverage: undefined,
    detalhe: "Loaded 1 rule(s) from file",
    frase: "Cobertura não comunicada por este serviço",
    statusText: "Ativo",
  },
];

describe("gate do YARA — estados medidos e legado, no HTML renderizado", () => {
  for (const caso of REAIS) {
    test(caso.nome, () => {
      const markup = renderizar(caso.status, caso.coverage, caso.detalhe);

      assert.ok(
        markup.includes(caso.frase),
        `falta a frase "${caso.frase}"\n${markup.slice(0, 500)}`,
      );
      assert.ok(
        markup.includes(caso.statusText),
        `falta o estado "${caso.statusText}" — o token cru chegou ao ecra`,
      );
      // Nenhum dos quatro pode afirmar cobertura normal por accident. O caso
      // "normal" e o unico onde a frase aparece, e affirmamos isso abaixo.
      for (const errado of new Set(REAIS.filter((c) => c.frase !== caso.frase).map((c) => c.frase))) {
        assert.ok(
          !markup.includes(errado),
          `o caso ${caso.nome} tambem renderizou "${errado}"`,
        );
      }
    });
  }
});

describe("gate do YARA — combinacoes que NUNCA podem chegar ao ecra", () => {
  test("unavailable + normal: motor indisponivel nunca diz cobertura normal", () => {
    // Impossivel do ponto de vista do servico — nenhum caminho produz isto.
    // Se algum dia produzisse, seria um motor desligado a prometer cobertura
    // plena: a mentira mais grave das quatro.
    const markup = renderizar("unavailable", "normal");
    assert.ok(!markup.includes("Cobertura normal"), markup.slice(0, 500));
    assert.ok(!markup.includes("Cobertura limitada"), markup.slice(0, 500));
  });

  test("degraded + cobertura ampla: nunca 'cobertura normal'", () => {
    // O canário é o caso real de hoje: o motor carregou o fallback, por isso
    // esta. Se o `status` degradado aparecesse com 'normal', o utilizador leria
    // "Motor Degradado" ao lado de "Cobertura normal" e nao saberia qual
    // acreditar.
    const markup = renderizar("degraded", "normal");
    assert.ok(!markup.includes("Cobertura normal"), markup.slice(0, 500));
  });

  test("campo ausente NUNCA significa 'normal' — nem com o motor activo", () => {
    // A regressao exacta que este gate existe para fechar. Sem `coverage` o
    // servico esta a dizer "nao medi", e a UI affirmar cobertura seria inventar
    // a medicao.
    const markup = renderizar("active", undefined);
    assert.ok(!markup.includes("Cobertura normal"), markup.slice(0, 500));
    assert.ok(markup.includes("Cobertura não comunicada"), markup.slice(0, 500));
  });

  test("degradado nunca diz 'Cobertura normal' em NENHUM valor de coverage", () => {
    for (const c of ["limited", "normal", "unknown", undefined] as Cobertura[]) {
      const markup = renderizar("degraded", c);
      assert.ok(
        !markup.includes("Cobertura normal"),
        `degraded + ${String(c)} renderizou "Cobertura normal"`,
      );
    }
  });
});

describe("gate do YARA — a mesma verdade no texto de contexto (engineContextCopy)", () => {
  // A cobertura aparece em DOIS sitios com codigo proprio: o painel
  // ProtectionDetails e o texto de contexto dos findings. Se so um deles
  // respeitar o gate, o utilizador recebe as duas versoes e a errada.
  test("active + unknown comunica cobertura não verificada; active + limited diz limitada", () => {
    const unknown = engineContextCopy("yara", {
      status: "active",
      detail: "Loaded 842 rule(s) from file",
      coverage: "unknown",
    } as never);
    assert.match(
      unknown.contexto ?? "",
      /Cobertura não verificada: a origem e o alcance das definições carregadas não foram validados\./,
    );

    const limitada = engineContextCopy("yara", {
      status: "active",
      detail: "Loaded 1 rule(s) from fallback",
      coverage: "limited",
    } as never);
    assert.match(limitada.contexto ?? "", /Cobertura limitada/);
  });

  test("active + campo ausente NAO diz cobertura normal", () => {
    const c = engineContextCopy("yara", { status: "active", detail: "Loaded 1 rule(s) from file" } as never);
    assert.doesNotMatch(c.contexto ?? "", /Cobertura normal/);
    assert.match(c.contexto ?? "", /não comunicada/);
  });

  test("degraded e unavailable nunca produzem texto de cobertura", () => {
    // O `engineContextCopy` so emite `contexto` de cobertura no ramo `active`.
    // Isso e o comportamento correcto: com o motor fora de `active` o texto
    // principal ja diz o que falta, e acrescentar cobertura seria uma segunda
    // afirmacao sem base. O guard e que a cobertura nao regressa — aqui
    // medimos o texto COMPLETO, nao so o campo `contexto`.
    for (const status of ["degraded", "unavailable", "error"] as const) {
      const c = engineContextCopy("yara", { status, detail: "Loaded 1 rule(s) from fallback", coverage: "normal" } as never);
      assert.doesNotMatch(c.contexto ?? "", /Cobertura normal/, `${status} produziu cobertura normal`);
      assert.doesNotMatch(c.texto, /Cobertura normal/, `${status} produziu cobertura normal no texto`);
    }
  });
});