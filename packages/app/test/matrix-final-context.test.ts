/**
 * TP-MATRIX-FINAL-UI — contexto local e âmbito do payload.
 *
 * Quatro blocos pedidos: MEDIDO / HIPÓTESE / NÃO CONFIRMADO / AÇÃO SEGURA.
 * Uma explicação de UMA instância não pode levar o Top5 inteiro; a pergunta da
 * máquina é outro âmbito. Freebuff/Maestri só recebem narrativa quando a MESMA
 * instância tem >= 3 amostras — estabilidade da instância, não identidade do
 * software nem prova da operação.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildProcessLocalReply,
  buildProcessMatrixContext,
  familiaDoProcesso,
  narrativaDaFamilia,
  processPayload,
} from "../src/lib/processMatrix.ts";

const INICIO_BRAVE = "2026-10-23T08:00:00.0000000Z";
const INICIO_WMI = "2026-10-23T09:14:07.1234567Z";
const INICIO_DEFENDER = "2026-10-23T07:00:00.0000000Z";
const INICIO_MEM = "2026-09-01T10:00:00.0000000Z";
const INICIO_DESCONHECIDO = "2026-10-23T06:00:00.0000000Z";
const INICIO_FREEBUFF = "2026-10-23T06:30:00.0000000Z";

const TOP = [
  { pid: 900, name: "brave.exe", startedAt: INICIO_BRAVE, cpuPercent: 22, workingSetMb: 1800 },
  { pid: 901, name: "brave.exe", startedAt: "2026-10-23T08:01:00.0000000Z", cpuPercent: 3, workingSetMb: 250 },
  { pid: 902, name: "brave.exe", startedAt: "2026-10-23T08:02:00.0000000Z", cpuPercent: 2, workingSetMb: 180 },
  { pid: 15112, name: "WmiPrvSE.exe", startedAt: INICIO_WMI, cpuPercent: 62.4, workingSetMb: 118.4 },
  { pid: 600, name: "MsMpEng.exe", startedAt: INICIO_DEFENDER, cpuPercent: 4, workingSetMb: 320 },
];

function diagnostico(over: Record<string, unknown> = {}) {
  return {
    measuredAt: "2026-10-23T09:20:00.000Z",
    ram: { totalMb: 16384, usedMb: 15000, availableMb: 1384 },
    cpuPercent: 88,
    topProcesses: TOP,
    trends: [
      { pid: 900, startedAt: INICIO_BRAVE, previousMb: 1500, currentMb: 1800, deltaMb: 300, intervalMs: 60000, samples: 3 },
    ],
    observations: [],
    recommendations: ["Guardar o trabalho antes de fechar normalmente uma aplicação."],
    limitations: ["Working Set não é memória privada ou exclusiva."],
    ...over,
  } as never;
}

const brave = TOP[0];
const wmi = TOP[3];
const defender = TOP[4];
const desconhecido = { pid: 777, name: "appdesconhecida.exe", startedAt: INICIO_DESCONHECIDO, cpuPercent: 30, workingSetMb: 400 };

const semAlarme = (texto: string) => assert.doesNotMatch(
  texto,
  /(está|foi|é) (infetado|malware)|ameaça confirmada|fuga de memória confirmada|\bNormal\b/i,
);

test("F1 — quatro blocos determinísticos, sem os rótulos antigos, com RAM/CPU globais", () => {
  const texto = buildProcessLocalReply(diagnostico(), 900, brave as never);
  assert.match(texto, /^\*\*MEDIDO:\*\*/m);
  assert.match(texto, /^\*\*HIPÓTESE:\*\*/m);
  assert.match(texto, /^\*\*NÃO CONFIRMADO:\*\*/m);
  assert.match(texto, /^\*\*AÇÃO SEGURA:\*\*/m);
  assert.match(texto, /RAM utilizada: 15000 MB de 16384 MB/);
  assert.match(texto, /RAM disponível: 1384 MB/);
  assert.match(texto, /CPU global: 88\.0%/);
  assert.doesNotMatch(texto, /DADO OBSERVADO|HIPÓTESE \/ CONTEXTO|FALTA MEDIR|RECOMENDAÇÃO/);
});

