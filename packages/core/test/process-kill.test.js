import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  KILL_REAP_DEADLINE_MS,
  TASKKILL_TIMEOUT_MS,
  classifyKillTarget,
  firstDiagnosticLine,
  interpretTaskkillOutcome,
  isAliasStubTarget,
  isProcessAlive,
  killProcessTree,
  killTargetIdentity,
  normalizeProcessPath,
  reconcileProcessExit,
  taskkillArgs,
  normalizeTaskkillText,
  decideTaskkillRetry,
  treeChildrenOf,
  planTreeSweep,
  TREE_SWEEP_MAX_TARGETS,
} from "../dist/response.js";

/**
 * Regressão do kill de processos (Gestor de Tarefas).
 *
 * Bug manual: excluir deixava a página presa (taskkill sem prazo) e o processo
 * continuava na lista. O backend tem agora (a) `taskkill` com timeout real,
 * (b) resultado estruturado, (c) auto-proteção por PID/ppid/path (nome só em
 * fallback) e (d) reconciliação autoritativa antes de publicar `process.killed`.
 *
 * Regressão P0 seguinte: o `stdio: "ignore"` descartava stdout/stderr e os
 * códigos != 0/128 (ex.: 5 = acesso negado) viravam "erro genérico" sem
 * diagnóstico nenhum. Agora o output é capturado e classificado.
 */

function fakeChild({ stdout = "", stderr = "" } = {}) {
  const child = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  // O killProcessTree real usa stdio em pipe — o fake também tem de ter
  // streams, com o output já escrito (fica em buffer até aos listeners).
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  if (stdout) child.stdout.write(stdout);
  if (stderr) child.stderr.write(stderr);
  child.stdout.end();
  child.stderr.end();
  return child;
}

const emitSoon = (child, event, ...args) => setImmediate(() => child.emit(event, ...args));

describe("killProcessTree — prazo real e resultado estruturado", () => {
  it("exit 0 → ok/ok, com o stdout real capturado", async () => {
    const child = fakeChild({ stdout: "SUCCESS: The process with PID 4242 has been terminated.\n" });
    const pending = killProcessTree(4242, { spawnImpl: () => child });
    emitSoon(child, "exit", 0);
    emitSoon(child, "close", 0);
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.status, "ok");
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout ?? "", /SUCCESS/, "o stdout do taskkill é preservado");
    assert.equal(result.stderr, "");
  });

  it("exit 128 → not-found (o alvo já não existia) com a linha real", async () => {
    const child = fakeChild({ stderr: 'ERROR: The process "4242" not found.\n' });
    const pending = killProcessTree(4242, { spawnImpl: () => child });
    emitSoon(child, "exit", 128);
    emitSoon(child, "close", 128);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.status, "not-found");
    assert.equal(result.exitCode, 128);
    assert.match(result.error ?? "", /not found/);
  });

  it("exit 5 → access-denied com a mensagem real do taskkill (nunca genérico)", async () => {
    const child = fakeChild({ stderr: "ERRO: O processo 4242 não pode ser terminado. Razão: Acesso negado.\n" });
    const pending = killProcessTree(4242, { spawnImpl: () => child });
    emitSoon(child, "exit", 5);
    emitSoon(child, "close", 5);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.status, "access-denied");
    assert.equal(result.exitCode, 5);
    assert.match(result.error ?? "", /Acesso negado/);
    assert.match(result.stderr ?? "", /Acesso negado/);
  });

  it("exit 1 com texto de acesso negado → access-denied (não falha genérica)", async () => {
    const child = fakeChild({ stderr: "ERROR: The process \"4242\" could not be terminated. Reason: Access is denied.\n" });
    const pending = killProcessTree(4242, { spawnImpl: () => child });
    emitSoon(child, "exit", 1);
    emitSoon(child, "close", 1);
    const result = await pending;
    assert.equal(result.status, "access-denied");
    assert.match(result.error ?? "", /Access is denied/);
  });

  it("exit != 0/128/5 → failed com o código e a mensagem real", async () => {
    const child = fakeChild({ stderr: "ERRO: argumento inválido.\n" });
    const pending = killProcessTree(4242, { spawnImpl: () => child });
    emitSoon(child, "exit", 1);
    emitSoon(child, "close", 1);
    const result = await pending;
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 1);
    assert.match(result.error ?? "", /argumento inválido/);
  });

  it("erro de spawn → failed, sem ficar pendente", async () => {
    const result = await killProcessTree(4242, {
      spawnImpl: () => {
        throw new Error("spawn ENOENT");
      },
    });
    assert.equal(result.status, "failed");
    assert.match(result.error, /ENOENT/);
  });

  it("taskkill que não termina é abortado no prazo (timeout real)", async () => {
    const child = fakeChild();
    const startedAt = Date.now();
    const result = await killProcessTree(4242, { timeoutMs: 15, spawnImpl: () => child });

    assert.equal(result.status, "timeout");
    assert.equal(result.ok, false);
    assert.equal(child.killed, true, "o processo taskkill tem de ser morto");
    assert.ok(Date.now() - startedAt < 2_000, "não pode esperar indefinidamente");
  });

  it("um close tardio depois do timeout não muda o resultado", async () => {
    const child = fakeChild();
    const pending = killProcessTree(4242, { timeoutMs: 15, spawnImpl: () => child });
    const result = await pending;
    child.emit("close", 0);
    assert.equal(result.status, "timeout");
  });

  it("expõe prazos default positivos", () => {
    assert.ok(TASKKILL_TIMEOUT_MS > 0);
    assert.ok(KILL_REAP_DEADLINE_MS > 0);
  });
});

