import { test } from "node:test";
import assert from "node:assert/strict";

import { classificarLeitura, resumoSync, GATE_PREFIXO } from "../src/lib/serviceSyncStatus";

// O que este ficheiro fixa é a DISTINÇÃO que o ciclo de sincronização não fazia:
// uma recusa deliberada do gate de fixture não é uma falha de sincronização, e
// uma falha real não pode esconder-se atrás de uma recusa. Fonte da prefixo:
// packages/service/src/dev-fixture-gate.ts (`GATE_CODE = "realdev_fixture_gate"`).

test("uma recusa do gate de fixture é `recusa`, nunca `falha`", () => {
  const erro = new Error(`${GATE_PREFIXO}: "protection.getState" não faz parte da sessão de fixture`);
  assert.equal(classificarLeitura({ status: "rejected", reason: erro }), "recusa");
});

test("uma falha real do bridge continua `falha` (o gate não serve de desculpa)", () => {
  assert.equal(
    classificarLeitura({ status: "rejected", reason: new Error("Service client disconnected") }),
    "falha",
  );
});

test("uma leitura resolvida é `ok` mesmo devolvendo null", () => {
  assert.equal(classificarLeitura({ status: "fulfilled", value: null }), "ok");
  assert.equal(classificarLeitura({ status: "fulfilled", value: { engine: {} } }), "ok");
});

test("com só recusas o ciclo NÃO marca falha de sincronização", () => {
  const resumo = resumoSync([
    classificarLeitura({ status: "rejected", reason: new Error(`${GATE_PREFIXO}: x`) }),
    classificarLeitura({ status: "rejected", reason: new Error(`${GATE_PREFIXO}: y`) }),
  ]);
  assert.equal(resumo.falhas, 0);
  assert.equal(resumo.recusas, 2);
  assert.equal(resumo.deveMarcarFalhaSync, false);
});

test("uma única falha real entre recusas marca falha de sincronização", () => {
  const resumo = resumoSync([
    classificarLeitura({ status: "fulfilled", value: 1 }),
    classificarLeitura({ status: "rejected", reason: new Error(`${GATE_PREFIXO}: x`) }),
    classificarLeitura({ status: "rejected", reason: new Error("pipe fechado") }),
  ]);
  assert.equal(resumo.ok, 1);
  assert.equal(resumo.recusas, 1);
  assert.equal(resumo.falhas, 1);
  assert.equal(resumo.deveMarcarFalhaSync, true);
});

test("sem qualquer leitura bem-sucedida o ciclo não tem dados para mostrar", () => {
  const soRecusas = resumoSync([classificarLeitura({ status: "rejected", reason: new Error(`${GATE_PREFIXO}: x`) })]);
  assert.equal(soRecusas.temLeituraUtil, false);
  const umaOk = resumoSync([
    classificarLeitura({ status: "fulfilled", value: {} }),
    classificarLeitura({ status: "rejected", reason: new Error(`${GATE_PREFIXO}: x`) }),
  ]);
  assert.equal(umaOk.temLeituraUtil, true);
});

test("recusa com texto diferente de string (reason sem message) não é engolida", () => {
  // Um rejection pode ser um objeto sem `message`; isso é uma falha, não uma
  // recusa — classificar em silêncio como recusa esconderia um erro real.
  assert.equal(classificarLeitura({ status: "rejected", reason: { codigo: 7 } as never }), "falha");
  assert.equal(classificarLeitura({ status: "rejected", reason: undefined }), "falha");
});

// ————— o envelope REAL do Electron —————
// `node_modules/electron@33.4.11`, template extraído do próprio `dist/electron.exe`:
//   const {error:r,result:n}=await o.invoke(s,e,t); if(r) throw new Error(`Error invoking remote method '${e}': ${r}`)
// Ou seja: o `reason` que chega ao renderer é um Error NOVO, cuja message começa por
// `Error invoking remote method '<canal>': ` e só DEPOIS traz a coerção do Error original
// (`String(new Error("x")) === "Error: x"`). O prefixo do gate nunca está no início.
// Estes casos existem porque o resto deste ficheiro injeta a rejeição já despida,
// que é exatamente o estado que a ponte real nunca entrega.
const envelope = (canal: string, erro: Error) =>
  new Error(`Error invoking remote method '${canal}': ${erro}`);
const MOTIVO_GATE = `"protection.getState" não faz parte da sessão de fixture (sem proteção, sem efeitos no sistema)`;

test("recusa do gate envelopada pelo Electron, em canal real da snapshot, é `recusa`", () => {
  // O canal é a grafia canónica do `preload.ts`; o motivo tem as aspas reais do serviço.
  assert.equal(
    classificarLeitura({
      status: "rejected",
      reason: envelope("service:get-protection-state", new Error(`${GATE_PREFIXO}: ${MOTIVO_GATE}`)),
    }),
    "recusa",
  );
  // Cada um dos sete canais da snapshot, com o mesmo motivo.
  for (const canal of [
    "service:get-protection-state",
    "service:get-events",
    "service:get-threats",
    "service:get-processes",
    "service:get-connections",
    "service:get-quarantine",
    "service:get-pcstate",
  ]) {
    assert.equal(
      classificarLeitura({ status: "rejected", reason: envelope(canal, new Error(`${GATE_PREFIXO}: ${MOTIVO_GATE}`)) }),
      "recusa",
      `o envelope de ${canal} tem de contar como recusa`,
    );
  }
});