test("F2 — Brave com carga alta: mede, explica multiprocesso e não atribui culpa", () => {
  const texto = buildProcessLocalReply(diagnostico(), 900, brave as never);
  assert.match(texto, /separadores, extensões e processos auxiliares/);
  assert.match(texto, /não atribuem culpa/i);
  assert.match(texto, /3 processos com este nome/);
  assert.match(texto, /soma do Working Set não é memória exclusiva/);
  assert.match(texto, /Working Set: 1500 → 1800 MB/);
  assert.match(texto, /Resumo medido: .*11,0% da RAM física.*inclui páginas partilhadas; não é memória exclusiva.*8,4% do total.*cresceu 300 MB/);
  assert.match(texto, /o Working Set cresceu 300 MB/);
  assert.doesNotMatch(texto, /leak|anormal|crítico|crítica/i);
  semAlarme(texto);
});

test("F3 — Brave normal (sem tendência): não afirma pressão nem normalidade", () => {
  const texto = buildProcessLocalReply(diagnostico({ trends: [] }), 901, TOP[1] as never);
  assert.match(texto, /Tendência deste processo: A recolher dados\. Uma amostra isolada não é tendência\./);
  assert.match(texto, /Estado: \*\*não concludente\*\*/);
  assert.match(texto, /Pressão de memória não é confirmável/);
  assert.match(texto, /Resumo medido: .*1,5% da RAM física.*8,4% do total; sem janela válida \(menos de 3 amostras ou intervalo insuficiente\), não se afirma direção nem se assume normalidade\./);
  assert.doesNotMatch(texto, /cresceu|diminuiu|ficou estável/);
  semAlarme(texto);
});

test("F12 — Brave normal vs alta exercita a decisão contextual, não só números", () => {
  const alto = buildProcessLocalReply(diagnostico(), 900, brave as never);
  const normal = buildProcessLocalReply(diagnostico({ trends: [] }), 901, TOP[1] as never);
  assert.notEqual(alto, normal, "o resumo contextual tem de distinguir os dois casos");
  assert.match(alto, /11,0% da RAM física/);
  assert.match(alto, /o Working Set cresceu 300 MB/);
  assert.match(normal, /1,5% da RAM física/);
  assert.match(alto, /8,4% do total/);
  assert.match(normal, /8,4% do total/);
  assert.doesNotMatch(normal, /cresceu 300 MB/);

  // O resumo não é só o mesmo texto com outros números: a DECISÃO muda com a
  // janela válida. Alta: há direção medida; normal: não se afirma direção.
  assert.match(alto, /Resumo medido: .*Working Set = 11,0% da RAM física \(inclui páginas partilhadas; não é memória exclusiva nem percentagem exclusiva do processo\); RAM disponível = 8,4% do total; na janela válida de 60 s \(3 amostras da MESMA instância\), o Working Set cresceu 300 MB; é uma comparação medida, não um juízo de desempenho nem uma causa\./);
  assert.match(normal, /Resumo medido: .*Working Set = 1,5% da RAM física \(inclui páginas partilhadas; não é memória exclusiva nem percentagem exclusiva do processo\); RAM disponível = 8,4% do total; sem janela válida \(menos de 3 amostras ou intervalo insuficiente\), não se afirma direção nem se assume normalidade\./);
  assert.doesNotMatch(alto, /não se afirma direção/);
  assert.doesNotMatch(normal, /o Working Set cresceu/);
  assert.doesNotMatch(alto + normal, /leak|anormal|crítico|crítica/i);

  // As três direções só existem na janela válida; nenhuma delas vira rótulo.
  const estavel = buildProcessLocalReply(
    diagnostico({ trends: [{ pid: 900, startedAt: INICIO_BRAVE, previousMb: 1800, currentMb: 1800, deltaMb: 0, intervalMs: 60000, samples: 3 }] }),
    900,
    brave as never,
  );
  assert.match(estavel, /Resumo medido: .*o Working Set ficou estável; é uma comparação medida, não um juízo de desempenho nem uma causa\./);
  assert.doesNotMatch(estavel, /cresceu|diminuiu/);

  const queda = buildProcessLocalReply(
    diagnostico({ trends: [{ pid: 900, startedAt: INICIO_BRAVE, previousMb: 1800, currentMb: 1700, deltaMb: -100, intervalMs: 60000, samples: 3 }] }),
    900,
    brave as never,
  );
  assert.match(queda, /Resumo medido: .*o Working Set diminuiu 100 MB; é uma comparação medida, não um juízo de desempenho nem uma causa\./);
  assert.doesNotMatch(queda, /cresceu|ficou estável/);

  const semMargem = buildProcessLocalReply(
    diagnostico({ trends: [], ram: { totalMb: 16384, usedMb: 15000, availableMb: null } }),
    901,
    TOP[1] as never,
  );
  assert.match(semMargem, /Resumo medido: .*sem leitura de RAM disponível nesta amostra, não se afirma folga; sem janela válida/);

  const janelaCurta = buildProcessLocalReply(
    diagnostico({
      trends: [{ pid: 900, startedAt: INICIO_BRAVE, previousMb: 1500, currentMb: 1800, deltaMb: 300, intervalMs: 1000, samples: 2 }],
    }),
    900,
    brave as never,
  );
  assert.match(janelaCurta, /Resumo medido: .*sem janela válida/);
  assert.doesNotMatch(janelaCurta, /Resumo medido: .*na janela válida/);
  assert.doesNotMatch(janelaCurta, /cresceu 300 MB/);
});

