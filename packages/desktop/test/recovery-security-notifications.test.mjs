import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createSecurityNotifications,
  SECURITY_EVENT_TYPES,
  safeBasename,
  redactPaths,
} from "../src/security-notifications.ts";

/**
 * RECOVERY-SECURITY-20261014 (P0, qoder): EventBus -> Electron Notification.
 *
 * O modulo e escrito sem Electron de proposito: o shell injeta `notify`
 * (que no main.ts e o `new Notification(...).show()` atras do gate de
 * preferencias). Aqui usamos mocks COMPORTAMENTAIS — capturar chamadas,
 * relogio falso — e nunca alegamos toast real do Windows: isto prova a
 * decisao (quem notificar, quando deduplicar), nao o sistema operativo.
 *
 * Regras em teste:
 *  - notificar: threat.detected, quarantine.added (confirmado),
 *    quarantine.failed, process.blocked, process.suspicious (medium+),
 *    protecao essencial indisponivel e restabelecida, mudancas REAIS de
 *    protection.changed;
 *  - nunca notificar: eventos benignos (file.*, process.started/exited,
 *    scan.progress, artifact.*, trust.updated, engine.health informativo);
 *  - dedup por fingerprint (mesmo alvo = suprimido dentro da janela);
 *  - preferencia notificationsEnabled desligada = zero notificacoes.
 */

function makeHarness({ enabled = true, quitting = false } = {}) {
  const shown = [];
  let now = 1_000_000;
  const mgr = createSecurityNotifications({
    notify: (title, body) => shown.push({ title, body }),
    notificationsEnabled: () => enabled,
    isQuitting: () => quitting,
    now: () => now,
  });
  return { shown, mgr, advance: (ms) => { now += ms; }, set: (v) => { enabled = v; } };
}

const evt = (overrides = {}) => ({
  id: `e-${Math.random().toString(36).slice(2)}`,
  type: "threat.detected",
  timestamp: "2026-10-14T11:00:00.000Z",
  sequence: 1,
  severity: "critical",
  summary: "Ameaça detetada em teste.exe",
  data: { artifactPath: "C:\\temp\\teste.exe" },
  ...overrides,
});

describe("security-notifications — gate de preferencia", () => {
  it("notificationsEnabled=false nao mostra nada, nem ameaca critica", () => {
    const { shown, mgr, set } = makeHarness({ enabled: false });
    set(false);
    mgr.handleEvent(evt());
    mgr.handleConnectionState(false);
    assert.equal(shown.length, 0);
  });

  it("com quit iniciado, nenhum evento mostra", () => {
    const { shown, mgr } = makeHarness({ quitting: true });
    mgr.handleEvent(evt());
    assert.equal(shown.length, 0);
  });
});

