/**
 * Integration test for the scan event pipeline.
 *
 * It exercises the REAL transport contract from end to end, without Electron:
 *
 *   test client (same framing as desktop ServiceClient)
 *     → named pipe (same protocol as the engine pipe server)
 *     → real ScanManager (+ a stub analysis engine)
 *     → scan.progress events back to the client
 *
 * This is the test that would have caught the "A aguardar dados do motor de
 * análise" bug: the first progress event is emitted by the scan worker BEFORE
 * the `scan.start` response reaches the renderer, and the surface has to keep
 * the events (listener registered up front + early-event buffer + snapshot).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import AdmZip from "adm-zip";
import { encodeMessage, decodeMessages } from "@cybersafe/core";
import { ScanManager } from "../dist/scan-manager.js";

let pipeSequence = 0;
const uniquePipeName = () => `\\\\.\\pipe\\cybersafe-scan-test-${process.pid}-${++pipeSequence}`;

const tempDirs = [];
async function makeTempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `cybersafe-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function waitFor(predicate, timeoutMs = 8000) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Minimal stand-in for the engine's pipe server + emitScanProgress contract. */
async function createHarness({ delayMs = 0, threatFiles = [] } = {}) {
  const clients = new Set();
  const engine = {
    scannedFiles: [],
    scanArtifact: async (filePath) => {
      engine.scannedFiles.push(filePath);
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      const isThreat = threatFiles.includes(path.basename(filePath));
      return { highRiskCount: isThreat ? 1 : 0, overallSeverity: isThreat ? "high" : "safe" };
    },
    emitScanProgress: () => {},
  };
  const manager = new ScanManager(engine);

  const broadcast = (message) => {
    const payload = encodeMessage(message);
    for (const socket of clients) {
      try {
        socket.write(payload);
      } catch {
        clients.delete(socket);
      }
    }
  };

  // Same payload shape as ProtectionEngineService.emitScanProgress().
  engine.emitScanProgress = (scanState) => {
    broadcast({
      type: "event",
      event: {
        id: `scan-progress-${scanState.id}`,
        type: "scan.progress",
        timestamp: new Date().toISOString(),
        sequence: Date.now(),
        severity: "low",
        summary: `Análise ${scanState.status}: ${scanState.filesScanned} ficheiros, ${scanState.threatsFound} ameaças`,
        data: scanState,
      },
    });
  };

  const dispatch = async (method, payload) => {
    switch (method) {
      case "scan.start": {
        const id = await manager.startScan(payload.type, payload.targetPath);
        if (!id) throw new Error("Já existe uma análise em curso.");
        return { id, success: true };
      }
      case "scan.getActive":
        return manager.getActiveScan() ?? null;
      case "scan.cancel":
        manager.cancelScan(payload.id);
        return { success: true };
      default:
        throw new Error(`Unsupported method: ${method}`);
    }
  };

  const server = net.createServer((socket) => {
    clients.add(socket);
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk.toString();
      const decoded = decodeMessages(buffer);
      buffer = decoded.rest;
      for (const message of decoded.messages) {
        if (message?.type !== "request") continue;
        try {
          const result = await dispatch(message.method, message.payload);
          socket.write(encodeMessage({ id: message.id, type: "response", ok: true, result }));
        } catch (err) {
          socket.write(encodeMessage({
            id: message.id,
            type: "response",
            ok: false,
            error: err?.message ?? String(err),
          }));
        }
      }
    });
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });

  const pipeName = uniquePipeName();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipeName, resolve);
  });

  return {
    pipeName,
    manager,
    close: async () => {
      for (const socket of clients) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Client with the same framing/behaviour as desktop/src/service-client.ts. */
function connectClient(pipeName) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeName);
    const events = [];
    const pending = new Map();
    let buffer = "";
    let counter = 0;

    socket.on("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const decoded = decodeMessages(buffer);
      buffer = decoded.rest;
      for (const message of decoded.messages) {
        if (message?.type === "event" && message.event) {
          if (message.event.type === "scan.progress") events.push(message.event.data);
          continue;
        }
        if (message?.type === "response" && message.id) {
          const entry = pending.get(message.id);
          if (!entry) continue;
          pending.delete(message.id);
          if (message.ok) entry.resolve(message.result);
          else entry.reject(new Error(message.error ?? "request failed"));
        }
      }
    });

    socket.on("connect", () => resolve({
      events,
      request(method, payload) {
        return new Promise((res, rej) => {
          const id = `req-${++counter}`;
          pending.set(id, { resolve: res, reject: rej });
          socket.write(encodeMessage({ id, type: "request", method, payload }));
        });
      },
      close() {
        socket.destroy();
      },
    }));
  });
}

