import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mapUpdaterSnapshot } from "../src/components/updates/updaterWindowModel";
import { UpdaterWindow } from "../src/components/updates/UpdaterWindow";
import type { AppUpdateSnapshot } from "@cybersafe/shared-types";
import {buildAmbitoAtualizacoes} from '../src/components/updates/updateScope';

test('assisted Preview never claims a Windows authenticated publisher',()=>{
  const snapshot={...base,channel:'preview' as const,status:'downloaded' as const,canInstall:true};
  const scope=buildAmbitoAtualizacoes({bridgeAvailable:true,snapshot});
  assert.match(scope.verificacao,/sem Authenticode/);
  assert.match(mapUpdaterSnapshot(snapshot).detail??'',/sem Authenticode/);
});
const base: AppUpdateSnapshot = { status: "unconfigured", channel: "stable", installed: { version: "0.2.0-rc.1" }, canInstall: false, automaticCheckEnabled: false };
test("unconfigured snapshot never offers downloading or installation", () => {
  const v = mapUpdaterSnapshot(base); assert.equal(v.phase, "unavailable"); assert.equal(v.primaryAction, undefined);
});
test("downloading without total never fabricates percentage", () => {
  const v = mapUpdaterSnapshot({ ...base, status: "downloading", progress: { downloadedBytes: 1024 } });
  assert.equal(v.percent, null); assert.equal(v.cancelable, true);
});
test("integrity verification cannot be cancelled after the download signal is closed", () => {
  const v = mapUpdaterSnapshot({ ...base, status: "verifying" });
  assert.equal(v.cancelable, false);
});
test("downloaded without permission cannot offer installation", () => {
  assert.equal(mapUpdaterSnapshot({ ...base, status: "downloaded" }).primaryAction, undefined);
  assert.equal(mapUpdaterSnapshot({ ...base, status: "downloaded", canInstall: true }).primaryAction, "install");
});
test("installing is not completed and cannot be cancelled", () => {
  const v = mapUpdaterSnapshot({ ...base, status: "installing" }); assert.equal(v.phase, "installing"); assert.equal(v.cancelable, false); assert.equal(v.percent, null);
});
test("window exposes indeterminate progress and labels all demonstrations", () => {
  const html = renderToStaticMarkup(createElement(UpdaterWindow, { view: { phase: "verifying", currentVersion: "0.2.0", percent: null, cancelable: false }, demo: true }));
  assert.match(html, /role="progressbar"/); assert.doesNotMatch(html, /aria-valuenow/); assert.match(html, /Demonstração/); assert.match(html, /Nenhuma atualização real/);
});
test("release notes are rendered as text", () => {
  const html = renderToStaticMarkup(createElement(UpdaterWindow, { view: { phase: "available", currentVersion: "0.2.0", percent: null, cancelable: false, notes: "<script>alert(1)</script>" } }));
  assert.doesNotMatch(html, /<script>/); assert.match(html, /&lt;script&gt;/);
});

test("nine requested phases render with honest demo labels", () => {
  for (const phase of ["checking", "available", "downloading", "verifying", "preparing", "installing", "completed", "error", "current"] as const) {
    const html = renderToStaticMarkup(createElement(UpdaterWindow, { view: { phase, currentVersion: "0.2.0", percent: 64, cancelable: false }, demo: true }));
    assert.match(html, new RegExp(`data-phase="${phase}"`)); assert.match(html, /Nenhuma atualização real/);
    if (phase !== "downloading") assert.doesNotMatch(html, /aria-valuenow=/);
  }
});
test("download percentage is bounded and unavailable actions remain disabled", () => {
  const html = renderToStaticMarkup(createElement(UpdaterWindow, { view: { phase: "downloading", currentVersion: "0.2.0", percent: 120, cancelable: true, primaryAction: "download" } }));
  assert.match(html, /aria-valuenow="100"/); assert.match(html, /disabled="">Cancelar/); assert.match(html, /disabled=""><svg/);
});