describe("security-notifications — eventos de seguranca notificados", () => {
  it("threat.detected critica notifica com o nome medido, nunca o summary cru", () => {
    const { shown, mgr } = makeHarness();
    mgr.handleEvent(evt({ severity: "critical", summary: "Ameaça detetada em C:\\Users\\public\\ransomware.exe", data: { fileName: "ransomware.exe" } }));
    assert.equal(shown.length, 1);
    assert.match(shown[0].body, /ransomware\.exe/);
    assert.doesNotMatch(shown[0].body, /Users|public|C:/i, "o toast e copy estruturada; o summary nao e fonte");
  });

  it("process.blocked high notifica bloqueio", () => {
    const { shown, mgr } = makeHarness();
    mgr.handleEvent(
      evt({ type: "process.blocked", severity: "high", summary: "Execução de script malicioso bloqueada (powershell.exe)", data: { appName: "powershell.exe" } }),
    );
    assert.equal(shown.length, 1);
    assert.match(shown[0].body, /bloquead/i);
  });

  it("process.suspicious medium notifica; low nao (sem spam benigno)", () => {
    const { shown, mgr } = makeHarness();
    mgr.handleEvent(evt({ type: "process.suspicious", severity: "low", summary: "suspeito baixo", data: { name: "a.exe" } }));
    assert.equal(shown.length, 0);
    mgr.handleEvent(evt({ type: "process.suspicious", severity: "medium", summary: "Processo suspeito: b.exe", data: { name: "b.exe" } }));
    assert.equal(shown.length, 1);
  });

  it("quarantine.added notifica somente COM Confirmacao de entrada em quarentena", () => {
    const { shown, mgr } = makeHarness();
    mgr.handleEvent(
      evt({ type: "quarantine.added", severity: "critical", summary: "Colocado em quarentena malware.exe", data: { fileName: "malware.exe", id: "q1", path: "C:\\quarantine\\q1" } }),
    );
    assert.equal(shown.length, 1);
    assert.match(shown[0].body, /quarentena/i);
    assert.match(shown[0].body, /Confirmado|confirmad/i);
  });

  it("quarantine.failed notifica a FALHA — nunca finge sucesso nem afirma que o ficheiro esta no disco", () => {
    const { shown, mgr } = makeHarness();
    mgr.handleEvent(
      evt({ type: "quarantine.failed", severity: "high", summary: "Falha ao colocar em quarentena malware.exe", data: { fileName: "malware.exe", error: "rename EPERM" } }),
    );
    assert.equal(shown.length, 1);
    assert.match(shown[0].body, /falha/i);
    assert.match(shown[0].body, /isolamento não confirmado/i);
    assert.doesNotMatch(shown[0].body, /N[AÃ]O est[áa] isolado/i, "com recovery-required o manager pode ja ter movido os bytes");
    assert.doesNotMatch(shown[0].body, /Confirmado/);
  });

  it("protection.changed: primeira leitura ativada e baseline silenciosa; desativar e reativar notificam", () => {
    const { shown, mgr } = makeHarness();
    mgr.handleEvent(evt({ type: "protection.changed", severity: "low", summary: "Proteção em tempo real ativa", data: { protectionEnabled: true, protectionPausedUntil: null } }));
    assert.equal(shown.length, 0, "arranque ativado nao e spam benigno");
    mgr.handleEvent(evt({ type: "protection.changed", severity: "low", summary: "Proteção em tempo real desativada", data: { protectionEnabled: false, protectionPausedUntil: null } }));
    assert.equal(shown.length, 1);
    assert.match(shown[0].body, /deixou de monitorizar/i);
    assert.doesNotMatch(shown[0].body, /computador|Windows|Defender/i, "a copy do OFF nao pode inferir outros motores");
    // o mesmo estado repetido (evento atrasado/duplicado) nao re-notifica
    mgr.handleEvent(evt({ type: "protection.changed", severity: "low", summary: "Proteção em tempo real desativada", data: { protectionEnabled: false, protectionPausedUntil: null } }));
    assert.equal(shown.length, 1);
    mgr.handleEvent(evt({ type: "protection.changed", severity: "low", summary: "Proteção em tempo real ativa", data: { protectionEnabled: true, protectionPausedUntil: null } }));
    assert.equal(shown.length, 2);
    assert.match(shown[1].body, /ativad/i);
  });

  it("protection.changed pausa notifica uma vez", () => {
    const { shown, mgr } = makeHarness();
    mgr.handleEvent(evt({ type: "protection.changed", data: { protectionEnabled: true, protectionPausedUntil: "2026-10-14T12:00:00.000Z" }, summary: "Proteção em tempo real em pausa" }));
    assert.equal(shown.length, 1);
    assert.match(shown[0].body, /pausa/i);
    mgr.handleEvent(evt({ type: "protection.changed", data: { protectionEnabled: true, protectionPausedUntil: "2026-10-14T12:30:00.000Z" }, summary: "Proteção em tempo real em pausa" }));
    assert.equal(shown.length, 1, "mudar o prazo de pausa nao re-notifica o mesmo estado");
  });

  it("pausa tem prioridade sobre desativada: enabled=false com pausa ativa diz pausa", () => {
    const { shown, mgr } = makeHarness();
    mgr.handleEvent(evt({ type: "protection.changed", data: { protectionEnabled: false, protectionPausedUntil: "2026-10-14T12:00:00.000Z" }, summary: "Proteção em tempo real em pausa" }));
    assert.equal(shown.length, 1);
    assert.match(shown[0].body, /pausa/i);
    assert.doesNotMatch(shown[0].body, /monitorizar/i, "a pausa nao pode ser escondida pelo texto de desativada");
  });
});

