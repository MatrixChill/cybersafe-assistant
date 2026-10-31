import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PcStateEngine, DEFAULT_PC_STATE_CONFIG } from "../dist/index.js";
import { buildFindingDado } from "@cybersafe/shared-types";

const now = () => 1_700_000_000_000;

function hw({ cpu = 10, ram = 40, disk = 40, timestamp = "2023-11-14T22:13:20.000Z" } = {}) {
  return {
    cpu: { usage: cpu, model: "Test CPU", cores: 8, speed: 3.2, temperature: null },
    ram: { usagePercent: ram, usedGb: 8, totalGb: 16 },
    disk: { usagePercent: disk, usedGb: 200, totalGb: 500, fsType: "NTFS" },
    network: { rxSec: 0, txSec: 0, interfaceName: "eth0" },
    battery: { hasBattery: false, percent: 100, isCharging: true, timeRemaining: null },
    gpu: null,
    system: { uptime: 1000, platform: "win32", osVersion: "10", hostname: "TEST" },
    topProcessesByCpu: [],
    topProcessesByRam: [],
    stressScore: 0,
    alerts: [],
    timestamp,
  };
}

function protection({ status = "safe", engine = {} } = {}) {
  const defaults = {
    serviceRunning: true,
    osLayerHealthy: true,
    degradedReasons: [],
    monitoredPaths: [],
    yara: { status: "active" },
    hashDb: { status: "active" },
    clamav: { status: "active" },
    nativeEngine: { status: "active" },
    firewall: { status: "active" },
  };
  return {
    status,
    stats: { riskScore: 0, totalEvents: 0, highSeverityEvents: 0, blockedExecutions: 0, quarantinedCount: 0, monitoredProcesses: 0 },
    engine: { ...defaults, ...engine },
  };
}

function protectionDegraded() {
  return protection({
    status: "degraded",
    engine: {
      degradedReasons: ["clamav: unavailable"],
      clamav: { status: "unavailable", detail: "binary not found" },
    },
  });
}

function engineErrorEngine() {
  return protection({
    status: "attention",
    engine: {
      degradedReasons: ["yara: error"],
      yara: { status: "error", detail: "load failed" },
    },
  });
}

function serviceStoppedProtection() {
  return protection({
    status: "critical",
    engine: {
      serviceRunning: false,
      osLayerHealthy: false,
      degradedReasons: [],
      yara: { status: "unavailable" },
      hashDb: { status: "unavailable" },
      clamav: { status: "unavailable" },
      nativeEngine: { status: "unavailable" },
      firewall: { status: "unavailable" },
    },
  });
}

function health(overrides = {}) {
  return {
    system: { available: true, ramUsagePercent: 40, totalRamGb: 16, availableRamGb: 9, osName: "Windows", osVersion: "10", osBuild: "1", manufacturer: "", model: "", architecture: "x64" },
    topProcessesByCpu: [],
    topProcessesByRam: [],
    services: [],
    connections: [],
    users: [],
    disks: [],
    firewall: { enabled: true, profiles: [], available: true },
    overallStatus: "good",
    score: 100,
    recommendations: [],
    collectedAt: "2023-11-14T22:13:20.000Z",
    errors: [],
    ...overrides,
  };
}

function baseInput(extra = {}) {
  return {
    hardware: hw(),
    protection: protection(),
    windowsHealth: health(),
    threats: [],
    now: now(),
    ...extra,
  };
}

function findById(state, id) {
  return state.findings.find((f) => f.id === id) ?? null;
}

