import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ThreatsPage, {
  canQuarantineManually,
  buildQuarantineConfirmation,
  requestManualQuarantine,
} from "../src/pages/ThreatsPage";
import type { ThreatEvent } from "@cybersafe/shared-types";

/**
 * RECOVERY-SECURITY-20261014 (P0 manual, qoder): a ponte
 * `threatAction(filePath,'quarantine')` ja existe em preload/main; a UI ainda
 * nao a usava. Regras em teste, com promises controladas e SSR — NENHUMA acao
 * real de quarentena acontece aqui:
 *  - botao so com filePath + sha256 valido + ainda nao quarantined;
 *  - confirmacao mostra nome, digest e caminho ANTES do unico submit;
 *  - in-flight guard: duas chamadas paralelas nao disparam dois submits;
 *  - `success === true` e o unico sucesso; false/erro mantém alerta e a copy
 *    "isolamento não confirmado";
 *  - sucesso recarrega via onQuarantineChanged; nada de acao automatica.
 */

(globalThis as Record<string, unknown>).React = React;

const digest = "a".repeat(64);

const threat = (overrides: Partial<ThreatEvent> = {}): ThreatEvent => ({
  source: "system-scanner",
  url: "file://C:/temp/x.exe",
  domain: "localhost",
  severity: "high",
  confidence: 0.9,
  rulesTriggered: ["executable_signature"],
  createdAt: "2026-10-14T10:00:00.000Z",
  riskScore: 80,
  filePath: "C:\\temp\\x.exe",
  sha256: digest,
  ...overrides,
});

describe("threat manual quarantine — elegibilidade", () => {
  test("filePath + digest valido + nao quarantined = elegivel", () => {
    assert.equal(canQuarantineManually(threat()), true);
  });

  test("sem filePath (deteccao web) nao e elegivel", () => {
    assert.equal(canQuarantineManually(threat({ filePath: undefined })), false);
  });

  test("digest ausente ou ilegítimo nao e elegivel (legado pede reanalise, no backend)", () => {
    assert.equal(canQuarantineManually(threat({ sha256: undefined })), false);
    assert.equal(canQuarantineManually(threat({ sha256: "zz".repeat(32) })), false);
    assert.equal(canQuarantineManually(threat({ sha256: "a".repeat(63) })), false);
  });

  test("ja quarantined nao oferece o botao outra vez", () => {
    assert.equal(canQuarantineManually(threat({ action: "quarantined" })), false);
  });
});

describe("threat manual quarantine — confirmacao", () => {
  test("a confirmacao contem nome, digest e caminho reais", () => {
    const c = buildQuarantineConfirmation(threat({ filePath: "C:\\temp\\nota maliciosa.dll" }));
    assert.equal(c.fileName, "nota maliciosa.dll");
    assert.equal(c.sha256, digest);
    assert.equal(c.filePath, "C:\\temp\\nota maliciosa.dll");
  });

  test("renderSSR: botao aparece so nos elegiveis; sem confirmacao aberta nada de modal", () => {
    const html = renderToStaticMarkup(
      createElement(ThreatsPage, {
        events: [threat(), threat({ url: "https://site.mal/", domain: "site.mal", filePath: undefined, sha256: undefined })],
        onClear: () => {},
        isClearing: false,
      }),
    );
    const buttons = html.match(/Colocar em quarentena…/g) ?? [];
    assert.equal(buttons.length, 1, "nem todo registo tem alvo isolavel");
    assert.doesNotMatch(html, /Confirmar quarentena/, "confirmacao so depois do clique");
  });

  test("threat ja quarantined mostra estado, nao botao", () => {
    const html = renderToStaticMarkup(
      createElement(ThreatsPage, { events: [threat({ action: "quarantined" })], onClear: () => {}, isClearing: false }),
    );
    assert.doesNotMatch(html, /Colocar em quarentena…/);
    assert.match(html, /Em quarentena/);
  });
});