test("F4 — famílias por basename exacto; node/electron continuam desconhecidos", () => {
  for (const n of ["brave.exe", "chrome.exe", "msedge.exe", "opera.exe", "opera_gx.exe", "firefox.exe"]) {
    assert.equal(familiaDoProcesso(n), "navegador", n);
  }
  assert.equal(familiaDoProcesso("Discord.exe"), "discord");
  assert.equal(familiaDoProcesso("wmiprvse.exe"), "wmi");
  assert.equal(familiaDoProcesso("MsMpEng.exe"), "defender");
  assert.equal(familiaDoProcesso("Memory Compression"), "memory-compression");
  assert.equal(familiaDoProcesso("node.exe", true), "desconhecido");
  assert.equal(familiaDoProcesso("electron.exe", true), "desconhecido");
  assert.equal(familiaDoProcesso("freebuff-updater.exe", true), "desconhecido");
  assert.equal(familiaDoProcesso("Freebuff.exe"), "desconhecido", "sem estabilidade não há narrativa");
  assert.equal(familiaDoProcesso("Freebuff.exe", true), "ferramenta-ia");
  assert.equal(familiaDoProcesso("maestri.exe", true), "ferramenta-ia");
});

test("F5 — WMI e Defender não são alvo de encerramento; Memory Compression não infere leak", () => {
  const wmiTexto = buildProcessLocalReply(diagnostico(), 15112, wmi as never);
  assert.match(wmiTexto, /WmiPrvSE\.exe é o anfitrião de fornecedores WMI/);
  assert.match(wmiTexto, /As medições desta própria app usam WMI/);
  assert.match(wmiTexto, /Não encerrar/i);

  const defenderTexto = buildProcessLocalReply(diagnostico(), 600, defender as never);
  assert.match(defenderTexto, /Microsoft Defender/);
  assert.match(defenderTexto, /não confirma uma análise em curso/);
  assert.match(defenderTexto, /Não encerrar nem desativar/);

  const memoria = { pid: 968, name: "Memory Compression", startedAt: INICIO_MEM, cpuPercent: 3, workingSetMb: 1950 };
  const memTexto = buildProcessLocalReply(diagnostico({ topProcesses: [memoria] as never }), 968, memoria as never);
  assert.match(memTexto, /não é o tamanho da memória comprimida/);
  assert.match(memTexto, /não confirma fuga/);
  assert.doesNotMatch(memTexto, /fuga de memória confirmada|\bNormal\b/);
});