test("o marcador citado dentro de um erro real NÃO se torna recusa", () => {
  // Nenhuma `includes` ao marcador em qualquer posição: isto é o caso que um
  // relaxamento ingénuo engoliria — uma avaria que menciona o gate.
  assert.equal(
    classificarLeitura({
      status: "rejected",
      reason: new Error(`Service client disconnected depois de realdev_fixture_gate: x`),
    }),
    "falha",
  );
  assert.equal(
    classificarLeitura({ status: "rejected", reason: new Error(`ver ${GATE_PREFIXO}: tudo`) }),
    "falha",
  );
});

test("envelope com canal errado, ou fora da snapshot, é `falha`", () => {
  const erroGate = new Error(`${GATE_PREFIXO}: ${MOTIVO_GATE}`);
  // Canal que não existe na ponte:
  assert.equal(classificarLeitura({ status: "rejected", reason: envelope("service:nao-existe", erroGate) }), "falha");
  // Canal real mas que NÃO é uma das sete leituras da snapshot (não pode ser
  // admitido por hábito — a lista é cerrada):
  assert.equal(classificarLeitura({ status: "rejected", reason: envelope("service:get-hardware", erroGate) }), "falha");
  assert.equal(classificarLeitura({ status: "rejected", reason: envelope("app:get-auto-start", erroGate) }), "falha");
  // Envelope sem canal (aspas vazias):
  assert.equal(classificarLeitura({ status: "rejected", reason: new Error(`Error invoking remote method '': Error: ${GATE_PREFIXO}: x`) }), "falha");
});

test("lixo antes do envelope, envelope truncado ou malformed é `falha`", () => {
  const erroGate = new Error(`${GATE_PREFIXO}: ${MOTIVO_GATE}`);
  // Lixo antes:
  assert.equal(
    classificarLeitura({ status: "rejected", reason: new Error(`aviso: ${envelope("service:get-events", erroGate).message}`) }),
    "falha",
  );
  // Truncado a meio do nome do canal (sem aspas de fecho):
  assert.equal(
    classificarLeitura({ status: "rejected", reason: new Error(`Error invoking remote method 'service:get-events`) }),
    "falha",
  );
  // Truncado logo depois do canal:
  assert.equal(
    classificarLeitura({ status: "rejected", reason: new Error(`Error invoking remote method 'service:get-events'`) }),
    "falha",
  );
  // Malformed: sem a coerção `Error: ` do Error original, não é o envelope conhecido:
  assert.equal(
    classificarLeitura({ status: "rejected", reason: new Error(`Error invoking remote method 'service:get-events': ${GATE_PREFIXO}: x`) }),
    "falha",
  );
  // Malformed: outra classe no lugar de `Error`:
  assert.equal(
    classificarLeitura({ status: "rejected", reason: new Error(`Error invoking remote method 'service:get-events': TypeError: ${GATE_PREFIXO}: x`) }),
    "falha",
  );
});

test("envelope de falha real continua `falha` (o envelope não é salvo-conduto)", () => {
  for (const msg of ["Service client disconnected", "Service connection closed", "Service request failed", "pipe fechado pelo serviço"]) {
    assert.equal(
      classificarLeitura({ status: "rejected", reason: envelope("service:get-protection-state", new Error(msg)) }),
      "falha",
      `「${msg}」 tem de custar como falha real`,
    );
  }
});

test("as sete leituras recusadas em envelope não marcam falha de sincronização", () => {
  // O ciclo completo de fixture: pipe ligado, zero leituras, sete recusas — e ainda
  // assim a UI não pode dizer «não foi possível sincronizar».
  const canais = [
    "service:get-protection-state",
    "service:get-events",
    "service:get-threats",
    "service:get-processes",
    "service:get-connections",
    "service:get-quarantine",
    "service:get-pcstate",
  ];
  const resumo = resumoSync(
    canais.map((canal) =>
      classificarLeitura({ status: "rejected", reason: envelope(canal, new Error(`${GATE_PREFIXO}: ${MOTIVO_GATE}`)) }),
    ),
  );
  assert.equal(resumo.recusas, 7);
  assert.equal(resumo.falhas, 0);
  assert.equal(resumo.deveMarcarFalhaSync, false);
});

test("falha real entre recusas envelopadas continua a marcar falha", () => {
  const resumo = resumoSync([
    classificarLeitura({ status: "rejected", reason: envelope("service:get-events", new Error(`${GATE_PREFIXO}: x`)) }),
    classificarLeitura({ status: "rejected", reason: envelope("service:get-threats", new Error("Service client disconnected")) }),
    classificarLeitura({ status: "rejected", reason: envelope("service:get-processes", new Error(`${GATE_PREFIXO}: y`)) }),
  ]);
  assert.equal(resumo.recusas, 2);
  assert.equal(resumo.falhas, 1);
  assert.equal(resumo.deveMarcarFalhaSync, true);
});