describe("PcState — Security", () => {
  test("ProtectionHealth degraded ⇒ security attention", () => {
    const engine = new PcStateEngine();
    const state = engine.update(baseInput({ protection: protectionDegraded() }));

    assert.equal(state.security, "attention");
    const f = findById(state, "security:engine-unavailable");
    assert.ok(f);
    assert.equal(f.severity, "attention");
    assert.equal(f.category, "security");
  });

  test("engine ERROR ⇒ urgent", () => {
    const engine = new PcStateEngine();
    const state = engine.update(baseInput({ protection: engineErrorEngine() }));

    assert.equal(state.security, "critical");
    const f = findById(state, "security:engine-error");
    assert.ok(f);
    assert.equal(f.severity, "urgent");
    assert.equal(state.counts.urgent, 1);
  });

  test("critcial threat real ⇒ urgent, sem ambiguidade", () => {
    const engine = new PcStateEngine();
    const state = engine.update(
      baseInput({
        threats: [
          { url: "http://x.test", domain: "x.test", severity: "critical", confidence: 1, rulesTriggered: [], createdAt: "2023-11-14T22:11:00.000Z", riskScore: 95, source: "dashboard" },
        ],
      }),
    );
    assert.equal(findById(state, "security:critical-threat")?.severity, "urgent");
    assert.equal(state.security, "critical");
  });

  test("serviço parado ⇒ urgent e sem spam de cada motor", () => {
    const engine = new PcStateEngine();
    const state = engine.update(
      baseInput({ protection: serviceStoppedProtection() }),
    );
    assert.equal(findById(state, "security:service-stopped")?.severity, "urgent");
    assert.equal(findById(state, "security:engine-unavailable"), null);
    assert.equal(state.counts.urgent, 1);
  });
});

describe("PcState — Sustained RAM (anti-flapping)", () => {
  test("RAM alta em 1 amostra ⇒ nenhum finding prematuro", () => {
    const engine = new PcStateEngine();
    const state = engine.update(baseInput({ hardware: hw({ ram: 95 }) }));
    assert.equal(findById(state, "perf:ram-high"), null);
    assert.equal(findById(state, "perf:ram-recommended"), null);
  });

  test("2 amostras seguidas ⇒ ainda nada", () => {
    const engine = new PcStateEngine();
    engine.update(baseInput({ hardware: hw({ ram: 95 }) }));
    const state = engine.update(baseInput({ hardware: hw({ ram: 94 }) }));
    assert.equal(findById(state, "perf:ram-high"), null);
    assert.equal(findById(state, "perf:ram-recommended"), null);
  });

  test("RAM >= 90% em 3 amostras consecutivas ⇒ attention", () => {
    const engine = new PcStateEngine();
    engine.update(baseInput({ hardware: hw({ ram: 91 }) }));
    engine.update(baseInput({ hardware: hw({ ram: 92 }) }));
    const state = engine.update(baseInput({ hardware: hw({ ram: 93 }) }));

    const f = findById(state, "perf:ram-high");
    assert.ok(f);
    assert.equal(f.severity, "attention");
    assert.equal(f.evidence.memoryPercent, 93);
    assert.ok(f.firstSeen && f.lastSeen);
    assert.equal(state.performance, "attention");
  });

  test("RAM 80-90% em 3 amostras ⇒ recommended", () => {
    const engine = new PcStateEngine();
    engine.update(baseInput({ hardware: hw({ ram: 81 }) }));
    engine.update(baseInput({ hardware: hw({ ram: 82 }) }));
    const state = engine.update(baseInput({ hardware: hw({ ram: 83 }) }));
    assert.equal(findById(state, "perf:ram-recommended")?.severity, "recommended");
    assert.equal(findById(state, "perf:ram-high"), null);
  });

  test("firstSeen preservado e lastSeen atualizado", () => {
    const engine = new PcStateEngine();
    engine.update(baseInput({ hardware: hw({ ram: 91 }), now: now() }));
    engine.update(baseInput({ hardware: hw({ ram: 91 }), now: now() + 10_000 }));
    const first = engine.update(baseInput({ hardware: hw({ ram: 92 }), now: now() + 20_000 }));
    engine.update(baseInput({ hardware: hw({ ram: 93 }), now: now() + 30_000 }));
    const second = engine.update(baseInput({ hardware: hw({ ram: 94 }), now: now() + 40_000 }));
    const f1 = findById(first, "perf:ram-high");
    const f2 = findById(second, "perf:ram-high");
    assert.ok(f1);
    assert.ok(f2);
    assert.equal(f1.firstSeen, f2.firstSeen);
    assert.notEqual(f1.lastSeen, f2.lastSeen, "lastSeen deve avançar com as atualizações");
  });
});

