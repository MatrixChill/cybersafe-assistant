/**
 * Testes do estado da tray: três estados a partir de factos reais.
 *
 * A regra que estes testes protegem é a que o resto do produto pode quebrar em
 * silêncio: "sem threats" não é o mesmo que "protegido", e "não sabemos" não
 * é o mesmo que "desligado".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  trayProtectionLevel,
  trayTooltip,
  buildTrayMenuTemplate,
  TRAY_LEVEL_LABELS,
} from "../src/tray-menu.ts";

const base = { serviceRunning: true, status: null, score: null, threats: null, quarantine: null };

test("PROTEGIDO só quando o motor confirma a proteção ligada", () => {
  assert.equal(
    trayProtectionLevel({ ...base, status: "safe", protectionEnabled: true }),
    "protected",
  );
});

test("proteção desligada nunca é 'protected', mesmo com status safe e zero ameaças", () => {
  // Este é o bug que os três estados vieram fechar: sem ameaças, status safe.
  assert.equal(
    trayProtectionLevel({ ...base, status: "safe", protectionEnabled: false }),
    "unprotected",
  );
  assert.equal(
    trayProtectionLevel({ ...base, status: "safe", protectionEnabled: false, threats: 0 }),
    "unprotected",
  );
});

test("status safe SEM o motor confirmar não dá 'protected' (ausência de prova)", () => {
  assert.equal(trayProtectionLevel({ ...base, status: "safe" }), "attention");
  assert.equal(
    trayProtectionLevel({ ...base, status: "safe", protectionEnabled: null }),
    "attention",
  );
});

test("serviço parado = não protegido (facto, não falta de informação)", () => {
  assert.equal(
    trayProtectionLevel({ ...base, serviceRunning: false, status: "safe", protectionEnabled: true }),
    "unprotected",
  );
});

test("desconhecido não é 'desligado': serviço de pé sem dados dá atenção", () => {
  assert.equal(trayProtectionLevel({ ...base, status: null }), "attention");
  assert.equal(trayProtectionLevel({ ...base, status: "  " }), "attention");
  assert.equal(trayProtectionLevel({ ...base, status: "inventado" }), "attention");
});

test("degraded ≠ active: motor degradado dá atenção, nunca protegido", () => {
  assert.equal(
    trayProtectionLevel({ ...base, status: "degraded", protectionEnabled: true }),
    "attention",
  );
  assert.equal(
    trayProtectionLevel({ ...base, status: "attention", protectionEnabled: true }),
    "attention",
  );
});

test("critical dá não protegido mesmo com a proteção ligada", () => {
  assert.equal(
    trayProtectionLevel({ ...base, status: "critical", protectionEnabled: true }),
    "unprotected",
  );
});

test("leitura de falha não pode virar 'desligada'", () => {
  // refreshTrayProtectionInfo põe protectionEnabled: null quando a leitura falha.
  assert.equal(
    trayProtectionLevel({ ...base, status: null, protectionEnabled: null }),
    "attention",
  );
});

test("tooltip segue o estado e nunca vaza enum", () => {
  assert.equal(
    trayTooltip("protected"),
    "CyberSafe Assistant — Protegido",
  );
  assert.equal(
    trayTooltip("unprotected"),
    "CyberSafe Assistant — Não protegido",
  );
  assert.equal(
    trayTooltip("attention"),
    "CyberSafe Assistant — Precisa de atenção",
  );
});

test("tooltip em pausa dá o prazo real", () => {
  const until = new Date(Date.now() + 15 * 60_000).toISOString();
  const tip = trayTooltip("unprotected", until);
  assert.match(tip, /pausa/i);
  assert.match(tip, /15 min/);
});

test("rótulos PT-PT cobrem os três estados", () => {
  assert.deepEqual(Object.keys(TRAY_LEVEL_LABELS).sort(), [
    "attention",
    "protected",
    "unprotected",
  ]);
});

test("menu mostra UMA ativação só quando não há proteção E há handler (nunca duplicada)", () => {
  const info = { ...base, status: "critical", protectionEnabled: false };

  const semHandler = buildTrayMenuTemplate(info, { open() {}, exit() {} });
  assert.ok(
    !semHandler.some((i) => i.label === "Ativar proteção" || i.label === "Ativar proteção agora"),
    "sem handler real, não há item que finja ativar",
  );

  const comHandler = buildTrayMenuTemplate(info, {
    open() {},
    exit() {},
    startProtection() {},
    pauseProtection() {},
  });
  const activations = comHandler.filter(
    (i) => i.label === "Ativar proteção" || i.label === "Ativar proteção agora",
  );
  assert.equal(activations.length, 1, "exatamente uma ação de ativação, nunca duas");
  assert.equal(activations[0].label, "Ativar proteção");
});

test("menu de proteção só oferece pausas quando há handler de pausa", () => {
  const protegido = { ...base, status: "safe", protectionEnabled: true };

  const semPausa = buildTrayMenuTemplate(protegido, {
    open() {},
    exit() {},
    startProtection() {},
  });
  assert.ok(!semPausa.some((i) => i.label === "Pausar 15 minutos"));

  const comPausa = buildTrayMenuTemplate(protegido, {
    open() {},
    exit() {},
    startProtection() {},
    pauseProtection() {},
  });
  assert.ok(comPausa.some((i) => i.label === "Pausar 15 minutos"));
  assert.ok(comPausa.some((i) => i.label === "Pausar 1 hora"));
});

test("menu nunca mostra pausa quando a proteção já está desligada", () => {
  const off = { ...base, status: "critical", protectionEnabled: false };
  const items = buildTrayMenuTemplate(off, {
    open() {},
    exit() {},
    startProtection() {},
    pauseProtection() {},
  });
  assert.ok(!items.some((i) => i.label === "Pausar 15 minutos"));
  assert.ok(items.some((i) => i.label === "Ativar proteção"));
});

test("o menu mostra sempre os contadores reais e omite os ausentes", () => {
  const items = buildTrayMenuTemplate(
    { ...base, status: "safe", protectionEnabled: true, threats: 2, quarantine: 5 },
    { open() {}, exit() {} },
  );
  const labels = items.map((i) => i.label);
  assert.ok(labels.includes("Ameaças recentes: 2"));
  assert.ok(labels.includes("Em quarentena: 5"));

  const semDados = buildTrayMenuTemplate(
    { ...base, status: "safe", protectionEnabled: true },
    { open() {}, exit() {} },
  );
  assert.ok(!semDados.some((i) => String(i.label).startsWith("Ameaças recentes")));
});

// ── P1 REALTIME PROTECTION / TRAY ──────────────────────────────────────────
//
// Estado MEDIDO nesta máquina (scripts/protection-toggle-probe.mjs):
//   monitor.start -> {ok:true, protectionEnabled:true}
//   protection.getState -> protectionEnabled:true, status="degraded"
// porque o YARA só tem corpus de teste e o filtro WFP está inativo.
//
// O menu trocava de ramo apenas quando o ní­vel era "protected", isto é, exigia
// TODOS os motores verdes para parar de oferecer "Ativar proteção". Com a
// proteção LIGADA mas degradada, o item continuava lá­ e o clique do utilizador
// parecia não fazer nada — o bug reportado.

const handlersCompletos = () => ({
  open() {},
  exit() {},
  startProtection() {},
  stopProtection() {},
  pauseProtection() {},
});

const labels = (items) => items.map((i) => i.label);

test("RED: proteção LIGADA e degradada não pode continuar a oferecer 'Ativar proteção'", () => {
  const ligadaDegradada = { ...base, status: "degraded", protectionEnabled: true };
  const items = buildTrayMenuTemplate(ligadaDegradada, handlersCompletos());

  assert.ok(
    !labels(items).includes("Ativar proteção"),
    "com o motor a confirmar a proteção, oferecer 'Ativar proteção' outra vez é um no-op — o clique parecia não fazer nada",
  );
  assert.ok(labels(items).includes("Proteção em tempo real — Ativa"));
  assert.ok(labels(items).includes("Pausar 15 minutos"));
  assert.ok(labels(items).includes("Pausar 1 hora"));
  assert.ok(labels(items).includes("Desligar até ativação manual"));
});

test("proteção LIGADA e saudá­vel tem o mesmo ramo (sem regressão)", () => {
  const items = buildTrayMenuTemplate(
    { ...base, status: "safe", protectionEnabled: true },
    handlersCompletos(),
  );
  assert.ok(!labels(items).includes("Ativar proteção"));
  assert.ok(labels(items).includes("Proteção em tempo real — Ativa"));
  assert.ok(labels(items).includes("Pausar 15 minutos"));
});

test("proteção DESLIGADA diz 'Desativada' e oferece ativar, nunca pausar", () => {
  const items = buildTrayMenuTemplate(
    { ...base, status: "critical", protectionEnabled: false },
    handlersCompletos(),
  );
  assert.ok(labels(items).includes("Proteção em tempo real — Desativada"));
  assert.ok(labels(items).includes("Ativar proteção"));
  assert.ok(!labels(items).includes("Pausar 15 minutos"));
  assert.ok(!labels(items).includes("Desligar até ativação manual"));
});

test("estado desconhecido nunca afirma 'Ativa' nem 'Desativada'", () => {
  // Leitura falhada (protectionEnabled: null): o menu não pode inventar o facto.
  const items = buildTrayMenuTemplate(
    { ...base, status: null, protectionEnabled: null },
    handlersCompletos(),
  );
  assert.ok(labels(items).includes("Proteção em tempo real — Indisponível"));
  assert.ok(!labels(items).includes("Proteção em tempo real — Ativa"));
  assert.ok(!labels(items).includes("Proteção em tempo real — Desativada"));
  assert.ok(!labels(items).includes("Pausar 15 minutos"));
});

test("proteção ligada sem handler de pausa não oferece pausas (nem mente)", () => {
  const items = buildTrayMenuTemplate(
    { ...base, status: "degraded", protectionEnabled: true },
    { open() {}, exit() {}, startProtection() {} },
  );
  assert.ok(labels(items).includes("Proteção em tempo real — Ativa"));
  assert.ok(!labels(items).includes("Pausar 15 minutos"));
  assert.ok(!labels(items).includes("Ativar proteção"));
});

test("nenhum item do menu expõe o enum interno", () => {
  const items = buildTrayMenuTemplate(
    { ...base, status: "degraded", protectionEnabled: true },
    { open() {}, exit() {}, startProtection() {}, pauseProtection() {} },
  );
  for (const i of items) {
    if (typeof i.label !== "string") continue;
    assert.ok(
      !/\b(safe|attention|degraded|critical|warning)\b/.test(i.label),
      `vaza enum interno: "${i.label}"`,
    );
  }
});

// ── REGRESSÃO Teste 3 (pausa de 15 min, 09/10) ──────────────────────────────
// Medido: durante a pausa a tray mostrava ao mesmo tempo "Em pausa",
// "Desativada", "Ativar proteção agora" E "Ativar proteção". Quatro linhas
// contraditórias. Estes testes fixam o contrato novo: UMA linha de estado,
// NENHUMA ativação duplicada, tempo restante real e UMA retoma ligada ao
// contrato efetivo (startProtection -> monitor.start).

const emPausa = () => ({
  ...base,
  status: "paused",
  protectionEnabled: false,
  pausedUntil: new Date(Date.now() + 15 * 60_000).toISOString(),
});

const stateLines = (items) =>
  items.filter((i) => typeof i.label === "string" && i.label.startsWith("Proteção em tempo real —"));

test("pausa: exatamente UMA linha de estado em tempo real, com prazo real", () => {
  const items = buildTrayMenuTemplate(emPausa(), handlersCompletos());
  const line = stateLines(items);
  assert.equal(line.length, 1, `esperada 1 linha de estado: ${JSON.stringify(labels(items))}`);
  assert.match(line[0].label, /Em pausa/);
  assert.match(line[0].label, /daqui a 15 min/);
});

test("pausa: nunca 'Desativada', nem pausa a duplicar, nem ativação a dobrar", () => {
  const ls = labels(buildTrayMenuTemplate(emPausa(), handlersCompletos()));
  assert.ok(!ls.includes("Proteção em tempo real — Desativada"), "pausa não é desligada");
  assert.ok(!ls.includes("Ativar proteção agora"), "sem ação de topo duplicada");
  assert.ok(!ls.includes("Pausar 15 minutos") && !ls.includes("Pausar 1 hora"), "não oferece pausa já pausada");
  const activations = ls.filter((l) => l === "Ativar proteção" || l === "Ativar proteção agora" || l === "Retomar proteção agora");
  assert.equal(activations.length, 1, `uma só ação de retoma/ativação: ${JSON.stringify(ls)}`);
});

test("pausa: UMA retoma ligada ao handler real de ativação", () => {
  let started = 0;
  const items = buildTrayMenuTemplate(emPausa(), {
    open() {},
    exit() {},
    startProtection() { started += 1; },
    stopProtection() {},
    pauseProtection() {},
  });
  const acts = items.filter(
    (i) => i.label === "Retomar proteção agora" || i.label === "Ativar proteção",
  );
  assert.equal(acts.length, 1);
  assert.equal(acts[0].label, "Retomar proteção agora");
  acts[0].click();
  assert.equal(started, 1, "a retoma dispara o contrato real (startProtection/monitor.start)");
});

test("pausa sem handler de ativação: estado mostrado, nenhuma ação falsa", () => {
  const ls = labels(buildTrayMenuTemplate(emPausa(), { open() {}, exit() {} }));
  assert.ok(ls.some((l) => typeof l === "string" && l.startsWith("Proteção em tempo real — Em pausa")));
  assert.ok(!ls.includes("Retomar proteção agora"), "sem contrato real, sem item que finja retomar");
});

test("quaisquer que sejam os factos: no máximo UMA linha de estado em tempo real", () => {
  const cenarios = [
    { ...base, status: "safe", protectionEnabled: true },
    { ...base, status: "critical", protectionEnabled: false },
    { ...base, status: null, protectionEnabled: null },
    emPausa(),
    { ...emPausa(), pendingAction: "starting" },
  ];
  for (const c of cenarios) {
    const n = stateLines(buildTrayMenuTemplate(c, handlersCompletos())).length;
    assert.ok(n <= 1, `no máximo 1 linha de estado, obtida ${n} em ${JSON.stringify(c)}`);
  }
});

test("nenhum rótulo de pausa/retoma vaza o enum interno 'paused'", () => {
  const ls = labels(buildTrayMenuTemplate(emPausa(), handlersCompletos()));
  for (const l of ls) {
    assert.ok(!/\bpaused\b/i.test(String(l)), `vaza enum: "${l}"`);
  }
});