describe("interpretTaskkillOutcome — tabela de classificação (exit code + output real)", () => {
  const base = { stdout: "", stderr: "", timedOut: false };

  it("0 → ok", () => {
    assert.deepEqual(interpretTaskkillOutcome({ ...base, exitCode: 0 }), { ok: true, status: "ok" });
  });

  it("128 → not-found, com a linha do taskkill quando existe", () => {
    const hit = interpretTaskkillOutcome({ ...base, exitCode: 128, stderr: "ERROR: The process \"9\" not found." });
    assert.equal(hit.status, "not-found");
    assert.match(hit.error ?? "", /not found/);
    const bare = interpretTaskkillOutcome({ ...base, exitCode: 128 });
    assert.match(bare.error ?? "", /já não existe/);
  });

  it("5 → access-denied; 1 com texto de acesso negado também", () => {
    assert.equal(interpretTaskkillOutcome({ ...base, exitCode: 5 }).status, "access-denied");
    const denied = interpretTaskkillOutcome({ ...base, exitCode: 1, stderr: "Acesso negado." });
    assert.equal(denied.status, "access-denied");
    assert.match(denied.error ?? "", /Acesso negado/);
  });

  it("timeout tem prioridade sobre qualquer código", () => {
    const out = interpretTaskkillOutcome({ ...base, exitCode: 0, timedOut: true });
    assert.equal(out.status, "timeout");
    assert.equal(out.ok, false);
  });

  it("código inesperado → failed com mensagem honesta (com ou sem output)", () => {
    const withLine = interpretTaskkillOutcome({ ...base, exitCode: 3, stderr: " ERRO: qualquer coisa. \n lixo" });
    assert.equal(withLine.status, "failed");
    assert.equal(withLine.error, "ERRO: qualquer coisa.");
    const bare = interpretTaskkillOutcome({ ...base, exitCode: 3 });
    assert.match(bare.error ?? "", /código 3/);
    const unknown = interpretTaskkillOutcome({ ...base, exitCode: null });
    assert.match(unknown.error ?? "", /desconhecido/);
  });
});

