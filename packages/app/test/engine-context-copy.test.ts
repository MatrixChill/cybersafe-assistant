import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { engineContextCopy, buildFindingGuidance } from "@cybersafe/shared-types";
import type { EngineSubsystemHealth } from "@cybersafe/shared-types";
import { windowsFirewallDisplay, wfpModuleDisplay } from "../src/lib/protectionHealth";

/**
 * WS-B — CONTEXTO HUMANO DOS MOTORES.
 *
 * Dados reais medidos live via pipe `protection.getState` nesta maquina:
 *   yara         active       "Loaded 1 rule(s) from file"
 *   hashDb       active       "Loaded 4 signature(s) from ...default.json"
 *   nativeEngine active       "packages\native-engine\build\Release\scan-engine.exe"
 *   clamav       degraded     "ClamAV instalado mas sem base de assinaturas ...; corre freshclam"
 *   wfp          unavailable  "WFP filter not started"
 *
 * O ecrã despejava esses tokens e paths no texto principal. A copy humana é
 * PT-PT; o detalhe tecnico (path, SHA, detail cru) continua so nos detalhes.
 */

const REAL: Record<string, EngineSubsystemHealth> = {
  yara: { status: "active", detail: "Loaded 1 rule(s) from file" },
  hashDb: { status: "active", detail: "Loaded 4 signature(s) from C:\\ProgramData\\CyberSafe\\definitions\\default.json" },
  nativeEngine: { status: "active", detail: "packages\\native-engine\\build\\Release\\scan-engine.exe" },
  clamav: {
    status: "degraded",
    detail: "ClamAV instalado mas sem base de assinaturas — C:\\ClamAV\\db nao tem ficheiros .cvd/.cld (verificados: C:\\ClamAV\\db); corre freshclam",
  },
  wfp: { status: "unavailable", detail: "WFP filter not started" },
};

const TOKENS_CRUS = /\b(degraded|unavailable|active|error)\b/i;
const PATHS = /[A-Za-z]:\\|packages\\|\.exe|\.json|\.cvd|freshclam|Loaded \d/;

describe("WS-B 1 — copy humana por motor (dados reais)", () => {
  test("YARA: Ativo, conta as regras carregadas, nunca o detail cru", () => {
    const c = engineContextCopy("yara", REAL.yara);
    assert.equal(c.estado, "Ativo");
    assert.match(c.texto, /1 regra carregada/i, c.texto);
    assert.doesNotMatch(c.texto, /Loaded/i, `detail cru no texto principal: ${c.texto}`);
  });

  // ── CONTRATO DE COBERTURA (YARA P1) ──────────────────────────────────────
  // A copy deixou de ser uma frase fixa. O serviço mede `coverage` e a UI
  // traduz o valor medido. O caso que importa mais e o ULTIMO: um servico
  // antigo nao envia o campo, e a ausencia de evidencia nao se traduz como
  // cobertura boa nem como cobertura medida-pequeno.
  test("coverage='limited' diz que são só regras de canário", () => {
    const c = engineContextCopy("yara", { ...REAL.yara, coverage: "limited" });
    assert.match(c.contexto!, /limitada/i, c.contexto);
    assert.match(c.contexto!, /canário/i, c.contexto);
    assert.doesNotMatch(c.contexto!, /abrangente/i);
  });

  test("coverage='normal' legado sem evidência não afirma cobertura normal", () => {
    const c = engineContextCopy("yara", { ...REAL.yara, coverage: "normal" });
    assert.match(c.contexto!, /Cobertura não verificada/i, c.contexto);
    assert.doesNotMatch(c.contexto!, /Cobertura normal/i, c.contexto);
  });

  test("coverage='unknown' diz que não foi verificado — nunca 'normal'", () => {
    const c = engineContextCopy("yara", { ...REAL.yara, coverage: "unknown" });
    assert.match(c.contexto!, /não verificada/i, c.contexto);
    assert.doesNotMatch(c.contexto!, /cobertura normal/i, "não verificada nunca se traduz como normal");
  });

  test("SEM coverage (serviço antigo) diz que não foi comunicada — não inventa", () => {
    const c = engineContextCopy("yara", REAL.yara);
    assert.equal(c.contexto, "Cobertura não comunicada por este serviço.");
    assert.doesNotMatch(c.contexto!, /limitada/i, "sem medição não se afirma que medimos pouco");
    assert.doesNotMatch(c.contexto!, /normal/i, "sem medição nunca se afirma cobertura normal");
  });

  test("Hash DB: 4 assinaturas reais, sem path, nunca 'abrangente'", () => {
    const c = engineContextCopy("hashDb", { ...REAL.hashDb, coverage: "limited" });
    assert.equal(c.estado, "Ativo");
    assert.match(c.texto, /4 assinaturas carregadas/i, c.texto);
    assert.doesNotMatch(c.texto + c.contexto, PATHS, c.texto);
    assert.match(c.contexto!, /limitada/i, c.contexto);
    assert.doesNotMatch((c.texto + c.contexto).toLowerCase(), /abrangente/, "cobertura limitada nunca se chama abrangente");
  });

  test("ClamAV: Degradado, explica a base ausente, sem paths", () => {
    const c = engineContextCopy("clamav", REAL.clamav);
    assert.equal(c.estado, "Degradado");
    assert.match(c.texto, /base de assinaturas/, c.texto);
    assert.doesNotMatch(c.texto, PATHS, `path no texto principal: ${c.texto}`);
    assert.match(c.contexto ?? "", /instaladas ou atualizadas/, "orientacao sem executar nada: ${c.contexto}");
  });

  test("Native Engine: disponivel, path so existe no detail cru (nao na copy)", () => {
    const c = engineContextCopy("nativeEngine", REAL.nativeEngine);
    assert.equal(c.estado, "Ativo");
    assert.match(c.texto, /Motor nativo de análise disponível/i, c.texto);
    assert.doesNotMatch(c.texto, PATHS, `path no texto principal: ${c.texto}`);
  });

  test("WFP: filtro proprio do CyberSafe, nunca confundido com o Windows", () => {
    const c = engineContextCopy("wfp", REAL.wfp);
    assert.equal(c.estado, "Indisponível");
    assert.match(c.texto, /O filtro de rede próprio do CyberSafe não está ativo\./, c.texto);
    assert.match(c.contexto ?? "", /Isto não significa que o Firewall do Windows esteja desligado\./, c.contexto ?? "");
    // Proibido sem prova: a promessa de arranque automatico com a Protecao.
    assert.doesNotMatch((c.texto + (c.contexto ?? "")).toLowerCase(), /arranca quando/, c.texto);
  });

  test("nenhuma copy principal leva tokens crus ou paths", () => {
    for (const key of Object.keys(REAL)) {
      const c = engineContextCopy(key, REAL[key]);
      assert.doesNotMatch(c.texto, TOKENS_CRUS, `${key}: token cru em "${c.texto}"`);
      assert.doesNotMatch(c.texto, PATHS, `${key}: path/detail cru em "${c.texto}"`);
    }
  });

  test("sem leitura nao ha invento: motor ausente e honesto", () => {
    const c = engineContextCopy("clamav", undefined);
    assert.doesNotMatch(c.estado + c.texto, /ativo|instalado/i, `ausente nao pode afirmar presenca: ${c.estado} ${c.texto}`);
  });
});