describe("security-notifications — motor essencial indisponivel", () => {
  it("perda de ligacao notifica uma vez; reconexao notifica recuperacao; repeticoes suprimidas", () => {
    const { shown, mgr } = makeHarness();
    mgr.handleConnectionState(false);
    mgr.handleConnectionState(false);
    assert.equal(shown.length, 1, "down notifica uma unica vez por ciclo");
    assert.match(shown[0].body, /indisponivel|deixou de responder|sem resposta/i);
    mgr.handleConnectionState(true);
    assert.equal(shown.length, 2);
    assert.match(shown[1].body, /disponivel|reativado|restabelecid/i);
    mgr.handleConnectionState(true);
    assert.equal(shown.length, 2);
  });

  it("ligacao inicial verdadeira (arranque normal) nao notifica", () => {
    const { shown, mgr } = makeHarness();
    mgr.handleConnectionState(true);
    assert.equal(shown.length, 0);
  });

  it("engine.health com motor essencial indisponivel notifica; informativo nao", () => {
    const { shown, mgr } = makeHarness();
    mgr.handleEvent(evt({ type: "engine.health", severity: "low", summary: "Definições atualizadas", data: { status: "ok" } }));
    assert.equal(shown.length, 0, "engine.health informativo nao vira toast");
    mgr.handleEvent(evt({ type: "engine.health", severity: "high", summary: "Motor essencial indisponível: ClamAV", data: { essentialUnavailable: true, name: "ClamAV" } }));
    assert.equal(shown.length, 1);
  });
});