describe("PcState — Sustained CPU", () => {
  test("CPU spike curto ⇒ nenhum finding", () => {
    const engine = new PcStateEngine();
    const state = engine.update(baseInput({ hardware: hw({ cpu: 97 }) }));
    assert.equal(findById(state, "perf:cpu-high"), null);
    assert.equal(findById(state, "perf:cpu-recommended"), null);
  });

  test("CPU >= 90% em 3 amostras ⇒ attention", () => {
    const engine = new PcStateEngine();
    engine.update(baseInput({ hardware: hw({ cpu: 91 }) }));
    engine.update(baseInput({ hardware: hw({ cpu: 92 }) }));
    const state = engine.update(baseInput({ hardware: hw({ cpu: 94 }) }));
    const f = findById(state, "perf:cpu-high");
    assert.ok(f);
    assert.equal(f.severity, "attention");
    assert.equal(f.evidence.cpuPercent, 94);
    assert.equal(state.performance, "attention");
  });

  test("CPU 75-90% em 3 amostras ⇒ recommended", () => {
    const engine = new PcStateEngine();
    engine.update(baseInput({ hardware: hw({ cpu: 80 }) }));
    engine.update(baseInput({ hardware: hw({ cpu: 81 }) }));
    const state = engine.update(baseInput({ hardware: hw({ cpu: 82 }) }));
    assert.equal(findById(state, "perf:cpu-recommended")?.severity, "recommended");
    assert.equal(findById(state, "perf:cpu-high"), null);
  });
});

describe("PcState — Disk", () => {
  test("disco com <10% livre ⇒ attention", () => {
    const engine = new PcStateEngine();
    const state = engine.update(baseInput({ hardware: hw({ disk: 93 }) }));
    const f = findById(state, "system:disk-low");
    assert.ok(f);
    assert.equal(f.severity, "attention");
    assert.equal(f.evidence.diskFreePercent, 7);
  });

  test("disco com 10-20% livre ⇒ recommended", () => {
    const engine = new PcStateEngine();
    const state = engine.update(baseInput({ hardware: hw({ disk: 85 }) }));
    assert.equal(findById(state, "system:disk-recommended")?.severity, "recommended");
  });

  test("disco folgado ⇒ nenhum finding", () => {
    const engine = new PcStateEngine();
    const state = engine.update(baseInput({ hardware: hw({ disk: 40 }) }));
    assert.equal(findById(state, "system:disk-low"), null);
    assert.equal(findById(state, "system:disk-recommended"), null);
  });

  test("SEM leitura do disco ⇒ nenhum finding de espaço (nunca um 0% inventado)", () => {
    const engine = new PcStateEngine();
    // `usagePercent: null` é ausência de medição, não "disco vazio": se o motor
    // tratasse o null como 0, o utilizador via um achado "disco quase cheio"
    // nascido de uma leitura que nunca aconteceu.
    const state = engine.update(baseInput({ hardware: hw({ disk: null }) }));
    assert.equal(findById(state, "system:disk-low"), null);
    assert.equal(findById(state, "system:disk-recommended"), null);
  });
});

describe("PcState — Sem problemas conhecidos", () => {
  test("tudo saudável ⇒ nenhum finding falso, performance good", () => {
    const engine = new PcStateEngine();
    const state = engine.update(baseInput());
    assert.equal(state.findings.length, 0);
    assert.equal(state.security, "good");
    assert.equal(state.performance, "good");
    assert.equal(state.privacy, "unknown");
    assert.equal(state.system, "good");
    assert.equal(state.overall, "good");
    assert.equal(state.principalFinding, null);
  });

  test("privacy permanece unknown sem dados reais", () => {
    const engine = new PcStateEngine();
    const state = engine.update(baseInput());
    assert.equal(state.privacy, "unknown");
    assert.equal(findById(state, "privacy:*"), null);
  });
});