describe("threat manual quarantine — submit unico com promises controladas", () => {
  test("success=true: um submit, recarrega, sem alerta", async () => {
    const calls: Array<[string, string]> = [];
    let resolve!: (v: { success: boolean }) => void;
    const reloads: number[] = [];
    const dispatched = requestManualQuarantine({
      threat: threat(),
      call: (id, action, expectedSha256) => {
        calls.push([id, action, expectedSha256]);
        return new Promise((r) => { resolve = r; });
      },
      onReload: () => { reloads.push(1); },
    });
    assert.equal(dispatched, true, "submit deve partir de imediato, sem esperar re-render");
    assert.deepEqual(calls, [["C:\\temp\\x.exe", "quarantine", digest]], "o digest da detecao clicada segue no pedido");
    resolve({ success: true });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(reloads, [1], "so o sucesso recarrega");
  });

  test("success=false com error do backend: alerta com a razao, sem reload, copy de nao confirmado", async () => {
    const seen: unknown[] = [];
    let reloads = 0;
    requestManualQuarantine({
      threat: threat(),
      call: () => Promise.resolve({ success: false, error: "Volte a analisar o ficheiro: esta deteção não contém uma identidade verificável." }),
      onAlert: (m) => seen.push(m),
      onReload: () => { reloads += 1; },
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(seen.length, 1);
    assert.match(String(seen[0]), /Volte a analisar/);
    assert.match(String(seen[0]), /isolamento não confirmado/);
    assert.equal(reloads, 0);
  });

  test("success=false sem error: alerta genericos honestos, reload nao", async () => {
    const seen: unknown[] = [];
    requestManualQuarantine({
      threat: threat(),
      call: () => Promise.resolve({ success: false }),
      onAlert: (m) => seen.push(m),
      onReload: () => { throw new Error("recarregar sem sucesso e mentira"); },
    });
    await new Promise((r) => setImmediate(r));
    assert.match(String(seen[0]), /isolamento não confirmado/);
  });

  test("in-flight guard: segundo pedido simultaneo e ignorado (um unico submit)", async () => {
    const calls: number[] = [];
    let releaseFirst!: (v: { success: boolean }) => void;
    const api = {
      quarantine: () => new Promise<{ success: boolean }>((r) => { releaseFirst = r; }),
    };
    const result = requestManualQuarantine({ threat: threat(), call: () => { calls.push(1); return api.quarantine(); } });
    assert.equal(result, true, "first submit dispatched");
    const again = requestManualQuarantine({ threat: threat(), call: () => { calls.push(1); return Promise.resolve({ success: true }); } });
    assert.equal(again, false, "segundo submit enquanto o primeiro esta em voo nao pode existir");
    assert.equal(calls.length, 1);
    releaseFirst({ success: true });
    await new Promise((r) => setImmediate(r));
  });

  test("throw da ponte: alerta de falha de comunicacao, nunca sucesso", async () => {
    const alerts: unknown[] = [];
    requestManualQuarantine({
      threat: threat(),
      call: () => Promise.reject(new Error("pipe fechado")),
      onAlert: (m) => alerts.push(m),
      onReload: () => { throw new Error("reload indevido"); },
    });
    await new Promise((r) => setImmediate(r));
    assert.match(String(alerts[0]), /pipe fechado|falha/i);
  });

  test("helper valida elegibilidade antes de tocar na ponte", async () => {
    let calls = 0;
    const dispatched = requestManualQuarantine({
      threat: threat({ sha256: undefined }),
      call: () => { calls += 1; return Promise.resolve({ success: true }); },
    });
    assert.equal(dispatched, false, "sem digest nao ha submit, nem de bootstrap");
    assert.equal(calls, 0);
    // e a guarda nao ficou presa: um pedido elegivel segue normalmente
    const second = requestManualQuarantine({
      threat: threat(),
      call: () => { calls += 1; return Promise.resolve({ success: true }); },
    });
    assert.equal(second, true);
    assert.equal(calls, 1);
    await new Promise((r) => setImmediate(r));
  });

  test("identidade congelada: clicar a detecao antiga envia o digest DELA, nao o do caminho", async () => {
    const antiga = threat({ sha256: "b".repeat(64) }); // mesmo filePath, digest original
    const seen: Array<string> = [];
    requestManualQuarantine({
      threat: antiga,
      call: (_id, _action, expectedSha256) => { seen.push(expectedSha256); return Promise.resolve({ success: false, error: "digest não corresponde" }); },
      onAlert: () => {},
    });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seen, ["b".repeat(64)], "path reutilizado nao pode herdar o digest de outra detecao");
    assert.ok(!seen.includes(digest));
  });
});

describe("threat manual quarantine — deadline do bridge (nunca resolver)", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("prazo exposto: alerta honesto 'ainda não confirmada', sem reload, sem inferir falha", async () => {
    const alerts: unknown[] = [];
    let reloads = 0;
    const dispatched = requestManualQuarantine({
      threat: threat(),
      call: () => new Promise(() => {}), // ponte que nunca responde
      onAlert: (m) => alerts.push(m),
      onReload: () => { reloads += 1; },
      timeoutMs: 10,
    });
    assert.equal(dispatched, true);
    await sleep(40);
    assert.equal(alerts.length, 1);
    assert.match(String(alerts[0]), /Operação ainda não confirmada; consulte a quarentena e o histórico antes de repetir/);
    assert.doesNotMatch(String(alerts[0]), /falhou|isolado com sucesso|êxito/i, "timeout nao e sucesso nem falha fisica");
    assert.equal(reloads, 0);
  });

  test("sucesso tardio depois do prazo: nem reload, nem segundo alerta", async () => {
    const alerts: unknown[] = [];
    let reloads = 0;
    let resolveLate!: (v: { success: boolean }) => void;
    requestManualQuarantine({
      threat: threat(),
      call: () => new Promise((r) => { resolveLate = r; }),
      onAlert: (m) => alerts.push(m),
      onReload: () => { reloads += 1; },
      timeoutMs: 10,
    });
    await sleep(40);
    assert.equal(alerts.length, 1, "prazo ja falou uma vez");
    resolveLate({ success: true });
    await sleep(20);
    assert.equal(reloads, 0, "late success nao pode fingir que esperou o prazo");
    assert.equal(alerts.length, 1);
  });

  test("guard recupera depois do prazo: terceiro submit pode partir", async () => {
    let reloads = 0;
    requestManualQuarantine({
      threat: threat(),
      call: () => new Promise(() => {}),
      onReload: () => { reloads += 1; },
      timeoutMs: 10,
    });
    await sleep(40);
    const recovered = requestManualQuarantine({
      threat: threat({ filePath: "C:\\temp\\y.exe" }),
      call: () => Promise.resolve({ success: true }),
      onReload: () => { reloads += 1; },
      timeoutMs: 10,
    });
    assert.equal(recovered, true, "o prazo libertou a guarda de voo");
    await sleep(20);
    assert.equal(reloads, 1);
  });
});

describe("threat manual quarantine — confirmacao visivel de sucesso (UI)", () => {
  test("fonte: sucesso define 'Quarentena confirmada pelo serviço.' sem apagar alerta", async () => {
    const { readFileSync } = await import("node:fs");
    const fonte = readFileSync(new URL("../src/pages/ThreatsPage.tsx", import.meta.url), "utf8");
    assert.match(fonte, /Quarentena confirmada pelo serviço\./);
    const onReloadBlock = fonte.slice(fonte.indexOf("onReload: () => {"), fonte.indexOf("onSettled: () => setQuarantineBusy(false)"))
    assert.ok(onReloadBlock.length > 0 && onReloadBlock.length < 600, "bloco onReload encontrado")
    assert.match(onReloadBlock, /setQuarantineNotice\("Quarentena confirmada pelo serviço\."\)/);
    assert.doesNotMatch(onReloadBlock, /setQuarantineAlert\(null\)/, "o sucesso nao esconde o alerta na propria callback");
  });
});
