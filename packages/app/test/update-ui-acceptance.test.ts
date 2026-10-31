import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppUpdateSnapshot } from "@cybersafe/shared-types";
import type { UpdatesActions, UpdatesViewState } from "../src/components/updates/appUpdateController";
import { UpdatesPanel } from "../src/components/updates/UpdatesPanel";
import { InstallConfirmDialog } from "../src/components/updates/InstallConfirmDialog";
import { deriveControls, errorCodeMessage, progressInfo } from "../src/components/updates/appUpdateModel";

/**
 * TP-UPDATE-UI (17/10) — aceitação da secção "Atualizações".
 *
 * (1) CHECKS DE CONTRATO — invariantes do contrato REAL
 *     (`shared-types/src/app-update.ts`) e da ponte do preload.
 * (2) MODELO REAL — funções puras que decidem texto e disponibilidade de
 *     controlos (percentagem só com total real, instalar só com
 *     downloaded+canInstall, mensagens para todos os códigos de erro).
 * (3) UI REAL (render SSR) — o componente de produção `UpdatesPanel` com
 *     estados construídos: unconfigured honesto, progresso determinístico e
 *     indeterminado, bloqueio do instalar, erro offline, notas em texto
 *     simples, ambiente sem ponte. SSR não prova cliques/foco/teclado — isso
 *     fica para o reteste humano.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => fs.readFileSync(path.join(HERE, ...p), "utf8");

const CONTRACT = read("..", "..", "shared-types", "src", "app-update.ts");
const ELECTRON_TYPES = read("..", "src", "electron.d.ts");

function baseSnapshot(overrides: Partial<AppUpdateSnapshot> = {}): AppUpdateSnapshot {
  return {
    status: "idle",
    channel: "stable",
    installed: { version: "0.1.1", build: "20261017-0000", commit: "abc1234" },
    canInstall: false,
    automaticCheckEnabled: true,
    ...overrides,
  };
}

const NOOP_ACTIONS: UpdatesActions = {
  refresh() {},
  check() {},
  download() {},
  cancel() {},
  defer() {},
  install() {},
  setAutomaticCheck() {},
};

function mount(snapshot: AppUpdateSnapshot | null, extra: Partial<UpdatesViewState> = {}): string {
  const state: UpdatesViewState = { bridgeAvailable: true, loading: false, snapshot, busy: null, actionError: null, ...extra };
  return renderToStaticMarkup(createElement(UpdatesPanel, { state, actions: NOOP_ACTIONS }));
}

/** O tag de abertura de um `<button data-testid="...">` — para ler `disabled`. */
function buttonTag(html: string, testid: string): string {
  const match = html.match(new RegExp(`<button[^>]*data-testid="${testid}"[^>]*>`));
  assert.ok(match, `elemento ${testid} ausente no render`);
  return match[0];
}

