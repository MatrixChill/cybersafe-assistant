/**
 * R8 — ADAPTER REAL DO SCAN USB (fatia minima autorizada pelo Codex, 13/10).
 *
 * O que se prova aqui, com o ScanManager REAL e o caminho REAL do motor:
 *  - o adapter FORCA `readOnly: true` (o chamador nunca escolhe o modo);
 *  - sem contrato de read-only declarado (ou com versao diferente) NENHUMA
 *    analise arranca: auto-scan bloqueado com motivo;
 *  - numa deteccao critica REAL: zero quarentena, zero VirusTotal, zero
 *    escrita no alvo (snapshot byte a byte) e a deteccao continua publicada;
 *  - contencao: nada fora da raiz resolvida e' analisado (junction);
 *  - remocao durante a analise: o scan GLOBAL fica `cancelled` (estado e
 *    historico persistido), nunca `completed`.
 *
 * Nada disto corre no arranque do servico: e' prova de TESTE, com spies.
 *
 * Uso: node --test packages/service/test/r8-usb-adapter.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { MalwareAnalyzer, SignatureDatabase, TrustEngine, YaraEngine } from "@cybersafe/core";
import { ScanManager } from "../dist/scan-manager.js";
import { ScanHistory } from "../dist/scan-history.js";
import { ProtectionEngineService } from "../dist/engine.js";
import { NativeEngineBridge } from "../dist/native-engine-bridge.js";
import { UsbReadOnlyScanAdapter, USB_READONLY_CONTRATO } from "../dist/usb-scan-adapter.js";

const MARCADOR = "MZ CS-ADAPTER-USB-PROBE-77";

/** Snapshot do "dispositivo": caminho relativo + tamanho + mtime + sha256. */
async function snapshot(dir, base = dir) {
  const itens = [];
  for (const entrada of await fs.readdir(dir, { withFileTypes: true })) {
    const alvo = path.join(dir, entrada.name);
    // Junctions/reparse points e tudo o que nao seja ficheiro regular nao
    // entra no snapshot (o walk tambem nao os segue).
    if (entrada.isSymbolicLink()) continue;
    if (entrada.isDirectory()) {
      itens.push(...(await snapshot(alvo, base)));
      continue;
    }
    const conteudo = await fs.readFile(alvo);
    const info = await fs.stat(alvo);
    itens.push({
      rel: path.relative(base, alvo).replace(/\\/g, "/"),
      tamanho: info.size,
      mtimeMs: info.mtimeMs,
      sha256: createHash("sha256").update(conteudo).digest("hex"),
    });
  }
  return itens.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * O histórico é escrito de forma assíncrona e nunca bloqueia o scan (por
 * desenho), por isso espera-se pela linha: ler logo a seguir seria uma corrida
 * do teste, não um defeito do produto.
 */
async function lerHistoricoDoScan(arquivo, scanId, timeoutMs = 5_000) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const bruto = await fs.readFile(arquivo, "utf8").catch(() => "");
    const linhas = bruto
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((linha) => {
        try {
          return JSON.parse(linha);
        } catch {
          return null;
        }
      })
      .filter((entrada) => entrada && entrada.id === scanId);
    if (linhas.length > 0) return linhas;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return [];
}

async function esperarTerminal(manager, id, timeoutMs = 30_000) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const estado = manager.getScan(id);
    if (estado && ["completed", "failed", "cancelled"].includes(estado.status)) return estado;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("scan não chegou a estado terminal dentro do tempo");
}

/**
 * Motor REAL (mesmo `scanArtifact` de producao) com colaboradores espiados:
 * a quarentena falsa APAGA o ficheiro, como a real — assim uma quarentena que
 * nao devia ter acontecido fica visivel no snapshot e no contador.
 */