describe("WS-B 2 — DADO do dashboard sem tokens nem paths", () => {
  const g = buildFindingGuidance({
    id: "security:engine-unavailable",
    category: "security",
    severity: "attention",
    title: "Proteção parcialmente indisponível",
    summary: "2 componentes de proteção precisam de atenção.",
    source: "protection-engine",
    firstSeen: "2026-09-30T08:00:00.000Z",
    lastSeen: "2026-09-30T08:20:00.000Z",
    actionable: false,
    evidence: {
      engine: "ClamAV, Filtro WFP do CyberSafe",
      engineStatus: "degraded, unavailable",
      evidenceLines: [
        "ClamAV: Degradado — Motor instalado, mas a base de assinaturas antivírus ainda não está disponível.",
        "Filtro WFP do CyberSafe: Indisponível — O filtro de rede próprio do CyberSafe não está ativo.",
      ],
    },
  } as never);

  test("o estado aparece em PT-PT, nunca o token ingles", () => {
    const todo = g.dado.join("\n");
    assert.doesNotMatch(todo, /\((degraded|unavailable)\)/i, todo);
    assert.doesNotMatch(todo, TOKENS_CRUS, todo);
    assert.match(todo, /Degradado/, todo);
    assert.match(todo, /Indisponível/, todo);
  });

  test("nenhum path ou mensagem de provider no DADO", () => {
    assert.doesNotMatch(g.dado.join("\n"), PATHS);
  });
});

describe("WS-B 3 — Windows Firewall e WFP na fonte de copy da app", () => {
  test("Windows Firewall sem leitura: 'Não verificado' com a copy do packet", () => {
    const win = windowsFirewallDisplay(null);
    assert.equal(win.status, "unknown");
    assert.equal(win.text, "Não verificado");
    assert.match(win.detail, /O CyberSafe ainda não consultou o estado do Firewall do Windows nesta vista\./, win.detail);
    assert.doesNotMatch(win.detail + win.text, /desligad|ativo\b/i, "sem leitura nao se afirma nada");
  });

  test("WFP: diz o disclaimer do Windows e NAO promete arranque com a Protecao", () => {
    const wfp = wfpModuleDisplay(REAL.wfp);
    assert.match(wfp.detail, /Isto não significa que o Firewall do Windows esteja desligado\./, wfp.detail);
    assert.doesNotMatch(wfp.detail, /arranca quando/i, `afirmacao sem prova: ${wfp.detail}`);
  });
});

describe("WS-B 4 — score copy", () => {
  const src = readFileSync(new URL("../src/components/ProtectionDetails.tsx", import.meta.url), "utf8");
  test("'estão ativos' substitui 'estão a funcionar'", () => {
    assert.doesNotMatch(src, /estão a funcionar/, "copy antiga");
    assert.match(src, /estão ativos/, "falta a copy nova");
  });
  test("a cobertura real (regras/assinaturas) aparece junto ao detalhe", () => {
    assert.match(src, /Cobertura atual/, "linhas de cobertura em falta");
  });
  test("formula do score nao foi tocada (explicacao vive em protectionHealth)", () => {
    assert.ok(src.includes("effectiveRiskScore") || src.includes("SCORE_WEIGHTS") || src.includes("explainScore"), "a explicacao dos pesos reais tem de continuar");
  });
});