describe("Scan event pipeline (real pipe protocol)", () => {
  it("delivers start → progress → completed for one single scan id", async () => {
    const probeDir = await makeTempDir("scan-probe");
    await fs.writeFile(path.join(probeDir, "test.txt"), "conteudo inofensivo");
    await fs.writeFile(path.join(probeDir, "sample.ps1"), "Write-Output 'harmless'");
    await fs.mkdir(path.join(probeDir, "sub"), { recursive: true });
    await fs.writeFile(path.join(probeDir, "sub", "notes.txt"), "notas");
    const zip = new AdmZip();
    zip.addFile("hello.txt", Buffer.from("hello"));
    zip.addFile("evil.exe", Buffer.from("MZ harmless marker"));
    zip.writeZip(path.join(probeDir, "archive.zip"));

    const harness = await createHarness({ threatFiles: ["evil.exe"] });
    const client = await connectClient(harness.pipeName);

    try {
      const start = await client.request("scan.start", { type: "custom", targetPath: probeDir });
      assert.equal(start.success, true);
      assert.ok(start.id, "start response must carry the scan id");

      // The worker emits its first progress BEFORE the start response is
      // written back — this is exactly the race the renderer must buffer.
      assert.ok(
        client.events.length >= 1,
        "the first progress event must already have been delivered (early event)"
      );

      await waitFor(() => client.events.some((event) => event.status === "completed"));

      const scanEvents = client.events.filter((event) => event.id === start.id);
      assert.ok(scanEvents.length >= 2, `expected several progress events, got ${scanEvents.length}`);
      assert.equal(
        scanEvents.length,
        client.events.length,
        "every event must belong to the single active scan (no stray ids)"
      );

      const gathering = scanEvents.filter((event) => event.phase === "gathering");
      assert.ok(gathering.length > 0, "a gathering event must reach the client");
      assert.ok(
        gathering.some((event) => typeof event.filesDiscovered === "number"),
        "gathering events must report discovered files"
      );

      const terminal = scanEvents.at(-1);
      assert.equal(terminal.status, "completed");
      assert.equal(terminal.progress, 100);
      assert.ok(terminal.filesScanned >= 4, `expected the probe files to be analyzed, got ${terminal.filesScanned}`);
      assert.ok(terminal.threatsFound >= 1, "the threat inside the archive must be counted");
      assert.ok(terminal.endTime, "terminal state must include endTime");

      // Snapshot API used by the UI for resync must agree with the events.
      const active = await client.request("scan.getActive", undefined);
      assert.equal(active, null, "no active scan once completed");
    } finally {
      client.close();
      await harness.close();
    }
  });

  it("refuses a second scan while one is running and keeps one scan id", async () => {
    const scanDir = await makeTempDir("scan-single");
    await fs.mkdir(path.join(scanDir, "files"));
    const structure = [];
    for (let i = 0; i < 40; i++) structure.push(fs.writeFile(path.join(scanDir, "files", `f${i}.txt`), "x"));
    await Promise.all(structure);

    const harness = await createHarness({ delayMs: 20 });
    const client = await connectClient(harness.pipeName);

    try {
      const first = await client.request("scan.start", { type: "custom", targetPath: scanDir });
      assert.equal(first.success, true);

      const snapshot = await client.request("scan.getActive", undefined);
      assert.ok(snapshot, "getActive must expose the running scan");
      assert.equal(snapshot.id, first.id);

      await assert.rejects(
        client.request("scan.start", { type: "custom", targetPath: scanDir }),
        /Já existe uma análise em curso/,
        "a second concurrent scan must be refused with a protocol error"
      );

      const cancel = await client.request("scan.cancel", { id: first.id });
      assert.equal(cancel.success, true);

      await waitFor(() => client.events.some((event) => event.status === "cancelled"));
      const cancelled = client.events.filter((event) => event.status === "cancelled");
      assert.ok(cancelled.length >= 1, "cancel must reach the client as a terminal event");
      assert.equal(cancelled.at(-1).id, first.id);

      await waitFor(async () => (await client.request("scan.getActive", undefined)) === null);
    } finally {
      client.close();
      await harness.close();
    }
  });

  it("second scan.start during an active scan rejects at protocol level (envelope ok=false)", async () => {
    const scanDir = await makeTempDir("scan-red");
    await fs.mkdir(path.join(scanDir, "files"), { recursive: true });
    for (let i = 0; i < 10; i++) {
      await fs.writeFile(path.join(scanDir, "files", `f${i}.txt`), "x");
    }

    const harness = await createHarness({ delayMs: 50 });
    const client = await connectClient(harness.pipeName);

    try {
      const first = await client.request("scan.start", { type: "custom", targetPath: scanDir });
      assert.equal(first.success, true);

      await assert.rejects(
        client.request("scan.start", { type: "custom", targetPath: scanDir }),
        /Já existe uma análise em curso/,
        "protocol envelope must be ok=false for a refused scan.start"
      );

      const cancel = await client.request("scan.cancel", { id: first.id });
      assert.equal(cancel.success, true);
    } finally {
      client.close();
      await harness.close();
    }
  });

  it("terminates explicitly when no files are found (zero-file scan)", async () => {
    const emptyDir = await makeTempDir("scan-empty");
    const harness = await createHarness();
    const client = await connectClient(harness.pipeName);

    try {
      const start = await client.request("scan.start", { type: "custom", targetPath: emptyDir });
      assert.equal(start.success, true);

      await waitFor(() => client.events.some((event) => event.status === "completed"));
      const terminal = client.events.filter((event) => event.status === "completed").at(-1);
      assert.equal(terminal.progress, 100);
      assert.equal(terminal.filesScanned, 0);
    } finally {
      client.close();
      await harness.close();
    }
  });

  it("single-file scan: reports the real target kind and the file name before finishing", async () => {
    const scanDir = await makeTempDir("scan-onefile");
    const filePath = path.join(scanDir, "documento.pdf");
    await fs.writeFile(filePath, "conteudo de teste");

    // delayMs keeps the analysis open so we can observe the pre-analysis state.
    const harness = await createHarness({ delayMs: 60 });
    const client = await connectClient(harness.pipeName);

    try {
      const start = await client.request("scan.start", { type: "custom", targetPath: filePath });
      assert.equal(start.success, true);

      await waitFor(() => client.events.some((event) => event.status === "completed"));
      const scanEvents = client.events.filter((event) => event.id === start.id);

      // O nome e o tipo do alvo são conhecidos ANTES de a análise terminar: é
      // isto que permite a UI mostrar "Ficheiro: documento.pdf" em vez de 0%.
      const identified = scanEvents.find((event) => event.targetKind === "file");
      assert.ok(identified, "the service must report targetKind=file");
      assert.equal(identified.currentFile, "documento.pdf");
      assert.equal(identified.filesScanned, 0, "the name is known before the analysis finishes");
      assert.ok(identified.status === "running");

      assert.ok(
        scanEvents.some((event) => event.phase === "gathering"),
        "a single-file scan still reports its gathering phase",
      );

      const terminal = scanEvents.at(-1);
      assert.equal(terminal.status, "completed");
      assert.equal(terminal.progress, 100);
      assert.equal(terminal.filesScanned, 1);
      assert.equal(terminal.filesDiscovered, 1);
      assert.equal(terminal.targetKind, "file");
      assert.equal(terminal.filesFailed, 0);
    } finally {
      client.close();
      await harness.close();
    }
  });

  it("folder scan: reports targetKind=directory and analyzes every file inside", async () => {
    const scanDir = await makeTempDir("scan-folder");
    await fs.mkdir(path.join(scanDir, "sub"), { recursive: true });
    await fs.writeFile(path.join(scanDir, "a.txt"), "a");
    await fs.writeFile(path.join(scanDir, "b.txt"), "b");
    await fs.writeFile(path.join(scanDir, "sub", "c.txt"), "c");

    const harness = await createHarness();
    const client = await connectClient(harness.pipeName);

    try {
      const start = await client.request("scan.start", { type: "custom", targetPath: scanDir });
      assert.equal(start.success, true);

      await waitFor(() => client.events.some((event) => event.status === "completed"));
      const scanEvents = client.events.filter((event) => event.id === start.id);
      const identified = scanEvents.find((event) => event.targetKind);
      assert.equal(identified?.targetKind, "directory");

      const terminal = scanEvents.at(-1);
      assert.equal(terminal.status, "completed");
      assert.equal(terminal.filesScanned, 3);
      assert.equal(terminal.progress, 100);
    } finally {
      client.close();
      await harness.close();
    }
  });

  it("maps a failing scan to a terminal failed event with a message", async () => {
    const scanDir = await makeTempDir("scan-fail");
    await fs.writeFile(path.join(scanDir, "a.txt"), "a");

    const harness = await createHarness();
    // Force the gathering step to blow up.
    harness.manager.resolvePathsForScan = async () => {
      throw new Error("enumeration exploded");
    };
    const client = await connectClient(harness.pipeName);

    try {
      const start = await client.request("scan.start", { type: "custom", targetPath: scanDir });
      assert.equal(start.success, true);

      await waitFor(() => client.events.some((event) => event.status === "failed"));
      const failed = client.events.filter((event) => event.status === "failed").at(-1);
      assert.equal(failed.id, start.id);
      assert.ok(failed.error && failed.error.includes("enumeration"), "failure must carry the underlying message");
      assert.ok(failed.endTime, "a failed scan still terminates with endTime");
    } finally {
      client.close();
      await harness.close();
    }
  });
});