async function motorRealComSpies(t, { dir, atrasoMs = 0 } = {}) {
  const yara = new YaraEngine(path.join(dir, "fallback.yar"));
  const fortes = path.join(dir, `forte-${Date.now()}-${Math.random().toString(16).slice(2)}.yar`);
  await fs.writeFile(fortes, `rule usb_adapter { meta: cybersafe_evidence = "strong" strings: $a = "${MARCADOR}" condition: $a }`);
  await yara.load(fortes);

  const analyzer = new MalwareAnalyzer({ yara, trust: new TrustEngine(), signatures: new SignatureDatabase() });
  const eventos = [];
  const chamadas = { quarentenas: 0, vt: 0, analisados: [] };

  const originalScan = NativeEngineBridge.scan;
  NativeEngineBridge.scan = async () => ({ ok: false, result: null });
  t.after(() => {
    NativeEngineBridge.scan = originalScan;
  });

  const engine = Object.assign(Object.create(ProtectionEngineService.prototype), {
    analyzer,
    exclusions: { exclusionReason: () => null },
    vt: {
      isEnabled: () => true,
      scanHash: async () => {
        chamadas.vt += 1;
        return { positives: 3, detectionRatio: "3/70" };
      },
    },
    eventBus: { publish: (type, severity, message, data) => eventos.push({ type, severity, data }) },
    quarantine: {
      quarantine: async () => {
        chamadas.quarentenas += 1;
        return { id: "falsa" };
      },
    },
    threats: [],
    blockedHashes: new Set(),
    blockedPaths: new Set(),
    // Campos que os class-field initializers criariam (o motor aqui nasce do
    // prototype, para usar o `scanArtifact` REAL sem subir o servico inteiro).
    scanAbortControllers: new Map(),
    scanAbortIntents: new Set(),
    backgroundAbort: new AbortController(),
    // `shouldLogTransientScanError` usa este Map (class field do motor real):
    // sem ele, o caminho de erro transitório rebentava com um TypeError tardio.
    transientScanLogAt: new Map(),
    clamavPrefetches: new Map(),
    clamavPrefetchGeneration: 0,
    logHistory: async () => {},
    actionsLog: { write: async () => {} },
    // Contrato que o ScanManager exige do motor:
    isExcluded: () => false,
    emitScanProgress: () => {},
    prefetchClamav: async () => ({ spawned: false }),
    clearClamavPrefetch: () => {},
  });

  if (atrasoMs > 0) {
    const original = engine.scanArtifact.bind(engine);
    engine.scanArtifact = async (ficheiro, source, options) => {
      chamadas.analisados.push(ficheiro);
      await new Promise((resolve) => setTimeout(resolve, atrasoMs));
      return original(ficheiro, source, options);
    };
  } else {
    const original = engine.scanArtifact.bind(engine);
    engine.scanArtifact = async (ficheiro, source, options) => {
      chamadas.analisados.push(ficheiro);
      return original(ficheiro, source, options);
    };
  }

  return { engine, eventos, chamadas };
}

/** Adapter ligado a um ScanManager real, com historico persistente em tmp. */
function adapterCom(manager, { capacidade = () => ({ ...USB_READONLY_CONTRATO }) } = {}) {
  return new UsbReadOnlyScanAdapter({
    scans: {
      startScan: (type, targetPath, options) => manager.startScan(type, targetPath, options),
      cancelScan: (id) => manager.cancelScan(id),
      getScan: (id) => manager.getScan(id),
    },
    capacidade,
  });
}

test("o adapter FORÇA readOnly:true na raiz confirmada (o chamador não escolhe o modo)", async () => {
  const chamadas = [];
  const fake = {
    startScan: async (type, targetPath, options) => {
      chamadas.push({ type, targetPath, options });
      return "scan-forcado";
    },
    cancelScan: () => {},
    getScan: () => undefined,
  };
  const adapter = adapterCom(fake);

  const { scanId } = await adapter.iniciar({ id: "pen", rootPath: "E:\\", rootPaths: ["E:\\"] });

  assert.equal(scanId, "scan-forcado");
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].type, "custom", "USB reutiliza custom, sem semantica nova");
  assert.equal(chamadas[0].targetPath, "E:\\", "a raiz é a que o serviço confirmou");
  assert.deepEqual(chamadas[0].options, { readOnly: true }, "readOnly tem de ser FORÇADO aqui");
});

test("sem contrato de read-only declarado: NENHUMA análise arranca (auto bloqueado)", async () => {
  for (const capacidade of [
    () => null,
    () => undefined,
    () => ({ nome: "outro-contrato", versao: 1 }),
    () => ({ nome: "usb-readonly", versao: 0 }),
    () => ({ nome: "usb-readonly", versao: "1" }),
    () => {
      throw new Error("motor sem capacidade");
    },
  ]) {
    const chamadas = [];
    const fake = {
      startScan: async (...args) => {
        chamadas.push(args);
        return "scan-nao-devido";
      },
      cancelScan: () => {},
      getScan: () => undefined,
    };
    const adapter = adapterCom(fake, { capacidade });

    assert.equal(adapter.verificar().ok, false, "capacidade ausente/incompatível não pode ser 'ok'");
    await assert.rejects(
      () => adapter.iniciar({ id: "pen", rootPath: "E:\\", rootPaths: ["E:\\"] }),
      /read-only/i,
    );
    assert.deepEqual(chamadas, [], "sem garantia estrutural não pode arrancar nada");
  }
});

test("raiz vazia é recusada antes de qualquer trabalho", async () => {
  const chamadas = [];
  const adapter = adapterCom({
    startScan: async (...args) => {
      chamadas.push(args);
      return "x";
    },
    cancelScan: () => {},
    getScan: () => undefined,
  });
  await assert.rejects(() => adapter.iniciar({ id: "pen", rootPath: "   ", rootPaths: [] }), /raiz confirmada/);
  assert.deepEqual(chamadas, []);
});

