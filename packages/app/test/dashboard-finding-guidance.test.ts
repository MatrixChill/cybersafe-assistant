import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildFindingGuidance, FINDING_SEVERITY_LABEL } from "@cybersafe/shared-types";
import type { Finding, FindingEvidence } from "@cybersafe/shared-types";

/**
 * WS-5 — DADO / SIGNIFICADO / PRIORIDADE / ORIENTACAO no painel do estado.
 *
 * A descoberta que define o ambito: em `pcstate.ts`, de ~21 achados, SO UM tem
 * `actionable: true` (`monitor.start`, pcstate.ts:175-176). Os outros ~20 sao
 * `actionable: false`. E a app, ate agora, nao lia `actionable` nem `actionId`
 * em lado nenhum.
 *
 * Consequencia: escrever "o que fazer" para um achado que o proprio motor diz
 * que nao tem accao automatica seria escrever guidance que o produto nao
 * cumpre. E o modo mais facil de tornar um produto de seguranca desonesto.
 * Estes testes existem tambem para travar essa invencao.
 */

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "performance:cpu",
    category: "performance",
    severity: "attention",
    title: "Processo consome muito processador",
    summary: "Um processo esta a usar processador de forma continua.",
    source: "process-monitor",
    firstSeen: "2026-09-30T08:00:00.000Z",
    lastSeen: "2026-09-30T08:20:00.000Z",
    actionable: false,
    ...overrides,
  };
}

const source = readFileSync(new URL("../src/pages/DashboardPage.tsx", import.meta.url), "utf8");

describe("WS-5 T1 — DADO: os numeros vem do evidence, sem re-arredondar", () => {
  test("cpuPercent e memoryBytes aparecem com o valor exato do evidence", () => {
    const evidence: FindingEvidence = { processName: "alvo.exe", pid: 1234, cpuPercent: 87, memoryBytes: 13_263_071_744 };
    const g = buildFindingGuidance(finding({ evidence }));

    const cpu = g.dado.find((l) => /87/.test(l));
    assert.ok(cpu, `o Dado tem de trazer o 87%: ${JSON.stringify(g.dado)}`);

    // 13263071744 bytes = 12,35 GB. O texto tem de trazer o numero, nao
    // "muita memoria" e nao um 12 ou 13 arredondado a um numero bonito.
    const mem = g.dado.find((l) => /Memória/.test(l));
    assert.ok(mem, `o Dado tem de trazer a memoria: ${JSON.stringify(g.dado)}`);
    assert.match(mem, /GB|MB/, "a memoria em bytes tem de sair legivel (GB/MB)");
    assert.match(mem, /12,3|12,4|12,35/, `valor com a matematica certa, nao arredondado: ${mem}`);

    // E o CPU nao pode ser re-arredondado: 87 tem de ser 87.
    assert.match(cpu, /\b87\b/, `o CPU tem de ser 87, nao um numero aproximado: ${cpu}`);
  });

  test("o nome tecnico do componente e o estado sao dados separados", () => {
    // WS-B: o estado sai em PT-PT ("Indisponivel"), nunca o token ingles cru.
    const g = buildFindingGuidance(finding({ evidence: { engine: "service", engineStatus: "unavailable" } }));
    const estado = g.dado.find((l) => /Indisponível/.test(l));
    const componente = g.dado.find((l) => /service/.test(l));
    assert.ok(estado, `o estado do componente tem de aparecer: ${JSON.stringify(g.dado)}`);
    assert.ok(componente, "o nome do componente tem de aparecer");
    assert.notEqual(estado, componente, "nao podem estar colados no mesmo texto");
    assert.doesNotMatch(g.dado.join("\n"), /\bunavailable\b/i, "token cru nao e copy de ecra");
  });

  test("evidenceLines entra tal e qual, sem retocar", () => {
    const linha = "Recomendacao do Windows:Espaco insuficiente.";
    const g = buildFindingGuidance(finding({ evidence: { evidenceLines: [linha] } }));
    assert.ok(g.dado.includes(linha), `a linha tem de entrar verbatim: ${JSON.stringify(g.dado)}`);
  });
});