describe("firstDiagnosticLine", () => {
  it("prioriza stderr sobre stdout e salta linhas vazias", () => {
    assert.equal(firstDiagnosticLine("OUT: linha stdout", "ERRO: linha stderr"), "ERRO: linha stderr");
    assert.equal(firstDiagnosticLine("OUT: linha stdout", "\r\n  \r\nERRO: segunda"), "ERRO: segunda");
    assert.equal(firstDiagnosticLine("OUT: só stdout", ""), "OUT: só stdout");
    assert.equal(firstDiagnosticLine("", ""), "");
  });
});

describe("isProcessAlive", () => {
  it("o próprio processo está vivo", () => {
    assert.equal(isProcessAlive(process.pid), true);
  });

  it("PIDs inválidos nunca estão vivos", () => {
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      assert.equal(isProcessAlive(pid), false, String(pid));
    }
  });
});

describe("normalizeProcessPath", () => {
  it("normaliza barras, maiúsculas e prefixo \\\\?\\", () => {
    assert.equal(normalizeProcessPath("C:/Program Files/CyberSafe/Service.exe"), "c:\\program files\\cybersafe\\service.exe");
    assert.equal(normalizeProcessPath("\\\\?\\C:\\Windows\\System32\\svchost.exe"), "c:\\windows\\system32\\svchost.exe");
    assert.equal(normalizeProcessPath("  C:\\A\\B.EXE  "), "c:\\a\\b.exe");
  });

  it("entradas vazias devolvem string vazia", () => {
    for (const value of [undefined, null, ""]) {
      assert.equal(normalizeProcessPath(value), "");
    }
  });
});

describe("killTargetIdentity", () => {
  it("distingue processos por nome + linha de comando", () => {
    const a = killTargetIdentity({ name: "Chrome.exe", commandLine: "chrome.exe --type=renderer" });
    const b = killTargetIdentity({ name: "chrome.exe", commandLine: "chrome.exe --type=renderer" });
    assert.equal(a, b, "nome é case-insensitive");
    assert.notEqual(a, killTargetIdentity({ name: "chrome.exe", commandLine: "chrome.exe --type=gpu" }));
    assert.notEqual(a, killTargetIdentity({ name: "edge.exe", commandLine: "chrome.exe --type=renderer" }));
  });
});

describe("isAliasStubTarget — stub App Execution Alias (MSIX) vs exe real", () => {
  it("deteta o launcher em %LOCALAPPDATA%\\Microsoft\\WindowsApps (path ou commandLine)", () => {
    assert.equal(
      isAliasStubTarget({ pid: 1, path: "C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\Notepad.exe", commandLine: "Notepad.exe" }),
      true,
    );
    assert.equal(
      isAliasStubTarget({ pid: 1, commandLine: "c:/users/x/appdata/local/microsoft/windowsapps/notepad.exe" }),
      true,
      "normaliza barras e maiúsculas",
    );
  });

  it("NUNCA confunde com o exe real empacotado sob Program Files\\WindowsApps", () => {
    assert.equal(
      isAliasStubTarget({
        pid: 1,
        path: "C:\\Program Files\\WindowsApps\\Microsoft.WindowsNotepad_11.2607.14.0_x64__8wekyb3d8bbwe\\Notepad\\Notepad.exe",
        commandLine: "C:\\Program Files\\WindowsApps\\Microsoft.WindowsNotepad_11.2607.14.0_x64__8wekyb3d8bbwe\\Notepad\\Notepad.exe",
      }),
      false,
    );
  });

  it("processo comum sem path nem commandLine não é stub", () => {
    assert.equal(isAliasStubTarget({ pid: 1 }), false);
    assert.equal(isAliasStubTarget({ pid: 1, path: "C:\\Windows\\notepad.exe", commandLine: "notepad.exe" }), false);
  });
});

