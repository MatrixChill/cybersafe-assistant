// Testes do subsistema ADL (GPU/CPU) e da honestidade de SMART.
//
// ATENÇÃO: todos os números neste ficheiro são FIXTURES de teste.
// Não são, e nunca devem ser apresentados como, temperaturas medidas no PC.
// A validação física real é feita por um script separado (integration) e os
// seus resultados são registados à parte.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";

import { AdlSensorProvider, adlCelsius, pickGpuSample } from "../dist/adl-provider.js";
import { readAdlSensors, resetAdlBridgeState } from "../dist/adl-bridge.js";
import { classifyCountersError, describeStorageHealth } from "../dist/storage-health.js";

const ACQUIRED = "2026-10-26T12:00:00.000Z";

const okReading = (samples, extra = {}) => ({
  status: "ok",
  reason: null,
  samples,
  acquiredAt: ACQUIRED,
  spawned: 1,
  ...extra,
});

const failedReading = (status, reason) => ({
  status,
  reason,
  samples: [],
  acquiredAt: ACQUIRED,
  spawned: 1,
});

const gpuAdapter = (over = {}) => ({
  adapterIndex: 1,
  udid: "PCI_VEN_0x1002&DEV_0x731F_1",
  adapterName: "AMD Radeon RX 5600 XT",
  displayName: "\\\\.\\DISPLAY1",
  busNumber: 8,
  deviceNumber: 0,
  present: true,
  active: 1,
  pmlog: {},
  od6Celsius: null,
  ...over,
});

const apuAdapter = (over = {}) =>
  gpuAdapter({
    adapterIndex: 0,
    udid: "PCI_VEN_0x1002&DEV_0x1640_0",
    adapterName: "AMD Radeon (TM) Graphics",
    displayName: "\\\\.\\DISPLAY0",
    busNumber: 7,
    deviceNumber: 0,
    ...over,
  });

const providerFrom = (reading) => new AdlSensorProvider(async () => reading);

// ── 1. CPU 45 °C e GPU 70 °C (fixtures) com origem, unidade e timestamp ──────
test("ADL fixture: CPU 45 °C e GPU 70 °C são publicados com sensor e timestamp", async () => {
  const reading = okReading([
    apuAdapter({ pmlog: { cpuC: 45, gpuCoreC: 33 } }),
    gpuAdapter({ pmlog: { gpuCoreC: 70, gpuHotspotC: 84, gpuMemoryC: 78 } }),
  ]);
  const out = await providerFrom(reading).read();

  assert.equal(out.cpuPackageC, 45);
  assert.match(out.cpuSensor, /AMD ADL PMLog TEMPERATURE_CPU/);
  // Não afirma "CPU Package" — afirma de onde veio.
  assert.doesNotMatch(out.cpuSensor, /Package/);

  assert.equal(out.gpuCoreC, 70);
  assert.match(out.gpuCoreSensor, /RX 5600 XT/);
  assert.equal(out.gpuHotspotC, 84);
  assert.equal(out.gpuMemoryJunctionC, 78);
  assert.equal(out.timestamp, ACQUIRED);
  assert.equal(out.source, "AMD ADL");
});

// ── 2/8/9. Leituras inválidas, negativas e de unidade errada nunca passam ────
test("adlCelsius rejeita 0, negativos, >150, unidades erradas e lixo", () => {
  assert.equal(adlCelsius(45), 45);
  assert.equal(adlCelsius(70.4), 70);
  for (const bad of [0, -1, -273, -40, 151, 300, 318 /* Kelvin disfarçado */, NaN, Infinity, "45abc", null, undefined, {}]) {
    assert.equal(adlCelsius(bad), null, `esperava null para ${String(bad)}`);
  }
});

test("ADL fixture: sensores inválidos ficam null, nunca 0 nem o valor bruto", async () => {
  const reading = okReading([
    gpuAdapter({ pmlog: { gpuCoreC: 0, gpuHotspotC: -12, gpuMemoryC: 900 }, od6Celsius: null }),
    apuAdapter({ pmlog: { cpuC: 400 } }),
  ]);
  const out = await providerFrom(reading).read();
  assert.equal(out.gpuCoreC, null);
  assert.equal(out.gpuHotspotC, null);
  assert.equal(out.gpuMemoryJunctionC, null);
  assert.equal(out.cpuPackageC, null);
  assert.equal(out.cpuSensor, null);
  assert.equal(out.fans.length, 0);
});