test("F6 — desconhecido só mostra o que foi medido", () => {
  const texto = buildProcessLocalReply(diagnostico({ trends: [] }), 777, desconhecido as never);
  assert.match(texto, /Não há informação suficiente para atribuir uma função/);
  assert.match(texto, /appdesconhecida\.exe \(PID 777\)/);
  assert.match(texto, /400 MB/);
  semAlarme(texto);
});

test("F7 — Freebuff/Maestri: >= 3 amostras provam estabilidade da instância, não identidade do software", () => {
  const freebuff = { pid: 700, name: "Freebuff.exe", startedAt: INICIO_FREEBUFF, cpuPercent: 10, workingSetMb: 400 };
  const trend = {
    pid: 700, startedAt: INICIO_FREEBUFF, previousMb: 300, currentMb: 400,
    deltaMb: 100, intervalMs: 60000, samples: 3,
  };
  const estavel = buildProcessLocalReply(
    diagnostico({ topProcesses: [freebuff], trends: [trend] }),
    700,
    freebuff as never,
  );
  assert.match(estavel, /basename do executável corresponde a Freebuff ou Maestri/);
  assert.match(estavel, /desenvolvimento\/automação/);
  assert.match(estavel, /tarefas intensivas podem usar CPU e RAM/);
  assert.match(estavel, /não confirmam que o software é aquela ferramenta/);
  assert.match(estavel, /não confirmam.*operação em curso/);
  assert.match(estavel, /Não encerrar sem guardar/);
  assert.doesNotMatch(estavel, /Freebuff está|está a compilar|está a executar um modelo|comunicar com/);

  const semEstabilidade = buildProcessLocalReply(
    diagnostico({ topProcesses: [freebuff], trends: [] }),
    700,
    freebuff as never,
  );
  assert.match(semEstabilidade, /Não há informação suficiente para atribuir uma função/);
  assert.doesNotMatch(semEstabilidade, /basename do executável corresponde/);

  const maestri = { pid: 701, name: "maestri.exe", startedAt: INICIO_FREEBUFF, cpuPercent: 2, workingSetMb: 200 };
  const maestriSemTrend = buildProcessLocalReply(
    diagnostico({ topProcesses: [maestri], trends: [] }),
    701,
    maestri as never,
  );
  assert.match(maestriSemTrend, /Não há informação suficiente para atribuir uma função/);
});

test("F8 — payload REAL de alvo explícito leva só a instância autorizada; máquina é outro âmbito", () => {
  const B = { pid: 4712, name: "chrome.exe", startedAt: "2026-10-23T08:05:00.0000000Z", cpuPercent: 12, workingSetMb: 900 };
  const trendB = {
    pid: 4712, startedAt: B.startedAt, previousMb: 800, currentMb: 900,
    deltaMb: 100, intervalMs: 60000, samples: 3,
  };
  const base = diagnostico({
    topProcesses: [wmi, B],
    trends: [
      { pid: 15112, startedAt: INICIO_WMI, previousMb: 100, currentMb: 118.4, deltaMb: 18.4, intervalMs: 60000, samples: 3 },
      trendB,
    ],
  });
  const contexto = buildProcessMatrixContext(base, 15112, wmi as never);
  const payload = processPayload(contexto, true);
  const json = JSON.stringify(payload);

  assert.ok(json.includes("WmiPrvSE.exe"));
  assert.ok(json.includes("15112"));
  assert.ok(!json.includes("chrome.exe"), "o outro processo não pode viajar com o alvo autorizado");
  assert.ok(!json.includes("4712"));
  assert.ok(!json.includes(B.startedAt), "nem o instante do outro alvo");
  assert.deepEqual(contexto.topProcesses.map((p) => p.pid), [15112]);
  assert.deepEqual(contexto.trends.map((t) => t.pid), [15112]);
  assert.equal(contexto.selectedProcess?.pid, 15112);
  assert.equal(contexto.ram.usedMb, 15000, "RAM global continua no âmbito explícito");
  assert.equal(contexto.cpuPercent, 88, "CPU global continua no âmbito explícito");

  const maquina = buildProcessMatrixContext(base, undefined, undefined);
  assert.equal(maquina.selectedProcess, null);
  assert.equal(maquina.topProcesses.length, 2, "a pergunta da máquina mantém o Top5: é outro âmbito");
});