describe("classifyKillTarget — PID/ppid/path primeiro, nome só fallback", () => {
  const ctx = {
    selfPid: 1000,
    ancestorPids: [900, 500],
    internalPaths: [normalizeProcessPath("C:\\Program Files\\CyberSafe\\service.exe")],
    fallbackNames: ["svchost.exe", "explorer.exe"],
    systemPidThreshold: 100,
  };

  it("protege o próprio serviço por PID", () => {
    assert.equal(classifyKillTarget({ pid: 1000 }, ctx), "self");
  });

  it("protege PIDs de sistema por limiar", () => {
    assert.equal(classifyKillTarget({ pid: 4 }, ctx), "system-pid");
  });

  it("protege ancestrais por PID", () => {
    assert.equal(classifyKillTarget({ pid: 900, name: "explorer.exe" }, ctx), "ancestor");
  });

it("protege componentes internos por ppid — apenas filhos DIRECTOS do serviço", () => {
  // Filho directo: continua protegido.
  assert.equal(classifyKillTarget({ pid: 1234, ppid: 1000 }, ctx), "internal");
  // Filho de um ANCESTRAL: deixa de ser "internal". Esta era a regra que
  // classificava como componente do CyberSafe qualquer aplicacao normal aberta
  // a partir do mesmo explorer/sessao — provado num Notepad vivo (PID 35744,
  // ppid 1628 = explorer.exe) recusado 4x com protectedReason "internal".
  // Um irmao de outra ramificacao do ancestral nao e um componente.
  assert.equal(classifyKillTarget({ pid: 1234, ppid: 500 }, ctx), null);
  assert.equal(classifyKillTarget({ pid: 1234, ppid: 900 }, ctx), null);
});

  it("protege componentes internos por caminho (case-insensitive)", () => {
    assert.equal(
      classifyKillTarget({ pid: 1234, path: "C:\\Program Files\\CyberSafe\\SERVICE.EXE" }, ctx),
      "internal",
    );
  });

  it("usa o nome APENAS quando não há caminho fiável", () => {
    assert.equal(classifyKillTarget({ pid: 1234, name: "Svchost.exe" }, ctx), "fallback-name");
    // Com caminho conhecido, o nome deixa de decidir.
    assert.equal(
      classifyKillTarget({ pid: 1234, name: "svchost.exe", path: "C:\\Windows\\System32\\svchost.exe" }, ctx),
      null,
    );
  });

  it("um processo normal não é protegido", () => {
    assert.equal(classifyKillTarget({ pid: 1234, name: "notepad.exe", path: "C:\\Windows\\notepad.exe" }, ctx), null);
  });
});

describe("classifyKillTarget — ligações runtime/projeto/app por path e commandLine", () => {
  const ctx = {
    selfPid: 1000,
    ancestorPids: [],
    internalPaths: [],
    internalPathPrefixes: [normalizeProcessPath("C:\\CyberSafe\\app")],
    commandLineMarkers: ["cybersafe", normalizeProcessPath("C:\\CyberSafe\\service\\dist")],
    fallbackNames: ["svchost.exe"],
    systemPidThreshold: 100,
  };

  it("protege por prefixo de diretório da app (com fronteira de separador)", () => {
    assert.equal(classifyKillTarget({ pid: 5000, path: "C:\\CyberSafe\\app\\electron.exe" }, ctx), "internal");
    // 'app-extra' não é a pasta da app: sem falso positivo por prefixo de texto.
    assert.equal(classifyKillTarget({ pid: 5000, path: "C:\\CyberSafe\\app-extra\\evil.exe" }, ctx), null);
  });

  it("protege node/electron/powershell só quando a commandLine liga ao projeto", () => {
    assert.equal(
      classifyKillTarget({
        pid: 5000,
        name: "node.exe",
        path: "C:\\Program Files\\nodejs\\node.exe",
        commandLine: "node C:\\proj\\cybersafe-assistant\\packages\\service\\dist\\index.js",
      }, ctx),
      "internal",
    );
    assert.equal(
      classifyKillTarget({ pid: 5000, name: "node.exe", path: "C:\\Program Files\\nodejs\\node.exe", commandLine: "node server.js" }, ctx),
      null,
      "um node qualquer não pode ser bloqueado globalmente",
    );
    assert.equal(
      classifyKillTarget({
        pid: 5000,
        name: "powershell.exe",
        path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        commandLine: "powershell -NoProfile -Command Start-Sleep 60",
      }, ctx),
      null,
      "um powershell qualquer não pode ser bloqueado globalmente",
    );
  });

  it("não protege por nome quando há commandLine/path fiáveis", () => {
    assert.equal(
      classifyKillTarget({ pid: 5000, name: "svchost.exe", path: "C:\\Windows\\System32\\svchost.exe", commandLine: "svchost.exe -k netsvcs" }, ctx),
      null,
    );
  });
});