describe("WS-5 T2 — evidence ausente ou vazio: sem bloco Dado", () => {
  test("sem evidence -> dado vazio", () => {
    assert.deepEqual(buildFindingGuidance(finding()).dado, []);
    assert.deepEqual(buildFindingGuidance(finding({ evidence: {} })).dado, []);
  });

  test("a UI so renderiza o bloco Dado quando ha dado (nenhum bloco vazio)", () => {
    // Um bloco "Dado" vazio e pior que um bloco ausente: parece que falta
    // informacao quando nao falta.
    assert.ok(
      /g\.dado\.length\s*>\s*0/.test(source),
      "o bloco Dado tem de ser condicionado ao dado existir",
    );
    assert.ok(
      !/Dado<\/[a-z]+>\s*\{\s*g\.dado\.map/.test(source),
      "nao pode haver um bloco Dado que mapeie o dado sem verificar que existe",
    );
  });
});

describe("WS-5 T3 — actionable false: honesto, e sem botao de accao", () => {
  test("a orientacao diz que NAO ha accao automatica", () => {
    const g = buildFindingGuidance(finding({ actionable: false }));
    assert.equal(g.accionavel, false);
    assert.ok(g.orientacao, "tem de haver orientacao tambem no caso sem accao");
    assert.match(g.orientacao!, /n[ãa]o tem|n[ãa]o ha|autom[áa]tica/i, `tem de dizer que nao ha accao automatica: ${g.orientacao}`);
    assert.notEqual(g.accionavel, true);
  });

  test("este teste falha se alguem algum dia meter um botao de accao aqui", () => {
    // O painel mostra a orientacao. Nao pode haver um botao de accao no bloco
    // de orientacao: o produto nao executa nenhuma accao automatica aqui.
    const bloco = source.slice(source.indexOf("orientacao", source.indexOf("PcStateAttention")));
    assert.ok(
      !/<button[^>]*onClick=\{[^}]*action/i.test(bloco),
      "a orientacao nao pode ter um botao de accao: nao ha executor",
    );
    assert.ok(
      !/actionId/.test(source),
      "o actionId e um identificador interno e nao pode ser lido pela app",
    );
  });
});

describe("WS-5 T4 — actionId desconhecido: nao inventar nem vazar", () => {
  test("actionable true mas actionId desconhecido -> sem orientacao inventada", () => {
    const g = buildFindingGuidance(finding({ actionable: true, actionId: "fazer.magica" }));
    assert.equal(g.accionavel, false, "sem acao conhecida, nao e accionavel");
    assert.equal(g.orientacao, null, "nao pode inventar orientacao para uma acao que nao conhece");
  });

  test("o actionId cru nunca vaza para o texto", () => {
    for (const actionId of ["fazer.magica", "monitor.start"]) {
      const g = buildFindingGuidance(finding({ actionable: true, actionId }));
      const todo = [...g.dado, g.significado, g.prioridade, g.orientacao ?? ""].join(" ");
      assert.ok(!todo.includes(actionId), `o actionId "${actionId}" nao pode aparecer no texto`);
    }
  });

  test("actionable true SEM actionId -> tambem nao inventa", () => {
    const g = buildFindingGuidance(finding({ actionable: true, actionId: undefined }));
    assert.equal(g.orientacao, null);
    assert.equal(g.accionavel, false);
  });
});

describe("WS-5 T5 — SIGNIFICADO: o summary, verbatim", () => {
  test("o summary do service aparece igual, sem reescrita", () => {
    const summary = "Um processo esta a usar processador de forma continua.";
    const g = buildFindingGuidance(finding({ summary }));
    assert.equal(g.significado, summary);
  });

  test("mudar o summary muda o significado igual (prova de que nao e reescrito)", () => {
    const a = buildFindingGuidance(finding({ summary: "Texto A." }));
    const b = buildFindingGuidance(finding({ summary: "Texto B totalmente diferente." }));
    assert.equal(a.significado, "Texto A.");
    assert.equal(b.significado, "Texto B totalmente diferente.");
    assert.notEqual(a.significado, b.significado);
  });
});

describe("WS-5 T6 — contraste: o padrao apanha a forma sem acento e deixa passar a com acento", () => {
  // Um padrao que nao apanha nada e um padrao inútil. Este teste e o outro lado
  // do de T7: tem de DETETAR a forma errada, e NAO pode falhar na forma certa.
  const semAcento = /(?:^|[\s"'(])(?:memoria|acoes|acao|usuario|arquivo|deteccao|protecao)(?:$|[\s"'.,;:!?)])/i;

  test("o padrao DETETA a forma sem acento", () => {
    assert.ok(semAcento.test("memoria"), "tem de apanhar 'memoria'");
    assert.ok(semAcento.test("Use a acao de ficheiro"), "tem de apanhar 'acao'");
    assert.ok(semAcento.test("o usuario nao viu o arquivo"), "tem de apanhar 'usuario' e 'arquivo'");
  });

  test("o mesmo padrao NAO acusa a forma com acento", () => {
    assert.ok(!semAcento.test("Memória"), "nao pode acusar 'Memória'");
    assert.ok(!semAcento.test("Acções"), "nao pode acusar 'Acções'");
  });

  test("nenhum caso produz linguagem de ameaca sem evidencia", () => {
    const semDado = buildFindingGuidance(finding({ evidence: {} }));
    const texto = [...semDado.dado, semDado.orientacao ?? ""].join(" ");
    for (const palavra of ["ataque", "infeção", "malware", "perigo", "risco elevado", "hack", "vírus"]) {
      assert.ok(
        !new RegExp(palavra, "i").test(texto),
        `"${palavra}" sem evidence nao pode aparecer: ${texto}`,
      );
    }
  });
});

describe("WS-5 T7 — PT-PT com acentos, sem emoji", () => {
  test("a copy de guidance e PT-PT com acentos", () => {
    const g = buildFindingGuidance(finding({
      evidence: { processName: "alvo.exe", pid: 1, cpuPercent: 87, memoryBytes: 13_263_071_744, engine: "service", engineStatus: "unavailable" },
      actionable: true,
      actionId: "monitor.start",
    }));
    const todo = [...g.dado, g.significado, g.prioridade, g.orientacao ?? ""].join(" ");
    for (const errado of ["memoria", "acao", "acoes", "usuario", "arquivo", "deteccao", "protecao"]) {
      assert.ok(!new RegExp(`\\b${errado}\\b`, "i").test(todo), `"${errado}" sem acento: ${todo}`);
    }
  });

  test("sem emoji em PT-BR ou em qualquer outro sitio", () => {
    const g = buildFindingGuidance(finding({ evidence: { cpuPercent: 87 }, actionable: true, actionId: "monitor.start" }));
    const todo = [...g.dado, g.significado, g.prioridade, g.orientacao ?? ""].join(" ");
    assert.ok(
      !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(todo),
      `sem emoji na guidance: ${todo}`,
    );
  });
});

describe("WS-5 PRIORIDADE — a escala do produto, sem quarta escala", () => {
  test("os quatro niveis de FindingSeverity tem rotulo", () => {
    for (const s of ["urgent", "attention", "recommended", "informative"] as const) {
      assert.equal(typeof FINDING_SEVERITY_LABEL[s], "string");
      assert.ok(FINDING_SEVERITY_LABEL[s].length > 0, `${s} sem rotulo`);
    }
  });

  test("a prioridade vem de severity, e a escala nao muda de ordem", () => {
    assert.equal(buildFindingGuidance(finding({ severity: "urgent" })).prioridade, FINDING_SEVERITY_LABEL.urgent);
    assert.equal(buildFindingGuidance(finding({ severity: "informative" })).prioridade, FINDING_SEVERITY_LABEL.informative);
  });

  test("a UI usa a escala partilhada, e nao uma copia local", () => {
    assert.ok(
      /FINDING_SEVERITY_LABEL/.test(source),
      "o Dashboard tem de usar a escala de shared-types, nao duplicar rotulos",
    );
  });
});