describe("security-notifications — privacidade: nada de caminho pessoal no toast", () => {
  it("summary com caminho Windows ESPACADO e sem nome nos dados: so copy generica", () => {
    const { shown, mgr } = makeHarness();
    mgr.handleEvent(evt({
      summary: "Ameaça detetada em C:\\Users\\John Doe\\Downloads\\nota.exe",
      data: null,
    }));
    assert.equal(shown.length, 1);
    assert.match(shown[0].body, /Deteção registada sobre um ficheiro/);
    assert.doesNotMatch(shown[0].body, /John|Doe|Downloads|C:/i, "sem nome estruturado, o toast NAO repete o summary");
  });

  it("verdict comanda a copy: malicious=ameaca, suspicious=suspeito, ausente=alerta neutro; dedup mantem", () => {
    const { shown, mgr, advance } = makeHarness();
    mgr.handleEvent(evt({ data: { fileName: "m.exe", verdict: "malicious" } }));
    assert.match(shown[0].body, /Ameaça detetada em m\.exe/);
    advance(30_000);
    mgr.handleEvent(evt({ data: { fileName: "s.exe", verdict: "suspicious" } }));
    assert.match(shown[1].body, /Ficheiro suspeito detetado: s\.exe/);
    advance(30_000);
    mgr.handleEvent(evt({ data: { fileName: "u.exe", verdict: "unknown" } }));
    assert.match(shown[2].body, /Deteção registada sobre u\.exe/);
    assert.doesNotMatch(shown[2].body, /Ameaça|malicios/i, "sem veredicto confirmado nao se inventa malware");
    // dedup por ficheiro nao depende do prefixo: repetido dentro da janela, calado
    mgr.handleEvent(evt({ data: { fileName: "u.exe", verdict: "unknown" } }));
    assert.equal(shown.length, 3);
  });

  it("process.blocked fala de EXECUCAO bloqueada, nao do processo inteiro", () => {
    const { shown, mgr } = makeHarness();
    mgr.handleEvent(evt({ type: "process.blocked", data: { appName: "powershell.exe" }, summary: "Execução de script malicioso bloqueada (powershell.exe)" }));
    assert.match(shown[0].body, /Execução bloqueada: powershell\.exe/);
    assert.doesNotMatch(shown[0].body, /terminado|morto|kill/i, "bloqueio AMSI nao equivale a processo terminado");
  });

  it("threat com artifactPath spacado: basename completo, zero prefixo privado", () => {
    const { shown, mgr } = makeHarness();
    mgr.handleEvent(evt({ data: { artifactPath: "C:\\Users\\caioc\\Meus Documentos\\nota.exe" } }));
    assert.match(shown[0].body, /nota\.exe/);
    assert.doesNotMatch(shown[0].body, /caioc|Meus Documentos|Users/i);
  });

  it("quarantine.added com fileName que e caminho: corpo usa basename", () => {
    const { shown, mgr } = makeHarness();
    mgr.handleEvent(evt({ type: "quarantine.added", data: { fileName: "C:\\quarantine\\sub\\malware.exe" } }));
    assert.match(shown[0].body, /malware\.exe/);
    assert.doesNotMatch(shown[0].body, /quarantine\\\\|sub|C:/i);
  });

  it("engine.health com name que e caminho: name sanitizado", () => {
    const { shown, mgr } = makeHarness();
    mgr.handleEvent(evt({ type: "engine.health", severity: "high", summary: "x", data: { essentialUnavailable: true, name: "C:\\tools\\caioc\\clamscan.exe" } }));
    assert.match(shown[0].body, /clamscan\.exe/);
    assert.doesNotMatch(shown[0].body, /tools|caioc|C:/i);
  });

  it("UNC e POSIX nos dados estruturados: basename sem sufixo privado", () => {
    const { shown, mgr } = makeHarness();
    mgr.handleEvent(evt({ data: { filePath: "\\\\srv\\share\\dir\\x.dll" } }));
    mgr.handleEvent(evt({ data: { artifactPath: "/home/caioc/secret/y.bin" }, severity: "high" }));
    assert.equal(shown.length, 2);
    assert.match(shown[0].body, /x\.dll/);
    assert.doesNotMatch(shown[0].body, /srv|share|dir/);
    assert.match(shown[1].body, /y\.bin/);
    assert.doesNotMatch(shown[1].body, /home|caioc|secret/);
  });

  it("redaction NAO estraga texto sem caminhos nem muda o dedup por path real", () => {
    const { shown, mgr, advance } = makeHarness();
    const dados = { fileName: "ransomware.exe", verdict: "malicious", artifactPath: "C:\\Users\\caioc\\a.exe" };
    mgr.handleEvent(evt({ summary: "Ameaça detetada em ransomware.exe", data: dados }));
    assert.equal(shown[0].body, "Ameaça detetada em ransomware.exe");
    advance(5_000);
    mgr.handleEvent(evt({ summary: "Ameaça detetada em ransomware.exe", data: dados }));
    assert.equal(shown.length, 1, "fingerprint continua o caminho REAL (interno), a redaction e so no corpo");
  });

  it("safeBasename: separadores Windows+POSIX, caracteres de controlo, teto de comprimento, vazio", () => {
    assert.equal(safeBasename("C:\\Users\\x\\nota.exe"), "nota.exe");
    assert.equal(safeBasename("/home/x/nota.exe"), "nota.exe");
    assert.equal(safeBasename("\\\\srv\\a\\b.dll"), "b.dll");
    assert.equal(safeBasename("nota\r\n.exe"), "nota.exe");
    assert.equal(safeBasename("a".repeat(300)).length, 80);
    assert.equal(safeBasename(""), "elemento");
    assert.equal(safeBasename("C:\\dir\\"), "dir");
    assert.equal(safeBasename(undefined), "elemento");
  });

  it("redactPaths conservadora: espacos, aspas e UNC nunca deixam sufixo privado", () => {
    assert.equal(redactPaths("Processo bloqueado (powershell.exe)"), "Processo bloqueado (powershell.exe)");
    const espacado = redactPaths("Ficheiro C:\\Users\\John Doe\\Downloads\\file.exe detetado");
    assert.match(espacado, /file\.exe/);
    assert.doesNotMatch(espacado, /Users|John Doe\\\\|C:/i, "nunca sobra 'Doe\\Downloads\\file.exe'");
    const aspas = redactPaths('aberta em "C:\\Users\\a b\\x.exe" agora');
    assert.match(aspas, /"x\.exe"/);
    assert.doesNotMatch(aspas, /Users|a b\\\\|C:/i);
    const unc = redactPaths("\\\\filesrv\\publico\\John Doe\\y.dll sumiu");
    assert.match(unc, /y\.dll/);
    assert.doesNotMatch(unc, /filesrv|publico|John/);
  });
});