describe("reconcileProcessExit — só publica depois de o PID desaparecer", () => {
  it("exited quando o PID desaparece", async () => {
    let slept = 0;
    const status = await reconcileProcessExit({
      pid: 42,
      probe: () => ({ alive: false }),
      sleep: async () => { slept += 1; },
    });
    assert.equal(status.status, "exited");
    assert.equal(slept, 0);
  });

  it("reused quando o PID continua vivo com outra identidade", async () => {
    const status = await reconcileProcessExit({
      pid: 42,
      originalIdentity: "old.exe|old.exe",
      probe: () => ({ alive: true, identity: "new.exe|new.exe" }),
      sleep: async () => {},
    });
    assert.equal(status.status, "reused");
  });

  it("still-running quando o PID nunca desaparece dentro do prazo", async () => {
    let clock = 0;
    const status = await reconcileProcessExit({
      pid: 42,
      originalIdentity: "app.exe|app.exe",
      probe: () => ({ alive: true, identity: "app.exe|app.exe" }),
      deadlineMs: 30,
      intervalMs: 10,
      now: () => clock,
      sleep: async () => { clock += 10; },
    });
    assert.equal(status.status, "still-running");
  });

  it("identidade desconhecida não é tratada como reuse (espera o desaparecimento)", async () => {
    const status = await reconcileProcessExit({
      pid: 42,
      originalIdentity: "app.exe|app.exe",
      probe: () => ({ alive: false }),
      sleep: async () => {},
    });
    assert.equal(status.status, "exited");
  });
});

/**
 * O comando real do taskkill. Regressão provada em actions.log: a linha a
 * registar `Cmd=taskkill /PID x /T /F` enquanto o spawn passava outra coisa é
 * pior do que não ter log — faz-nos confiar numa evidência falsa.
 *
 * `/F` antes de `/PID` não é cosmético aqui: sem `/F` o taskkill pede um fecho
 * gracioso à janela, e um Notepad com documento por guardar nunca responde
 * (o "A terminar processo" lento e por nunca acabar). `/T` leva a árvore, que é
 * o que os pacotes MSIX precisam.
 */
describe("taskkillArgs — um comando, uma fonte, sem deriva entre log e spawn", () => {
  it("/F e /T antes do /PID, exatamente um de cada, e o PID alvo", () => {
    assert.deepEqual(taskkillArgs(4321), ["/F", "/T", "/PID", "4321"]);
    const args = taskkillArgs(4321);
    assert.ok(args.indexOf("/F") < args.indexOf("/PID"), "/F tem de vir antes do /PID");
    assert.ok(args.indexOf("/T") < args.indexOf("/PID"), "/T tem de vir antes do /PID");
    assert.equal(args.filter((a) => a === "/F").length, 1);
    assert.equal(args.filter((a) => a === "/T").length, 1);
    assert.equal(args.filter((a) => a === "/PID").length, 1, "um so PID alvo, nunca /IM");
  });

  it("killProcessTree entrega ao spawn exatamente taskkillArgs", async () => {
    const calls = [];
    const child = fakeChild({ stdout: "SUCCESS: The process with PID 4321 has been terminated.\n" });
    const pending = killProcessTree(4321, {
      spawnImpl: (cmd, args, options) => {
        calls.push({ cmd, args, options });
        return child;
      },
    });
    emitSoon(child, "exit", 0);
    emitSoon(child, "close", 0);
    const result = await pending;

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "taskkill");
    assert.deepEqual(calls[0].args, taskkillArgs(4321), "o argv executado e o argv canónico");
    assert.deepEqual(calls[0].args, ["/F", "/T", "/PID", "4321"]);
    // stdio em pipe (nunca "ignore") — sem isto o stderr do taskkill perde-se.
    assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  });

  it("o PID chega como string e sem flags extras entre /PID e o numero", () => {
    const args = taskkillArgs(7);
    const pidIndex = args.indexOf("/PID");
    assert.equal(args[pidIndex + 1], "7");
    assert.equal(args.length, pidIndex + 2, "nada depois do PID");
  });
});