// ── 3/4/5/6. Provider ausente, timeout e erro não viram número ───────────────
for (const [label, reading] of [
  ["driver ausente", failedReading("unsupported", "dll-not-found")],
  ["biblioteca FFI ausente", failedReading("unsupported", "ffi-module-absent")],
  ["ADL não inicializa", failedReading("unsupported", "adl2-create-failed")],
  ["timeout", failedReading("timeout", "worker-timeout")],
  ["worker crashed", failedReading("error", "worker-signal-unknown")],
]) {
  test(`ADL indisponível (${label}): tudo null e estado registado`, async () => {
    const provider = providerFrom(reading);
    const out = await provider.read();
    assert.equal(out.cpuPackageC, null);
    assert.equal(out.gpuCoreC, null);
    assert.equal(out.gpuHotspotC, null);
    assert.equal(out.motherboard.length, 0);
    assert.equal(provider.lastStatus, reading.status);
    assert.equal(provider.lastReason, reading.reason);
    assert.equal(await provider.isAvailable(), false);
  });
}

// ── 10/11. Múltiplos adaptadores: a dedicada é a GPU, o CPU vem de quem o mede
test("pickGpuSample escolhe a dedicada e nunca rotula a iGPU como GPU", () => {
  const apu = apuAdapter({ pmlog: { cpuC: 45, gpuCoreC: 33 } });
  const dgpu = gpuAdapter({ pmlog: { gpuCoreC: 70 } });
  const chosen = pickGpuSample([apu, dgpu]);
  assert.equal(chosen.adapterName, "AMD Radeon RX 5600 XT");
  // Ordem invertida não muda a escolha: é regra, não índice.
  assert.equal(pickGpuSample([dgpu, apu]).adapterName, "AMD Radeon RX 5600 XT");
  assert.equal(pickGpuSample([]), null);
  // Só iGPU: é o que existe, e o rótulo diz qual é.
  assert.equal(pickGpuSample([apu]).adapterIndex, 0);
});

test("ADL fixture: iGPU dá a temperatura de CPU, dedicada dá a da GPU", async () => {
  const out = await providerFrom(
    okReading([apuAdapter({ pmlog: { cpuC: 52 } }), gpuAdapter({ pmlog: { gpuCoreC: 61 } })]),
  ).read();
  assert.equal(out.cpuPackageC, 52);
  assert.match(out.cpuSensor, /Radeon \(TM\) Graphics/);
  assert.equal(out.gpuCoreC, 61);
  assert.match(out.gpuCoreSensor, /RX 5600 XT/);
});

test("ADL fixture: fallback Overdrive6 quando o PMLog não tem GPU Core", async () => {
  const out = await providerFrom(okReading([gpuAdapter({ od6Celsius: 66 })])).read();
  assert.equal(out.gpuCoreC, 66);
  assert.equal(out.cpuPackageC, null);
});

test("ADL fixture: ventoinha publicada com RPM válido, rejeitada se impossível", async () => {
  const good = await providerFrom(okReading([gpuAdapter({ pmlog: { gpuCoreC: 50, fanRpm: 1200 } })])).read();
  assert.deepEqual(good.fans, [{ name: "GPU Fan (AMD ADL) @ AMD Radeon RX 5600 XT", rpm: 1200 }]);
  const bad = await providerFrom(okReading([gpuAdapter({ pmlog: { gpuCoreC: 50, fanRpm: 99999 } })])).read();
  assert.equal(bad.fans.length, 0);
});

// ── 12. VM: sem sensor físico, nada de zeros nem de sensores virtuais ────────
test("VM (fixture): adaptadores sem PMLog produzem unsupported e nenhuma temperatura", async () => {
  const reading = { ...okReading([gpuAdapter({ pmlog: {} })]), status: "unsupported", reason: "no-adapters", samples: [] };
  const out = await providerFrom(reading).read();
  assert.equal(out.cpuPackageC, null);
  assert.equal(out.gpuCoreC, null);
  assert.notEqual(out.cpuPackageC, 0);
  assert.equal(out.source, "AMD ADL");
});