test("BITE: ScanManager real + motor real — deteção crítica, zero quarentena/VT/escrita", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cs-usb-adapter-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const raiz = path.join(base, "pen");
  const fora = path.join(base, "fora");
  await fs.mkdir(raiz, { recursive: true });
  await fs.mkdir(fora, { recursive: true });
  await fs.writeFile(path.join(raiz, "pen.exe"), MARCADOR);
  await fs.writeFile(path.join(raiz, "notas.txt"), "ficheiro benigno do dispositivo");
  await fs.writeFile(path.join(fora, "segredo-fora.txt"), "está fora da raiz");
  let junction = false;
  try {
    execFileSync("cmd", ["/c", "mklink", "/J", path.join(raiz, "atalho"), fora], { stdio: "ignore" });
    junction = true;
  } catch {
    junction = false;
  }

  const { engine, eventos, chamadas } = await motorRealComSpies(t, { dir: base });
  const historico = path.join(base, "scans.jsonl");
  const manager = new ScanManager(engine, new ScanHistory(historico));
  const adapter = adapterCom(manager);
  const antes = await snapshot(raiz);

  const { scanId } = await adapter.iniciar({ id: "pen-1", rootPath: raiz, rootPaths: [raiz] });
  const estado = await esperarTerminal(manager, scanId);

  // Análise global confirmada, com a deteção REAL publicada (não se esconde nada).
  assert.equal(estado.status, "completed", `scan devia completar (erro: ${estado.error})`);
  assert.ok(estado.threatsFound >= 1, "a deteção crítica tem de contar no resultado global");
  assert.ok(eventos.some((evento) => evento.type === "threat.detected"), "a deteção é publicada");

  // ... e nada de quarentena, de rede ou de escrita no dispositivo.
  assert.equal(chamadas.quarentenas, 0, "read-only nunca coloca em quarentena");
  assert.equal(
    eventos.some((evento) => evento.type === "quarantine.added"),
    false,
    "não se pode afirmar quarentena",
  );
  assert.equal(chamadas.vt, 0, "read-only não fala com o VirusTotal (nem com deteção crítica)");
  assert.deepEqual(await snapshot(raiz), antes, "o dispositivo fica byte a byte igual");
  assert.equal(await fs.readFile(path.join(raiz, "pen.exe"), "utf8"), MARCADOR, "o ficheiro continua no dispositivo");

  // Contenção: nada fora da raiz resolvida foi analisado.
  const raizReal = await fs.realpath(raiz);
  const foraReal = await fs.realpath(path.join(fora, "segredo-fora.txt"));
  for (const analisado of chamadas.analisados) {
    const alvoReal = await fs.realpath(analisado);
    const relativo = path.relative(raizReal, alvoReal);
    assert.ok(
      relativo === "" || (!relativo.startsWith("..") && !path.isAbsolute(relativo)),
      `ficheiro fora da raiz analisado: ${analisado}`,
    );
  }
  assert.equal(chamadas.analisados.includes(foraReal), false, "o segredo fora da raiz nunca é analisado");
  if (!junction) {
    t.diagnostic("junction não pôde ser criada neste ambiente: a garantia é a do walk (symlinks/reparse ignorados)");
  }
});

test("remoção durante a análise: o scan GLOBAL fica cancelled (estado E histórico), nunca completed", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cs-usb-adapter-cancel-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const raiz = path.join(base, "pen");
  await fs.mkdir(raiz, { recursive: true });
  for (let i = 0; i < 12; i += 1) {
    await fs.writeFile(path.join(raiz, `ficheiro-${String(i).padStart(2, "0")}.txt`), `conteudo ${i}`);
  }

  const { engine } = await motorRealComSpies(t, { dir: base, atrasoMs: 40 });
  const historico = path.join(base, "scans.jsonl");
  const manager = new ScanManager(engine, new ScanHistory(historico));
  const adapter = adapterCom(manager);

  const { scanId } = await adapter.iniciar({ id: "pen-2", rootPath: raiz, rootPaths: [raiz] });
  // A promessa do loop é capturada ANTES do cancelamento: o estado terminal de
  // um cancel é imediato, por isso `esperarTerminal` não espera pela drenagem
  // do loop (logs de erros transitórios, cleanup, release). Sem este await, o
  // teardown do teste (apagar TEMP + repor o NativeEngineBridge) acontecia a
  // meio do loop — e o motor escrevia sobre um ambiente já desmontado.
  const loop = manager.currentScanPromise;
  assert.ok(loop, "o loop do scan tem de estar em curso depois do start");

  await new Promise((resolve) => setTimeout(resolve, 60));
  await adapter.cancelar(scanId); // o que o monitor faz quando o dispositivo sai

  const estado = await esperarTerminal(manager, scanId);
  await loop;
  assert.equal(manager.currentScanPromise, null, "o loop drenou antes do teardown");
  assert.equal(estado.status, "cancelled", "a remoção cancela a análise; nunca 'completed'");
  assert.notEqual(estado.status, "completed");

  const doScan = await lerHistoricoDoScan(historico, scanId);
  assert.ok(doScan.length > 0, "a análise tem de aparecer no histórico persistido");
  assert.equal(
    doScan.some((linha) => linha.status === "completed"),
    false,
    "o histórico nunca pode guardar este scan como completed",
  );
  assert.equal(
    doScan.at(-1).status,
    "cancelled",
    `o estado terminal no histórico tem de ser cancelled (veio ${doScan.at(-1).status})`,
  );
});