/**
 * ROUND 2 — o exit 255 nao e uma categoria, e um caixote.
 *
 * Evidence real do actions.log: pid 22660 → taskkill Exit=255 com
 * "Não foi possível terminar o processo" em pt-PT, e o codigo nao distinguish
 * "ja nao existe" de "nao consegui terminar". Alem disso, repetir o taskkill
 * sem perguntar ao Windows se o PID la estava era o ciclo que se chamava
 * resiliencia a si proprio.
 */
const base = { stdout: "", stderr: "", timedOut: false };

describe("normalizeTaskkillText — a mensagem chega partido da codepage", () => {
  it("tira acentos, passa a minusculas e colapsa espaços", () => {
    assert.equal(normalizeTaskkillText("  Não   Foi Possível TERMINAR "), "nao foi possivel terminar");
    assert.equal(normalizeTaskkillText("Acesso é negado."), "acesso e negado.");
  });

  it("sobrevive a null/undefined sem rebentar", () => {
    assert.equal(normalizeTaskkillText(undefined), "");
    assert.equal(normalizeTaskkillText(null), "");
  });
});

describe("interpretTaskkillOutcome — classificacao do 255 pela mensagem", () => {
  it("255 + 'não foi possível terminar' (acentos partidos) continua failed, com a mensagem real", () => {
    const out = interpretTaskkillOutcome({
      ...base,
      exitCode: 255,
      stderr: "ERRO: Não foi possível terminar o processo com PID: 22660.\n",
    });
    assert.equal(out.ok, false);
    assert.equal(out.status, "failed");
    assert.match(out.error ?? "", /Não foi possível terminar/, "a mensagem do Windows e que se mostra");
  });

  it("255 + mensagem de PID inexistente vira not-found (nao falha generica)", () => {
    const out = interpretTaskkillOutcome({ ...base, exitCode: 255, stderr: "ERROR: The process \"9\" not found." });
    assert.equal(out.status, "not-found");
  });

  it("255 + 'tarefa inexistente' em pt-PT vira not-found, com o nome da tarefa entre aspas", () => {
    const out = interpretTaskkillOutcome({
      ...base,
      exitCode: 255,
      stderr: "ERRO: Não há ocorrência da tarefa \"22660\" em execução.\n",
    });
    assert.equal(out.ok, false);
    assert.equal(out.status, "not-found");
    assert.equal(
      interpretTaskkillOutcome({ ...base, exitCode: 255, stderr: 'ERROR: The task "22660" not found.' }).status,
      "not-found",
    );
  });

  it("255 + acesso negado vira access-denied, em pt e en", () => {
    assert.equal(
      interpretTaskkillOutcome({ ...base, exitCode: 255, stderr: "ERRO: Acesso negado." }).status,
      "access-denied",
    );
    assert.equal(
      interpretTaskkillOutcome({ ...base, exitCode: 255, stderr: "ERROR: Access is denied." }).status,
      "access-denied",
    );
  });

  it("sem mensagem utilizável, nao se inventa nada: falha com o codigo", () => {
    const out = interpretTaskkillOutcome({ ...base, exitCode: 255 });
    assert.equal(out.status, "failed");
    assert.match(out.error ?? "", /255/);
  });
});