describe("PcState — Deduplicação de disco", () => {
  test("free < 10% ⇒ apenas ATTENTION, sem windows e sem RECOMMENDED duplicado", () => {
    const engine = new PcStateEngine();
    const windowsWithDisk = health({
      disks: [{ deviceId: "C:", volumeName: "System", usagePercent: 97, freeGb: 3, totalGb: 100 }],
      recommendations: [
        { id: "disk-critical", severity: "high", status: "attention", title: "Disco quase cheio", description: "O disco C: está a 97% cheio.", suggestion: "Liberte espaço." },
      ],
    });
    const state = engine.update(
      baseInput({ hardware: hw({ disk: 93 }), windowsHealth: windowsWithDisk }),
    );
    const ids = state.findings.map((f) => f.id);
    assert.ok(ids.includes("system:disk-low"));
    assert.ok(!ids.includes("system:disk-recommended"), "não deve haver RECOMMENDED de disco ao mesmo tempo");
    assert.ok(!ids.some((id) => id.startsWith("system:win:disk")), "windows disk não deve duplicar o mesmo disco");
  });

  test("free entre 10% e 20% ⇒ apenas RECOMMENDED", () => {
    const engine = new PcStateEngine();
    const windowsWithDisk = health({
      disks: [{ deviceId: "C:", volumeName: "System", usagePercent: 90, freeGb: 10, totalGb: 100 }],
      recommendations: [
        { id: "disk-attention", severity: "medium", status: "attention", title: "Espaço em disco baixo", description: "O disco C: está a 90% cheio.", suggestion: "Liberte espaço." },
      ],
    });
    const state = engine.update(
      baseInput({ hardware: hw({ disk: 84 }), windowsHealth: windowsWithDisk }),
    );
    const ids = state.findings.map((f) => f.id);
    assert.ok(ids.includes("system:disk-recommended"));
    assert.ok(!ids.includes("system:disk-low"), "free 16% não pode ser ATTENTION");
    assert.ok(!ids.some((id) => id.startsWith("system:win:disk")), "windows disk não deve duplicar o mesmo disco");
  });
});

describe("PcState — Proteção degradada, summary simples", () => {
  test("DEGRADED + UNAVAILABLE ⇒ resumo conta todos e não vira ameaça", () => {
    const engine = new PcStateEngine();
    const state = engine.update(
      baseInput({
        protection: protection({
          status: "degraded",
          engine: {
            degradedReasons: ["clamav: degraded", "nativeEngine: unavailable", "firewall: unavailable"],
            clamav: { status: "degraded", detail: "freshclam sem configuração" },
            nativeEngine: { status: "unavailable", detail: "não instalado" },
            firewall: { status: "unavailable" },
          },
        }),
      }),
    );

    const f = findById(state, "security:engine-unavailable");
    assert.ok(f);
    assert.equal(f.severity, "attention", "degraded/unavailable não é ameaça → attention");
    assert.equal(state.security, "attention");
    assert.equal(state.security !== "critical", true);
    assert.match(f.summary, /3 componentes de proteção precisam de atenção/);
    // A evidence mostra o NOME do motor, nao a chave interna: escrever
    // "firewall" ai dizia ao utilizador que a proteccao de rede do Windows
    // estava desligada, quando o que falhou foi o filtro WFP do CyberSafe.
    assert.match(f.evidence.engine ?? "", /ClamAV/);
    assert.match(f.evidence.engine ?? "", /Motor nativo/);
    assert.match(f.evidence.engine ?? "", /Filtro WFP do CyberSafe/);
    // CONTRASTE: nao pode voltar a dizer so "firewall".
    assert.doesNotMatch(f.evidence.engine ?? "", /^\s*firewall\s*[,;|]/im);
    // WS-B: a evidenceLines sai em PT-PT ("Degradado"), nunca o token cru.
    assert.ok((f.evidence.evidenceLines ?? []).some((l) => l.includes("Degradado")));
    assert.doesNotMatch((f.evidence.evidenceLines ?? []).join("\n"), /\b(degraded|unavailable)\b/i, "token cru na copy do painel");
    assert.doesNotMatch(f.evidence.engine ?? "", /\((degraded|unavailable)\)/i, "parenteses com estado interno");
  });

  test("um único motor degradado ⇒ mensagem singular", () => {
    const engine = new PcStateEngine();
    const state = engine.update(
      baseInput({
        protection: protection({
          status: "degraded",
          engine: { clamav: { status: "degraded", detail: "clamscan exit 2" } },
        }),
      }),
    );
    const f = findById(state, "security:engine-unavailable");
    assert.ok(f);
    assert.match(f.summary, /Um componente de proteção não está totalmente disponível/);
    assert.ok(!(f.summary ?? "").includes("clamav"), "nomes internos fora da mensagem principal");
    // A evidence mostra o NOME legivel do motor, nao a chave interna. O
    // invariante acima continua: a MENSAGEM principal nao leva nomes internos.
    assert.match(f.evidence.engine ?? "", /ClamAV/);
  });
});

