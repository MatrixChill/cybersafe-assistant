/**
 * TP-3H-CACHED-NOTICE-FIX — o aviso de snapshot CACHED tem de ser comum.
 *
 * Causa (root, provada): o último snapshot DOM (`conn=false origin=CACHED
 * generation=2`) mostrava o aviso de "última leitura guardada" **apenas** na
 * SimpleView; na AdvancedView o aviso era morto, apesar de o snapshot estar
 * igualmente em cache.
 *
 * Fix: o aviso passa a viver na **raiz comum** do PC Center (fora do
 * condicional Simple/Advanced) e a SimpleView perde o duplicado.
 *
 * Este teste não entra em modo Advanced por efeitos: valida (a) o componente
 * puro do aviso, (b) a **composição** na fonte (raiz comum + sem duplicado na
 * SimpleView) e (c) o SSR da página com origem CACHED.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppearanceProvider } from "../src/contexts/AppearanceContext";
import PCCenterPage, { CachedSnapshotNotice } from "../src/pages/PCCenterPage";
import type { HardwareSnapshot } from "@cybersafe/shared-types";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const source = readFileSync(new URL("../src/pages/PCCenterPage.tsx", import.meta.url), "utf8");

test("o aviso puro diz a verdade: CACHED mostra a idade, LIVE não mostra nada", () => {
  const cached = renderToStaticMarkup(
    createElement(CachedSnapshotNotice as never, { origin: "CACHED", ageText: "há 90 s" } as never),
  );
  assert.match(cached, /Última leitura guardada/, "o aviso identifica a leitura guardada");
  assert.match(cached, /há 90 s/, "a idade entra no aviso");
  assert.match(cached, /não são atuais/, "o aviso diz que os valores não são atuais");
  const live = renderToStaticMarkup(
    createElement(CachedSnapshotNotice as never, { origin: "LIVE", ageText: "há 1 s" } as never),
  );
  assert.equal(live, "", "com leitura atual não há aviso de cache");
});

test("o aviso está na raiz comum (fora do condicional Simple/Advanced) e não duplicado na SimpleView", () => {
  const mainExport = source.slice(source.indexOf("export default function PCCenterPage"));
  const viewSwitch = mainExport.search(/\{viewMode === "simple" \? \(/);
  assert.ok(viewSwitch > 0, "a raiz comum tem o condicional de vista");
  const noticeInRoot = mainExport.lastIndexOf("<CachedSnapshotNotice");
  assert.ok(noticeInRoot > 0, "a raiz comum tem o aviso");
  assert.ok(
    noticeInRoot < viewSwitch,
    "o aviso tem de estar ANTES do condicional de vista (raiz comum), não dentro de uma view",
  );
  const simpleView = source.slice(source.indexOf("function SimpleView"), source.indexOf("export function AdvancedView"));
  assert.equal(
    simpleView.includes("<CachedSnapshotNotice"),
    false,
    "a SimpleView não pode ter o aviso duplicado (fica só na raiz comum)",
  );
});

test("SSR: com origem CACHED a página mostra o aviso", () => {
  const at = new Date(Date.now() - 90_000).toISOString();
  const hardware = {
    timestamp: at,
    cpu: { usage: 7, usageStatus: "available", usageUpdatedAt: at, model: "", temperature: null, temperatureStatus: "unavailable" },
    ram: { usagePercent: 51, usedGb: 15.8, totalGb: 30.9, usageStatus: "available" },
    disk: { readStatus: "ok", reason: null, lastGoodAt: at, volumes: [], primary: { mount: "C:", fileSystem: "NTFS", usagePercent: 62, usedGb: 300, freeGb: 200, totalGb: 500 }, usagePercent: 62, usedGb: 300, totalGb: 500, fsType: "NTFS" },
    network: { rxSec: 0, txSec: 0 },
    gpu: null,
    battery: { status: "absent", percent: null, isCharging: false, timeRemaining: null },
    stressScore: 0,
    stressContributions: { cpu: 0, ram: 0, temperature: 0, gpu: 0 },
    alerts: [],
    topProcessesByRam: [],
  } as unknown as HardwareSnapshot;
  const html = renderToStaticMarkup(
    createElement(
      AppearanceProvider,
      null,
      createElement(PCCenterPage as never, { hardware, pcState: null, dataOrigin: "CACHED" } as never),
    ),
  );
  assert.match(html, /Última leitura guardada/, "o aviso de cache aparece na página");
  assert.doesNotMatch(html, /data-cs-/, "sem Vite env não há trace DEV-only");
});