// ── Ponte: pré-verificação sem driver não cria processo nenhum ───────────────
test("bridge: sem atiadlxx.dll não é criado nenhum processo (0 spawns) e faz latch", async () => {
  resetAdlBridgeState();
  const missing = path.resolve(process.execPath, "..", "__sem_adl__.dll");
  const first = await readAdlSensors({ dllPath: missing, workerPath: missing });
  assert.equal(first.status, "unsupported");
  assert.equal(first.reason, "dll-not-found");
  assert.equal(first.spawned, 0);
  const second = await readAdlSensors({ dllPath: missing, workerPath: missing });
  assert.equal(second.spawned, 0, "segunda chamada também não pode spawnar");
});

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.kills = 0;
  }
  kill() {
    this.kills += 1;
  }
}

const realFile = () => path.join(process.cwd(), "package.json");

function harness(behavior) {
  const created = [];
  const options = {
    dllPath: realFile(),
    workerPath: realFile(),
    spawnWorker: () => {
      const child = new FakeChild();
      created.push(child);
      setImmediate(() => behavior(child));
      return child;
    },
  };
  return { options, created };
}

test("bridge: 20 chamadas simultâneas criam UM processo (single-flight + cache)", async () => {
  resetAdlBridgeState();
  const { options, created } = harness((child) => {
    child.stdout.emit("data", Buffer.from(JSON.stringify({
      status: "ok", reason: null, adapterCount: 1, createCode: 0,
      adapters: [{ adapterIndex: 1, udid: "u", adapterName: "AMD Radeon RX 5600 XT", displayName: "d", busNumber: 8, deviceNumber: 0, present: true, active: 1, pmlog: { gpuCoreC: 70 }, od6Celsius: null }],
    })));
    child.emit("close", 0, null);
  });
  const results = await Promise.all(Array.from({ length: 20 }, () => readAdlSensors(options)));
  assert.equal(created.length, 1, `esperava 1 processo, houve ${created.length}`);
  for (const r of results) {
    assert.equal(r.status, "ok");
    assert.equal(r.samples[0].pmlog.gpuCoreC, 70);
  }
  // Repetida dentro do TTL: zero processos novos.
  await readAdlSensors(options);
  assert.equal(created.length, 1);
});

test("bridge: `null` do worker não pode virar zero (active/od6 sem leitura ficam null)", async () => {
  resetAdlBridgeState();
  const { options } = harness((child) => {
    child.stdout.emit("data", Buffer.from(JSON.stringify({
      status: "ok",
      reason: null,
      adapterCount: 2,
      createCode: 0,
      adapters: [
        { adapterIndex: 0, udid: "u0", adapterName: "AMD Radeon(TM) Graphics", displayName: "", busNumber: 21, deviceNumber: 0, present: false, active: null, pmlog: {}, od6Celsius: null },
        { adapterIndex: 5, udid: "u5", adapterName: "AMD Radeon RX 5600 XT", displayName: "DISPLAY1", busNumber: 3, deviceNumber: 0, present: true, active: null, pmlog: { gpuCoreC: 49 }, od6Celsius: null, supportedSensors: [1, 8, 14] },
      ],
    })));
    child.emit("close", 0, null);
  });
  const reading = await readAdlSensors(options);
  assert.equal(reading.samples.length, 2);
  for (const s of reading.samples) {
    assert.equal(s.active, null, `active sem leitura veio como ${s.active}`);
    assert.equal(s.od6Celsius, null, `od6 sem leitura veio como ${s.od6Celsius}`);
  }
  assert.deepEqual(reading.samples[1].supportedSensors, [1, 8, 14]);
});

test("bridge: timeout mata o worker e publica timeout (nunca um valor antigo)", async () => {
  resetAdlBridgeState();
  const { options, created } = harness(() => {
    /* nunca responde */
  });
  const p = readAdlSensors({ ...options, timeoutMs: 40, reapGraceMs: 3000 });
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(created[0].kills, 1, "o filho tem de ser morto ao fim do timeout");
  // A promessa só se resolve depois de o encerramento ser confirmado — ver
  // `adl-worker-lifecycle.test.js` para o caso do filho que não morre.
  created[0].emit("close", null, "SIGTERM");
  const reading = await p;
  assert.equal(reading.status, "timeout");
  assert.equal(reading.reason, "worker-timeout");
  assert.equal(reading.closeConfirmed, true);
  assert.equal(created.length, 1);
});

