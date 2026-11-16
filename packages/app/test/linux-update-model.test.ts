import { test } from "node:test";
import assert from "node:assert/strict";
import { linuxUpdateView } from "../src/lib/linuxUpdateModel";

const available = { schema: 1, state: "available", installed: "0.2.4-2", channel: "experimental", checkedAt: "2026-11-14T17:00:00Z",
  available: { version: "0.2.5-1", size: 112044826, notes: "Correções", signature: "ed25519-verified", sha256: "a".repeat(64) } };

test("sem verificação não se afirma «atualizado»", () => {
  const v = linuxUpdateView(null);
  assert.equal(v.title, "Ainda não verificado");
  assert.equal(v.canInstall, false);
});

test("versão disponível mostra versão, tamanho, notas e assinatura; só permite descarregar", () => {
  const v = linuxUpdateView({ ok: true, result: available });
  assert.match(v.title, /0\.2\.5-1/);
  assert.equal(v.sizeText, "106,9 MB");
  assert.equal(v.signatureText, "Manifesto com assinatura Ed25519 verificada");
  assert.equal(v.canDownload, true);
  assert.equal(v.canInstall, false);
  assert.equal(v.channel, "Experimental");
});

test("só um download verificado permite instalar", () => {
  assert.equal(linuxUpdateView({ ok: true, result: { ...available, download: { state: "verified" } } }).canInstall, true);
  const bad = linuxUpdateView({ ok: false, result: { ...available, download: { state: "invalid", reason: "sha256" } } });
  assert.equal(bad.canInstall, false);
  assert.match(bad.detail ?? "", /apagado/);
});

test("canal não configurado, assinatura inválida e erros de transporte são ditos claramente", () => {
  assert.equal(linuxUpdateView({ ok: true, result: { schema: 1, state: "not-configured" } }).tone, "warn");
  assert.match(linuxUpdateView({ ok: false, result: { schema: 1, state: "invalid", reason: "signature" } }).detail ?? "", /assinatura/);
  assert.match(linuxUpdateView({ ok: false, result: null, error: "not-installed" }).detail ?? "", /não está instalado/);
  assert.equal(linuxUpdateView({ ok: true, result: { schema: 1, state: "up-to-date", installed: "0.2.4-2" } }).title, "O CyberSafe está atualizado");
});

test("instalação: sucesso indica a versão nova; recusa não finge sucesso", () => {
  const ok = linuxUpdateView({ ok: true, result: { ...available, download: { state: "verified" }, install: { ok: true, installedAfter: "0.2.5-1" } } });
  assert.equal(ok.title, "Atualização instalada");
  assert.match(ok.detail ?? "", /0\.2\.5-1/);
  const no = linuxUpdateView({ ok: false, result: { ...available, download: { state: "verified" }, install: { ok: false, exitCode: 126 } } });
  assert.equal(no.title, "Instalação não concluída");
});

test("pedido no terminal e mudança do pacote não são apresentados como instalação", () => {
  const launch = linuxUpdateView({ok:true,result:{...available,install:{state:"terminal-requested",ok:false}}});
  assert.equal(launch.title,"Instalação solicitada");
  assert.match(launch.detail ?? "",/ainda não foi confirmada/);
  const changed = linuxUpdateView({ok:false,result:{...available,install:{error:"offered-package-changed"}}});
  assert.equal(changed.title,"O pacote disponível mudou");
  assert.equal(changed.canInstall,false);
});