/**
 * WS-B — telemetria REAL medida live via pipe protection.getState nesta
 * maquina. O DADO do painel nao pode despejar tokens crus, paths nem
 * mensagens do provider; a copy e PT-PT e diz a cobertura real.
 */
describe("WS-B — DADO com a telemetria real da maquina", () => {
  const liveProtection = protection({
    status: "degraded",
    engine: {
      anyEngineDegraded: true,
      degradedReasons: [
        "ClamAV: degraded — ClamAV instalado mas sem base de assinaturas — C:\\ClamAV\\db nao tem ficheiros .cvd/.cld; corre freshclam",
        "Filtro WFP do CyberSafe: unavailable — WFP filter not started",
      ],
      yara: { status: "active", detail: "Loaded 1 rule(s) from file" },
      hashDb: { status: "active", detail: "Loaded 4 signature(s) from C:\\ProgramData\\CyberSafe\\definitions\\default.json" },
      nativeEngine: { status: "active", detail: "packages\\native-engine\\build\\Release\\scan-engine.exe" },
      clamav: { status: "degraded", detail: "ClamAV instalado mas sem base de assinaturas — C:\\ClamAV\\db nao tem ficheiros .cvd/.cld; corre freshclam" },
      firewall: { status: "unavailable", detail: "WFP filter not started" },
    },
  });

  const engine = new PcStateEngine();
  const state = engine.update(baseInput({ protection: liveProtection }));
  const f = findById(state, "security:engine-unavailable");
  const dado = buildFindingDado(f.evidence);

  test("nenhum token cru nem parentesis de estado no DADO", () => {
    assert.doesNotMatch(dado.join("\n"), /\((degraded|unavailable|active)\)/i, dado.join("\n"));
    assert.doesNotMatch(dado.join("\n"), /\b(degraded|unavailable)\b/i, dado.join("\n"));
  });

  test("nenhum path ou mensagem de provider no DADO", () => {
    for (const linha of dado) {
      assert.doesNotMatch(linha, /[A-Za-z]:\\|packages\\|\.exe|\.json|\.cvd|freshclam|Loaded \d|WFP filter/i, linha);
    }
  });

  test("estados em PT-PT, um por motor", () => {
    assert.ok(dado.some((l) => /^ClamAV: Degradado/.test(l)), JSON.stringify(dado));
    assert.ok(dado.some((l) => /^Filtro WFP do CyberSafe: Indisponível/.test(l)), JSON.stringify(dado));
  });

  test("ClamAV explica a base ausente; WFP nao confunde com o Windows", () => {
    const texto = dado.join("\n");
    assert.match(texto, /base de assinaturas antivírus ainda não está disponível/);
    assert.match(texto, /Isto não significa que o Firewall do Windows esteja desligado\./);
  });
});

describe("PcState — Deduplicação de serviços (service-down)", () => {
  test("filtro WFP indisponivel NÃO deduplica o mpssvc (são coisas diferentes)", () => {
    const engine = new PcStateEngine();
    const windowsDown = health({
      services: [
        { name: "mpssvc", displayName: "Windows Firewall", running: false },
        { name: "WinDefend", displayName: "Windows Defender", running: true },
      ],
      recommendations: [
        { id: "service-down", severity: "high", status: "attention", title: "Serviços importantes indisponíveis", description: "Windows Firewall", suggestion: "Verifique o estado destes serviços." },
      ],
    });
    const state = engine.update(
      baseInput({
        protection: protection({ status: "attention", engine: { firewall: { status: "unavailable", detail: "mpssvc parado" } } }),
        windowsHealth: windowsDown,
      }),
    );
    // WS-A: este teste antes afirmava o CONTRARIO — que o filtro WFP do
    // CyberSafe "cobre" o servico mpssvc (o Firewall do Windows) e por isso o
    // achado de servico parado devia desaparecer. Sao coisas diferentes: o
    // `mpssvc` parado e uma falha do Windows Firewall, exista ou nao exista
    // filtro do CyberSafe. Suprimir o achado deixava o utilizador sem aviso
    // de rede desprotegida, e a supressao dependia do estado do CyberSafe —
    // o mpssvc aparecia ou nao conforme um modulo alheio.
    //
    // O WFP indisponivel continua representado, pela sua propria via.
    assert.ok(
      findById(state, "system:win:service-down"),
      "o mpssvc parado e um problema do Windows Firewall e nao se esconde por causa do WFP",
    );
    assert.ok(findById(state, "security:engine-unavailable"), "o filtro WFP tambem e reportado, pela sua via");
  });

  test("serviço distinto de facto ⇒ mantido com evidência", () => {
    const engine = new PcStateEngine();
    const windowsDown = health({
      services: [{ name: "WinDefend", displayName: "Windows Defender", running: false }],
      recommendations: [
        { id: "service-down", severity: "high", status: "attention", title: "Serviços importantes indisponíveis", description: "Windows Defender", suggestion: "Verifique." },
      ],
    });
    const state = engine.update(baseInput({ windowsHealth: windowsDown }));
    const f = findById(state, "system:win:service-down");
    assert.ok(f, "Windows Defender parado é evidência distinta");
    assert.equal(f.severity, "attention");
    assert.match(f.summary, /Windows Defender/);
  });
});