test("bridge: crash do worker fica contido e entra em backoff (sem retry por poll)", async () => {
  resetAdlBridgeState();
  const { options, created } = harness((child) => child.emit("close", null, "SIGSEGV"));
  const first = await readAdlSensors(options);
  assert.equal(first.status, "error");
  assert.equal(first.reason, "worker-signal-SIGSEGV");
  const second = await readAdlSensors(options);
  assert.equal(second.status, "error");
  assert.equal(created.length, 1, "falha transitória não pode gerar um processo por consulta");
});

test("bridge: exit não-zero sem JSON é erro, não adapter vazio", async () => {
  resetAdlBridgeState();
  const { options } = harness((child) => child.emit("close", 3, null));
  const reading = await readAdlSensors(options);
  assert.equal(reading.status, "error");
  assert.equal(reading.reason, "worker-exit-3");
});

test("bridge: JSON do worker com status unsupported é propagado", async () => {
  resetAdlBridgeState();
  const { options } = harness((child) => {
    child.stdout.emit("data", Buffer.from(JSON.stringify({ status: "unsupported", reason: "adl2-create-failed", adapters: [] })));
    child.emit("close", 0, null);
  });
  const reading = await readAdlSensors(options);
  assert.equal(reading.status, "unsupported");
  assert.equal(reading.reason, "adl2-create-failed");
  assert.equal(reading.samples.length, 0);
});

const koffiPresent = await import("koffi").then(() => true, () => false);

test("bridge: sem a dependência opcional koffi não é criado processo nenhum", { skip: koffiPresent ? "koffi instalado — nada a provar neste ambiente" : false }, async () => {
  resetAdlBridgeState();
  const reading = await readAdlSensors({ dllPath: realFile(), workerPath: realFile() });
  assert.equal(reading.status, "unsupported");
  assert.equal(reading.reason, "ffi-module-absent");
  assert.equal(reading.spawned, 0, "a cadeia não pode criar um processo por consulta para descobrir que não tem koffi");
  const again = await readAdlSensors({ dllPath: realFile(), workerPath: realFile() });
  assert.equal(again.spawned, 0);
});

// ── 13. SMART indisponível nunca é "disco saudável" ──────────────────────────
test("SMART: PermissionDenied é `denied`, não saudável nem 0 °C", () => {
  const denied = classifyCountersError("Get-StorageReliabilityCounter : Acesso a um recurso CIM não estava disponível para o cliente.");
  assert.equal(denied.status, "denied");
  assert.match(denied.detail, /elevação/);

  const health = describeStorageHealth({
    physicalDisks: [
      { DeviceId: "0", FriendlyName: "Samsung SSD 980", MediaType: "SSD", BusType: "PCI", Size: 1_000_000_000_000, HealthStatus: "Healthy", OperationalStatus: "OK" },
    ],
    counters: null,
    countersError: "Acesso a um recurso CIM não estava disponível",
  });
  assert.equal(health.status, "denied");
  const disk = health.disks[0];
  assert.equal(disk.countersStatus, "denied");
  assert.equal(disk.temperatureC, null, "sem leitura não há temperatura");
  assert.equal(disk.wearPercent, null);
  assert.equal(disk.mediaType, "ssd");
  // HealthStatus do Windows (logical/SAH) mantém-se distinto da saúde física.
  assert.equal(disk.healthStatus, "healthy");
  assert.match(disk.countersDetail, /elevação/);
});

test("SMART: contadores lidos mas vazios são `invalid`, não `available`", () => {
  const health = describeStorageHealth({
    physicalDisks: [{ DeviceId: "1", FriendlyName: "HD", MediaType: "HDD", Size: 2_000_000_000_000, HealthStatus: "Unknown" }],
    counters: [{ id: "1", temperature: null, wear: null, hours: null, readErr: null, readUnc: null, writeErr: null, writeUnc: null }],
    countersError: null,
  });
  assert.equal(health.disks[0].countersStatus, "invalid");
  assert.equal(health.status, "invalid");
});

test("SMART: módulo não suportado é `unsupported`, com temperatura null", () => {
  const missing = classifyCountersError("O termo 'Get-StorageReliabilityCounter' não é reconhecido como nome de cmdlet.");
  assert.equal(missing.status, "unsupported");
});