describe("security-notifications — teto de memoria do dedup", () => {
  it("flood de 1000 alvos distintos: mapa fica <= 512 e o dedup recente nao muda", () => {
    const { shown, mgr } = makeHarness();
    for (let i = 0; i < 1000; i++) {
      mgr.handleEvent(evt({ data: { artifactPath: `C:\\flood\\${i}.exe` } }));
    }
    assert.ok(mgr.trackedSize() <= 512, `tracked=${mgr.trackedSize()} deve ter teto`);
    assert.equal(shown.length, 1000, "alvos diferentes nunca se suprimem entre si");
    shown.length = 0;
    mgr.handleEvent(evt({ data: { artifactPath: "C:\\flood\\999.exe" } }));
    assert.equal(shown.length, 0, "alvo recente continua deduplicado dentro da janela");
    shown.length = 0;
    mgr.handleEvent(evt({ data: { artifactPath: "C:\\flood\\0.exe" } }));
    assert.equal(shown.length, 1, "o alvo evacuado (mais antigo) pode voltar a avisar — custo honesto do teto");
  });
});

describe("security-notifications — sem spam benigno", () => {
  const BENIGN = [
    "file.created",
    "file.modified",
    "file.renamed",
    "process.started",
    "process.exited",
    "scan.progress",
    "artifact.discovered",
    "artifact.analyzed",
    "trust.updated",
    "threat.resolved",
    "quarantine.restored",
    "scheduledtask.changed",
  ];
  for (const type of BENIGN) {
    it(`\`${type}\` nunca notifica`, () => {
      const { shown, mgr } = makeHarness();
      mgr.handleEvent(evt({ type, severity: "low", summary: type, data: { path: "C:\\x\\y.txt" } }));
      assert.equal(shown.length, 0);
    });
  }

  it("SECURITY_EVENT_TYPES lista exatamente os tipos elegiveis", () => {
    assert.deepEqual(
      [...SECURITY_EVENT_TYPES].sort(),
      ["process.blocked", "process.suspicious", "protection.changed", "quarantine.added", "quarantine.failed", "threat.detected"].sort(),
    );
  });
});

describe("security-notifications — dedup por fingerprint", () => {
  it("mesmo artefacto repetido dentro da janela so notifica uma vez", () => {
    const { shown, mgr, advance } = makeHarness();
    mgr.handleEvent(evt({ data: { artifactPath: "C:\\temp\\dup.exe" } }));
    advance(5_000);
    mgr.handleEvent(evt({ summary: "outro resumo para o mesmo ficheiro", data: { artifactPath: "C:\\temp\\dup.exe" } }));
    assert.equal(shown.length, 1, "fingerprint e o alvo, nao o resumo");
    advance(20_000);
    mgr.handleEvent(evt({ data: { artifactPath: "C:\\temp\\dup.exe" } }));
    assert.equal(shown.length, 2, "passada a janela, a mesma ameaca pode voltar a avisar");
  });

  it("artefactos diferentes nao se deduplicam entre si", () => {
    const { shown, mgr } = makeHarness();
    mgr.handleEvent(evt({ data: { artifactPath: "C:\\a.exe" } }));
    mgr.handleEvent(evt({ data: { artifactPath: "C:\\b.exe" } }));
    assert.equal(shown.length, 2);
  });

  it("sem fingerprint utilizavel, o summary evita o crash e deduplica", () => {
    const { shown, mgr } = makeHarness();
    mgr.handleEvent(evt({ data: null, summary: "Ameaça sem path" }));
    mgr.handleEvent(evt({ data: null, summary: "Ameaça sem path" }));
    assert.equal(shown.length, 1);
  });

  it("threat.detected real (filePath, sem artifactPath nem fileName) deduplica pelo ficheiro", () => {
    const { shown, mgr, advance } = makeHarness();
    const threatData = { filePath: "C:\\temp\\ameaca.dll", url: "http://x/ameaca.dll", riskScore: 90 };
    mgr.handleEvent(evt({ severity: "high", summary: "Ameaça detetada em ameaca.dll", data: threatData }));
    advance(5_000);
    mgr.handleEvent(evt({ severity: "critical", summary: "Ameaça detetada em ameaca.dll (reanálise)", data: { ...threatData, riskScore: 95 } }));
    assert.equal(shown.length, 1, "o fingerprint usa filePath quando artifactPath/fileName faltam");
    advance(20_000);
    mgr.handleEvent(evt({ severity: "high", summary: "Ameaça detetada em ameaca.dll", data: threatData }));
    assert.equal(shown.length, 2);
  });
});