describe("PcState — Principal finding e prioridade", () => {
  test("urgent + attention + recommended ⇒ principalFinding urgent", () => {
    const engine = new PcStateEngine();
    // urgent de security:critical-threat + attention de windows + recommended de disk atendido mais abaixo
    const state = engine.update(
      baseInput({
        protection: engineErrorEngine(),
        hardware: hw({ cpu: 61, ram: 69, disk: 85 }),
        threats: [
          { url: "http://x.test", domain: "x.test", severity: "critical", confidence: 1, rulesTriggered: [], createdAt: "2023-11-14T22:11:00.000Z", riskScore: 95, source: "dashboard" },
        ],
      }),
    );
    assert.ok(state.principalFinding);
    assert.equal(state.principalFinding.severity, "urgent");
  });

  test("attention definido pela ordem da categoria é estável", () => {
    const engine = new PcStateEngine();
    const state = engine.update(
      baseInput({
        protection: protectionDegraded(),
        hardware: hw({ disk: 93 }),
      }),
    );
    assert.ok(state.principalFinding);
    assert.equal(state.principalFinding.severity, "attention");
    assert.equal(state.counts.attention >= 2, true);
  });

  test("urgent + attention + recommended ⇒ principalFinding continua urgent", () => {
    const engine = new PcStateEngine();
    const state = engine.update(
      baseInput({
        protection: protection({
          status: "degraded",
          engine: { clamav: { status: "degraded" }, firewall: { status: "unavailable" } },
        }),
        hardware: hw({ disk: 84 }),
        threats: [
          { url: "http://y.test", domain: "y.test", severity: "critical", confidence: 1, rulesTriggered: [], createdAt: "2023-11-14T22:11:00.000Z", riskScore: 99, source: "dashboard" },
        ],
      }),
    );
    assert.ok(state.principalFinding);
    assert.equal(state.principalFinding.severity, "urgent");
    assert.equal(state.principalFinding.id, "security:critical-threat");
  });
});

describe("PcState — Grace / remoção temporal", () => {
  test("condição deixa de existir ⇒ finding respeita grace antes de remover", () => {
    const engine = new PcStateEngine();
    for (let i = 0; i < 3; i++) {
      engine.update(baseInput({ hardware: hw({ ram: 95 }) }));
    }
    let state = engine.update(baseInput({ hardware: hw({ ram: 95 }) }));
    assert.ok(findById(state, "perf:ram-high"));

    // 1 amostra abaixo do limiar: graceSamples=1 ⇒ ainda presente
    state = engine.update(baseInput({ hardware: hw({ ram: 30 }) }));
    assert.ok(findById(state, "perf:ram-high"), "grace deve manter o finding após 1 amostra");

    // 2.ª amostra abaixo: removido
    state = engine.update(baseInput({ hardware: hw({ ram: 30 }) }));
    assert.equal(findById(state, "perf:ram-high"), null);
  });

  test("samples ring buffer respeita maxSamples", () => {
    const engine = new PcStateEngine({ ...DEFAULT_PC_STATE_CONFIG, maxSamples: 5 });
    for (let i = 0; i < 20; i++) {
      engine.update(baseInput({ hardware: hw({ ram: 50, cpu: 20 }) }));
    }
    const state = engine.getLast();
    assert.ok(state);
    assert.equal(state.findings.length, 0);
  });
});