describe("decideTaskkillRetry — so se o Windows disser que esta vivo", () => {
  it("PID morto para logo, mesmo com orcamento e tentativas sobras", () => {
    assert.equal(decideTaskkillRetry({ attempts: 1, targetAlive: false, budgetRemainingMs: 9_000, status: "failed" }), "stop");
  });

  it("not-found e access-denied nao repetem: a segunda tentativa daria no mesmo", () => {
    for (const status of ["not-found", "access-denied"]) {
      assert.equal(decideTaskkillRetry({ attempts: 1, targetAlive: true, budgetRemainingMs: 9_000, status }), "stop", status);
    }
  });

  it("vivo + falha generica = uma repeticao, e nunca uma terceira", () => {
    assert.equal(decideTaskkillRetry({ attempts: 1, targetAlive: true, budgetRemainingMs: 9_000, status: "failed" }), "retry");
    assert.equal(decideTaskkillRetry({ attempts: 2, targetAlive: true, budgetRemainingMs: 9_000, status: "failed" }), "stop");
  });

  it("sem orcamento nao se inicia outra tentativa", () => {
    assert.equal(decideTaskkillRetry({ attempts: 1, targetAlive: true, budgetRemainingMs: 0, status: "failed" }), "stop");
  });
});

describe("arvore — filhos proprios e varredura segura", () => {
  const rows = [
    { pid: 100, ppid: 4, name: "raiz.exe" },
    { pid: 101, ppid: 100, name: "filho.exe" },
    { pid: 102, ppid: 101, name: "neto.exe" },
    { pid: 103, ppid: 999, name: "nao-e-da-arvore.exe" },
  ];
  const context = {
    selfPid: 4,
    ancestorPids: [3],
    internalPaths: [],
    internalPathPrefixes: ["c:\\program files\\cybersafe"],
    commandLineMarkers: [],
    fallbackNames: ["svchost.exe"],
    systemPidThreshold: 100,
  };

  it("treeChildrenOf so aceita quem declara aquele ppid", () => {
    assert.deepEqual(treeChildrenOf(100, rows).map((r) => r.pid), [101]);
    assert.deepEqual(treeChildrenOf(999, rows).map((r) => r.pid), [103]);
    // um linho sem ppid nao e filho de ninguem
    assert.deepEqual(treeChildrenOf(100, [{ pid: 7 }]), []);
  });

  it("planTreeSweep desce niveis e mata um a um, sem incluir a raiz nem estranhos", () => {
    const plan = planTreeSweep({ rootPid: 100, rows, context });
    assert.deepEqual(plan.targets, [101, 102]);
    assert.equal(plan.targets.includes(100), false, "a raiz nao e alvo da varredura");
    assert.equal(plan.targets.includes(103), false, "quem nao e descendente nao e tocado");
  });

  it("recusa componentes do CyberSafe e PIDs de sistema, e reporta a recusa", () => {
    const protectedRows = [
      { pid: 101, ppid: 100, name: "filho.exe" },
      { pid: 55, ppid: 101, name: "svchost.exe" },
      { pid: 104, ppid: 101, path: "C:\\Program Files\\CyberSafe\\service.exe" },
      { pid: 4, ppid: 101, name: "system" },
    ];
    const plan = planTreeSweep({ rootPid: 100, rows: protectedRows, context });
    assert.deepEqual(plan.targets, [101], "so o filho normal e abatido");
    assert.deepEqual(plan.refusedProtected.sort((a, b) => a - b), [4, 55, 104]);
  });

  it("tem teto de alvos para a enumeracao nao correr descontrolada", () => {
    const many = [{ pid: 100, ppid: 4 }];
    for (let i = 0; i < TREE_SWEEP_MAX_TARGETS + 10; i += 1) many.push({ pid: 1000 + i, ppid: 100, name: `w${i}.exe` });
    const plan = planTreeSweep({ rootPid: 100, rows: many, context });
    assert.equal(plan.targets.length, TREE_SWEEP_MAX_TARGETS);
  });
});