test("F9 — outro instante do mesmo PID não herda tendência", () => {
  const outra = { ...brave, startedAt: "2026-10-23T08:00:00.0010000Z" };
  const texto = buildProcessLocalReply(diagnostico(), 900, outra as never);
  assert.match(texto, /Tendência deste processo: A recolher dados/);
  assert.doesNotMatch(texto, /1500 → 1800/);
});

test("F11 — abrir/Explicar local não sonda o fornecedor: descriptor local, zero chat", () => {
  const fonte = readFileSync(new URL("../src/components/AIAssistant.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(fonte, /\/api\/ai\/status/, "abrir o painel não pode chamar a rota que sonda o fornecedor");
  assert.doesNotMatch(fonte, /\.status\(\)/, "a sonda de disponibilidade saiu do caminho local");
  assert.match(fonte, /lerConsentimento\(API_BASE/, "a informação vem do descriptor local");
  assert.match(fonte, /aplicarConsentimentoExterno/, "o efeito de abertura lê só metadados locais");

  const efeitoAbertura = fonte.match(/if \(!isOpen\) return\s*let cancelled = false[\s\S]*?\}, \[isOpen[^\]]*\]\)/)?.[0] ?? "";
  assert.ok(efeitoAbertura.length > 0, "o efeito de abertura tem de existir");
  assert.doesNotMatch(efeitoAbertura, /\/api\/ai\/chat/, "abrir não envia chat");
  assert.doesNotMatch(efeitoAbertura, /setMode\(/, "abrir não decide disponibilidade generativa");
  assert.doesNotMatch(efeitoAbertura, /localUntilRef\.current\s*=/, "abrir não arma cooldown de fornecedor");
  assert.match(efeitoAbertura, /lerConsentimento\(API_BASE/, "só o descriptor local é lido");
  assert.match(efeitoAbertura, /aplicarConsentimentoExterno/, "o resultado é metadado local, não uma resposta do fornecedor");
  assert.match(fonte, /setFornecedor\(next\.descriptor\?\.providerLabel/, "o rótulo vem do descriptor, nunca da chave");

  // A resposta local é determinística e não recebe nem pode depender do descriptor.
  const local = buildProcessLocalReply(diagnostico(), 900, brave as never);
  assert.match(local, /^\*\*DIAGNÓSTICO LOCAL\*\*/);
  assert.doesNotMatch(local, /fetch|api\/ai|fornecedor respondeu/i);
});

test("F10 — narrativa de família não inventa operação", () => {
  assert.match(narrativaDaFamilia("ferramenta-ia").explicacao, /correspondência de NOME/);
  assert.match(narrativaDaFamilia("ferramenta-ia").explicacao, /desenvolvimento\/automação/);
  assert.match(narrativaDaFamilia("ferramenta-ia").explicacao, /tarefas intensivas podem usar CPU e RAM/);
  assert.doesNotMatch(narrativaDaFamilia("ferramenta-ia").explicacao, /está a compilar|está a executar um modelo|comunicar com/, "não inventar a operação");
  assert.match(narrativaDaFamilia("ferramenta-ia").falta, /linha de comando \(nunca enviada\)/);
  assert.match(narrativaDaFamilia("desconhecido").explicacao, /Só os valores observados são factos/);
});