describe("Atualizações — contrato real que a UI tem de honrar", () => {
  it("cobre os estados que a UI mostra (unconfigured/unsupported/downloading/downloaded)", () => {
    for (const estado of [
      "unconfigured", "unsupported", "idle", "checking", "up-to-date", "available",
      "downloading", "verifying", "downloaded", "deferred", "installing", "error",
    ]) {
      assert.ok(CONTRACT.includes(`"${estado}"`), `estado em falta no contrato: ${estado}`);
    }
  });

  it("offline é um erro real do contrato (a UI não inventa estados)", () => {
    assert.ok(CONTRACT.includes('"offline"'), "código de erro offline ausente");
    for (const codigo of ["timeout", "integrity", "publisher", "downgrade", "unsupported"]) {
      assert.ok(CONTRACT.includes(`"${codigo}"`), `código de erro em falta: ${codigo}`);
    }
  });

  it("notes são texto simples: nunca renderizar HTML do upstream", () => {
    assert.match(CONTRACT, /Plain text only\. Never render upstream HTML\./);
    assert.match(CONTRACT, /notes: string;/);
  });

  it("progresso só com bytes reais; sem totalBytes é indeterminado (nunca percentagem inventada)", () => {
    assert.match(CONTRACT, /Real bytes only\. Missing total means indeterminate progress\./);
    assert.match(CONTRACT, /progress\?: \{ downloadedBytes: number; totalBytes\?: number \};/);
  });

  it("canInstall não é otimismo da UI: o main só o põe a true após as verificações", () => {
    assert.match(CONTRACT, /Main sets true only after integrity\/authenticity\/publisher\/policy checks\./);
    assert.match(CONTRACT, /canInstall: boolean;/);
  });

  it("install exige confirmação explícita e versão esperada (a UI confirma primeiro)", () => {
    assert.match(CONTRACT, /install\(request: \{ confirmed: true; expectedVersion: string \}/);
    assert.match(CONTRACT, /UI confirms first/);
  });
});

describe("Atualizações — ponto de integração declarado (electron.d.ts)", () => {
  it("a ponte existe no preload com o nome e o tipo do contrato", () => {
    assert.match(ELECTRON_TYPES, /appUpdate: AppUpdateBridge;/);
    assert.match(ELECTRON_TYPES, /AppUpdateBridge,/);
  });

  it("os métodos da ponte batem com o contrato", () => {
    for (const metodo of ["getSnapshot", "check", "download", "cancel", "defer", "install", "setAutomaticCheck", "onState"]) {
      assert.match(CONTRACT, new RegExp(`${metodo}\\(`), `método ausente no contrato: ${metodo}`);
    }
  });
});

describe("Atualizações — modelo real (percentagem, controlos, erros)", () => {
  it("progresso: percentagem só com total real; sem total é indeterminado", () => {
    const comTotal = progressInfo({ downloadedBytes: 1048576, totalBytes: 2097152 });
    assert.equal(comTotal.percent, 50);
    assert.equal(comTotal.text, "1,0 MB de 2,0 MB (50%)");

    const semTotal = progressInfo({ downloadedBytes: 5242880 });
    assert.equal(semTotal.percent, null);
    assert.match(semTotal.text, /total ainda por determinar/);
    assert.match(semTotal.text, /5,0 MB transferidos/);
  });

  it("percentagem fica entre 0 e 100 mesmo com dados estranhos", () => {
    assert.equal(progressInfo({ downloadedBytes: 999, totalBytes: 100 }).percent, 100);
    assert.equal(progressInfo({ downloadedBytes: -5, totalBytes: 100 }).percent, 0);
    assert.equal(progressInfo({ downloadedBytes: 10, totalBytes: 0 }).percent, null);
  });

  it("instalar só com downloaded + canInstall; busy bloqueia tudo", () => {
    const disponible = deriveControls(baseSnapshot({ status: "available" }), null, true);
    assert.equal(disponible.download, true);
    assert.equal(disponible.install, false);

    assert.equal(deriveControls(baseSnapshot({ status: "downloaded", canInstall: true }), null, true).install, true);
    assert.equal(deriveControls(baseSnapshot({ status: "downloaded", canInstall: false }), null, true).install, false);

    const busy = deriveControls(baseSnapshot({ status: "downloaded", canInstall: true }), "install", true);
    assert.equal(busy.install, false);
    assert.equal(busy.check, false);

    const semPonte = deriveControls(baseSnapshot({ status: "available" }), null, false);
    assert.equal(semPonte.download, false);
    assert.equal(semPonte.automatic, false);

    const naoConfigurado = deriveControls(baseSnapshot({ status: "unconfigured" }), null, true);
    assert.equal(naoConfigurado.check, false);
    assert.equal(naoConfigurado.automatic, false);
  });

  it("todos os códigos de erro do contrato têm frase PT-PT própria", () => {
    const codigos = [
      "offline", "timeout", "invalid-manifest", "untrusted-metadata", "integrity",
      "publisher", "downgrade", "interrupted", "cancelled", "busy", "unsupported",
      "unconfigured", "installation", "internal",
    ] as const;
    for (const codigo of codigos) {
      const frase = errorCodeMessage(codigo);
      assert.ok(frase.length > 0, `sem frase para ${codigo}`);
      assert.notEqual(frase, codigo, `frase para ${codigo} não pode ser o próprio código`);
    }
  });
});

describe("Atualizações — UI real (render SSR)", () => {
  it("unconfigured é declarado com honestidade e o verificar fica inativo", () => {
    const html = mount(baseSnapshot({ status: "unconfigured" }));
    assert.match(html, /data-status="unconfigured"/);
    assert.match(html, /ainda não estão configuradas/);
    assert.ok(buttonTag(html, "app-update-check").includes('disabled=""'), "verificar devia estar inativo");
    assert.ok(!html.includes('data-testid="app-update-download"'), "sem download em unconfigured");
    assert.ok(!html.includes('data-testid="app-update-install"'), "sem instalar em unconfigured");
  });

  it("downloading com total real: barra com valor e percentagem dos bytes", () => {
    const html = mount(
      baseSnapshot({
        status: "downloading",
        progress: { downloadedBytes: 1048576, totalBytes: 2097152 },
        latest: { version: "0.2.0", publishedAt: "2026-10-01T10:00:00Z", notes: "Correções." },
      }),
    );
    const bar = html.match(/<div[^>]*data-testid="app-update-progress"[^>]*>/);
    assert.ok(bar, "barra de progresso ausente");
    assert.ok(bar![0].includes('aria-valuenow="50"'), "aria-valuenow tem de ser os bytes reais");
    assert.match(html, /1,0 MB de 2,0 MB \(50%\)/);
    assert.ok(!buttonTag(html, "app-update-cancel").includes('disabled=""'), "cancelar devia estar ativo durante a transferência");
  });

  it("downloading sem total: indeterminado — sem aria-valuenow e sem percentagem", () => {
    const html = mount(
      baseSnapshot({ status: "downloading", progress: { downloadedBytes: 5242880 } }),
    );
    const bar = html.match(/<div[^>]*data-testid="app-update-progress"[^>]*>/);
    assert.ok(bar, "barra de progresso ausente");
    assert.ok(!bar![0].includes("aria-valuenow"), "sem total não pode haver aria-valuenow");
    assert.match(html, /total ainda por determinar/);
    assert.match(html, /5,0 MB transferidos/);
    assert.ok(!html.includes("%"), "sem percentagem inventada em lado nenhum");
  });

  it("downloading com busy=download: o Cancelar continua acessível (é ele que cancela esse busy)", () => {
    const html = mount(
      baseSnapshot({ status: "downloading", progress: { downloadedBytes: 10 } }),
      { busy: "download" },
    );
    const tag = buttonTag(html, "app-update-cancel");
    assert.ok(!tag.includes('disabled=""'), "cancelar não pode ficar inativo pelo busy que ele próprio cancela");
  });

  it("busy=cancel: o botão desaparece (anti duplo cancelamento)", () => {
    const html = mount(
      baseSnapshot({ status: "downloading", progress: { downloadedBytes: 10 } }),
      { busy: "cancel" },
    );
    assert.ok(!html.includes('data-testid="app-update-cancel"'), "com cancelamento em curso não se repete o pedido");
  });

  it("downloaded + canInstall false: instalar bloqueado com explicação", () => {
    const html = mount(
      baseSnapshot({ status: "downloaded", canInstall: false, latest: { version: "0.2.0", publishedAt: "2026-10-01T10:00:00Z", notes: "" } }),
    );
    assert.ok(buttonTag(html, "app-update-install").includes('disabled=""'), "instalar devia estar bloqueado");
    assert.match(html, /ainda não permitem instalar/);
  });

  it("downloaded + canInstall true + privilégios: instalar ativo e aviso presente", () => {
    const html = mount(
      baseSnapshot({
        status: "downloaded",
        canInstall: true,
        requiresElevation: true,
        latest: { version: "0.2.0", publishedAt: "2026-10-01T10:00:00Z", notes: "" },
      }),
    );
    assert.ok(!buttonTag(html, "app-update-install").includes('disabled=""'), "instalar devia estar ativo");
    assert.match(html, /permissões de administrador/);
    assert.match(html, /data-testid="app-update-elevation"/);
  });

  it("erro offline: frase mapeada do código real + mensagem do main", () => {
    const html = mount(
      baseSnapshot({ status: "error", error: { code: "offline", message: "fetch failed" } }),
    );
    assert.match(html, /data-testid="app-update-error"/);
    assert.match(html, /Sem ligação à internet\./);
    assert.match(html, /fetch failed/);
  });

  it("notas são texto simples: HTML do upstream nunca é interpretado", () => {
    const html = mount(
      baseSnapshot({
        status: "available",
        latest: { version: "0.2.0", publishedAt: "2026-10-01T10:00:00Z", notes: "<script>alert(1)</script>\nlinha 2" },
      }),
    );
    assert.ok(html.includes("&lt;script&gt;"), "o HTML das notas tem de aparecer escapado");
    assert.ok(!html.includes("<script>"), "HTML do upstream nunca pode ser interpretado");
  });

  it("sem ponte: o ambiente é declarado e nenhuma ação é oferecida", () => {
    const html = mount(null, { bridgeAvailable: false });
    assert.match(html, /data-status="no-bridge"/);
    assert.match(html, /não está disponível nesta janela/);
    assert.ok(!html.includes('data-testid="app-update-check"'), "sem verificar quando não há ponte");
    assert.ok(!html.includes("<button"), "nenhum botão pode ser oferecido sem ponte");
  });

  it("build/commit desconhecidos são declarados, nunca fingidos", () => {
    const html = mount(baseSnapshot({ installed: { version: "0.1.1" } }));
    assert.match(html, /v0\.1\.1/);
    assert.match(html, /desconhecida/);
    assert.match(html, /desconhecido/);
  });

  it("up-to-date: o botão passa a 'Verificar novamente'", () => {
    const html = mount(baseSnapshot({ status: "up-to-date" }));
    assert.match(html, /Verificar novamente/);
  });
});

describe("Atualizações — modal de confirmação (SSR)", () => {
  it("com dados atuais: 'Instalar agora' ativo e aviso de privilégios presente", () => {
    const html = renderToStaticMarkup(
      createElement(InstallConfirmDialog, {
        version: "0.2.0",
        podeConfirmar: true,
        requiresElevation: true,
        onCancel() {},
        onConfirm() {},
      }),
    );
    assert.ok(!buttonTag(html, "app-update-install-confirm").includes('disabled=""'), "confirmar devia estar ativo");
    assert.match(html, /permissões de administrador/);
    assert.ok(!html.includes('data-testid="app-update-dialog-changed"'), "sem aviso de mudança quando nada mudou");
  });

  it("versão/capacidade mudaram com o aviso aberto: confirmar bloqueado com explicação", () => {
    const html = renderToStaticMarkup(
      createElement(InstallConfirmDialog, { version: "0.2.0", podeConfirmar: false, onCancel() {}, onConfirm() {} }),
    );
    assert.ok(
      buttonTag(html, "app-update-install-confirm").includes('disabled=""'),
      "não pode confirmar dados que já mudaram",
    );
    assert.match(html, /mudaram/);
    assert.match(html, /data-testid="app-update-dialog-changed"/);
  });
});
