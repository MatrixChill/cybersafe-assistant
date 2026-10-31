/**
 * TP-UPDATE-UI (17/10) — módulo "Atualizações" das Definições.
 *
 * Componente de APRESENTAÇÃO puro: recebe o estado e as ações do controller
 * real (injeção de dependências — os testes renderizam-no em SSR com estados
 * construídos). Nada aqui inventa dados: tudo o que aparece vem do snapshot
 * REAL do contrato; sem ponte (browser/testes sem preload) a UI declara que o
 * ambiente não a tem. Cliques/foco/teclado não são provados por SSR — reteste
 * humano. Estilo: só os materiais existentes (`surface-elevated`/`cyber-border`
 * e tokens de tema); zero CSS global novo.
 */
import { useState } from "react";
import { ArrowDownToLine, CheckCircle2, Clock, Download, RefreshCw, ShieldAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { UpdatesActions, UpdatesViewState } from "./appUpdateController";
import {
  checkButtonLabel,
  deriveControls,
  errorCodeMessage,
  formatBytes,
  formatInstalled,
  formatPublishedDate,
  progressInfo,
  statusLabel,
  statusSummary,
} from "./appUpdateModel";
import { InstallConfirmDialog } from "./InstallConfirmDialog";
import { UpdateScopePanel } from "./UpdateScopePanel";

const BUSY_LABELS: Record<string, string> = {
  refresh: "A consultar o estado…",
  check: "A verificar…",
  download: "A iniciar a transferência…",
  cancel: "A cancelar…",
  defer: "A adiar…",
  install: "A confirmar a instalação…",
  automatic: "A guardar a preferência…",
};

const BUTTON_SECONDARY = cn(
  "inline-flex items-center gap-1.5 rounded-lg border border-border bg-secondary px-3 py-1.5 font-mono text-xs text-foreground transition-colors",
  "hover:border-primary/40 hover:bg-secondary/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
  "disabled:opacity-50 disabled:pointer-events-none",
);

const BUTTON_PRIMARY = cn(
  "inline-flex items-center gap-1.5 rounded-lg border border-primary/50 bg-primary/90 px-3 py-1.5 font-mono text-xs font-semibold text-primary-foreground transition-all",
  "hover:bg-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
  "disabled:opacity-50 disabled:pointer-events-none",
);

export interface UpdatesPanelProps {
  state: UpdatesViewState;
  actions: UpdatesActions;
}

export function UpdatesPanel({ state, actions }: UpdatesPanelProps) {
  // O que estava aberto na confirmação (versão vista na altura) + o instalar
  // que era possível na altura. Se mudar com o aviso aberto, confirmar bloqueia.
  const [confirmacao, setConfirmacao] = useState<{ version: string } | null>(null);
  const { bridgeAvailable, loading, snapshot, busy, actionError } = state;
  const controls = deriveControls(snapshot, busy, bridgeAvailable);
  // O `controls.cancel` do modelo parte de "busy livre"; mas o Cancelar tem de
  // continuar acessível DURANTE o download/verificação — é ele que cancela
  // esse `busy` (o controller aceita cancel com `download`/`check` em curso).
  // Só desaparece quando já há um cancelamento em curso (anti-duplo).
  const podeCancelar =
    bridgeAvailable &&
    snapshot !== null &&
    (snapshot.status === "downloading" || snapshot.status === "verifying") &&
    (busy === null || busy === "download" || busy === "check");
  const installed = snapshot !== null ? formatInstalled(snapshot.installed) : null;
  const latest = snapshot?.latest ?? null;
  const showProgress =
    snapshot !== null &&
    snapshot.progress !== undefined &&
    (snapshot.status === "downloading" || snapshot.status === "verifying");
  const progress = showProgress && snapshot?.progress ? progressInfo(snapshot.progress) : null;
  const busyLabel = busy !== null ? BUSY_LABELS[busy] ?? "A processar…" : null;
  const installVersion = latest !== null ? latest.version : "";
  // Confirmação só continua válida enquanto a versão mostrada for a mesma que
  // estava quando o aviso abriu E o instalador continuar disponível (busy
  // livre, downloaded, canInstall). Caso contrário o modal desativa o botão.
  const podeConfirmarInstalacao =
    confirmacao !== null && installVersion === confirmacao.version && controls.install;
  const errorToShow =
    actionError ??
    (snapshot?.status === "error" && snapshot.error ? { code: snapshot.error.code, message: snapshot.error.message } : null);
  const mappedError = errorToShow !== null ? errorCodeMessage(errorToShow.code) : "";
  // Sem snapshot e sem leitura em curso, um erro é TERMINAL: a leitura não
  // respondeu dentro do prazo ou a ponte recusou. O único caminho daqui para
  // fora é um retry EXPLÍCITO do utilizador, que só relê o estado — nunca
  // check/download/install/automatic. Sem isto o painel ficava vazio (ou a
  // "consultar" para sempre) depois de a leitura fechar.
  const readFailed = bridgeAvailable && snapshot === null && !loading && actionError !== null;
  const readError = readFailed ? actionError : null;
  const readErrorMessage = readError !== null ? errorCodeMessage(readError.code) : "";
  const panelStatus =
    snapshot?.status ?? (bridgeAvailable ? (readFailed ? "read-error" : "loading") : "no-bridge");

  return (
    <section
      className="surface-elevated cyber-border rounded-xl p-6"
      aria-busy={busy !== null}
      data-testid="app-update-panel"
      data-status={panelStatus}
    >
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/25 flex items-center justify-center">
          <ArrowDownToLine className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h2 className="font-mono font-semibold text-foreground">Atualizações</h2>
          <p className="text-xs text-muted-foreground">Estado real do atualizador da aplicação - nunca simulado.</p>
        </div>
      </div>

      <UpdateScopePanel bridgeAvailable={bridgeAvailable} snapshot={snapshot} />

      {!bridgeAvailable && (
        <div className="flex items-start gap-3 rounded-lg border border-border bg-secondary/50 p-4" data-testid="app-update-no-bridge">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
          <p className="text-sm leading-relaxed text-muted-foreground">
            A ponte de atualizações não está disponível nesta janela (ambiente sem Electron ou preload
            indisponível). Não é possível verificar, transferir nem instalar.
          </p>
        </div>
      )}

      {bridgeAvailable && loading && snapshot === null && (
        <p className="text-sm font-mono text-muted-foreground" data-testid="app-update-loading" aria-live="polite">
          A consultar o estado das atualizações…
        </p>
      )}

      {readFailed && readError !== null && (
        <div
          className="rounded-lg border border-destructive/40 bg-destructive/10 p-4"
          role="alert"
          data-testid="app-update-read-error"
          data-status="read-error"
        >
          <p className="text-sm font-mono text-destructive">{readErrorMessage}</p>
          {readError.message.length > 0 && readError.message !== readErrorMessage && (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground select-text">{readError.message}</p>
          )}
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Não foi iniciada nenhuma verificação, transferência nem instalação.
          </p>
          <button type="button" data-testid="app-update-retry" onClick={actions.refresh} className={cn(BUTTON_SECONDARY, "mt-3")}>
            <RefreshCw className="w-3.5 h-3.5" aria-hidden /> Tentar novamente
          </button>
        </div>
      )}

      {bridgeAvailable && snapshot !== null && (
        <div className="space-y-4">
          {/* Estado: texto (aria-live) + chip com o status REAL do contrato. */}
          <div className="flex items-start justify-between gap-3" aria-live="polite">
            <p className="text-sm text-foreground leading-relaxed" data-testid="app-update-status-text">
              {statusSummary(snapshot)}
            </p>
            <span
              className="shrink-0 rounded-full border border-border bg-secondary/60 px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground"
              data-testid="app-update-status"
              data-status={snapshot.status}
            >
              {statusLabel(snapshot.status)}
            </span>
          </div>

          {errorToShow !== null && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3" role="alert" data-testid="app-update-error">
              <p className="text-sm font-mono text-destructive">{mappedError}</p>
              {errorToShow.message.length > 0 && errorToShow.message !== mappedError && (
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground select-text">{errorToShow.message}</p>
              )}
            </div>
          )}

          {/* Versão instalada — dados REAIS do main; sem dados diz-se desconhecida. */}
          <dl
            className="grid grid-cols-1 gap-1.5 rounded-lg border border-border bg-secondary/50 p-3 font-mono text-sm sm:grid-cols-3"
            data-testid="app-update-installed"
          >
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Instalada</dt>
              <dd className="text-foreground select-text">{installed?.version}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Compilação</dt>
              <dd className="text-foreground select-text">{installed?.build}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Código</dt>
              <dd className="text-foreground select-text">{installed?.commit}</dd>
            </div>
          </dl>

          {/* Versão disponível + notas: TEXTO SIMPLES (o React escapa o que vier). */}
          {latest !== null && (
            <div className="rounded-lg border border-border bg-secondary/50 p-3" data-testid="app-update-latest">
              <p className="font-mono text-sm text-foreground">
                Versão v{latest.version}
                {latest.sizeBytes !== undefined ? ` · ${formatBytes(latest.sizeBytes)}` : ""}
              </p>
              <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                Publicada em {formatPublishedDate(latest.publishedAt)}
              </p>
              {latest.notes.length > 0 && (
                <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">{latest.notes}</p>
              )}
            </div>
          )}

          {/* Progresso: só com bytes REAIS; sem total é indeterminado. */}
          {progress !== null && (
            <div data-testid="app-update-progress-block">
              <div
                role="progressbar"
                aria-label="Progresso da transferência"
                aria-valuemin={0}
                aria-valuemax={100}
                {...(progress.percent !== null ? { "aria-valuenow": progress.percent } : {})}
                data-testid="app-update-progress"
                className="h-2 w-full overflow-hidden rounded-full border border-border bg-secondary"
              >
                <div
                  className={cn(
                    "h-full rounded-full bg-primary transition-[width] duration-300",
                    progress.percent === null && "w-1/3 animate-pulse",
                  )}
                  style={progress.percent !== null ? { width: `${progress.percent}%` } : undefined}
                />
              </div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <p className="font-mono text-xs text-muted-foreground" aria-live="polite">
                  {progress.text}
                </p>
                {podeCancelar && (
                  <button type="button" data-testid="app-update-cancel" onClick={actions.cancel} className={BUTTON_SECONDARY}>
                    <X className="w-3.5 h-3.5" aria-hidden /> Cancelar
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Ações. Os `disabled` vêm das regras do modelo (estado REAL). */}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" data-testid="app-update-check" onClick={actions.check} disabled={!controls.check} className={BUTTON_SECONDARY}>
              <RefreshCw className={cn("w-3.5 h-3.5", busy === "check" && "animate-spin")} aria-hidden />
              {busy === "check" ? "A verificar…" : checkButtonLabel(snapshot)}
            </button>

            {snapshot.status === "available" && (
              <button type="button" data-testid="app-update-download" onClick={actions.download} disabled={!controls.download} className={BUTTON_PRIMARY}>
                <Download className="w-3.5 h-3.5" aria-hidden /> Transferir
              </button>
            )}

            {(snapshot.status === "available" || snapshot.status === "downloaded") && (
              <button type="button" data-testid="app-update-defer" onClick={actions.defer} disabled={!controls.defer} className={BUTTON_SECONDARY}>
                <Clock className="w-3.5 h-3.5" aria-hidden /> Adiar
              </button>
            )}

            {snapshot.status === "downloaded" && (
              <button
                type="button"
                data-testid="app-update-install"
                onClick={() => setConfirmacao({ version: installVersion })}
                disabled={!controls.install}
                className={BUTTON_PRIMARY}
              >
                <CheckCircle2 className="w-3.5 h-3.5" aria-hidden /> Instalar atualização
              </button>
            )}

            {busyLabel !== null && (
              <span className="font-mono text-xs text-muted-foreground" data-testid="app-update-busy">
                {busyLabel}
              </span>
            )}
          </div>

          {snapshot.manualDownloadOnly && (
            <div role="note" className="rounded border border-border p-3 text-sm">
              Atualização manual: manifesto autenticado e SHA-256 verificado após a transferência.
              O instalador não tem assinatura Authenticode validada. Não será executado automaticamente.
              {snapshot.status === "downloaded" && actions.revealDownload && (
                <button type="button" disabled={state.busy !== null} onClick={() => actions.revealDownload?.()}>
                  Abrir pasta do instalador verificado
                </button>
              )}
            </div>
          )}
          {snapshot.status === "downloaded" && !snapshot.canInstall && (
            <p className="font-mono text-xs text-muted-foreground" data-testid="app-update-install-blocked">
              As verificações de segurança ainda não permitem instalar — o botão fica ativo quando terminarem.
            </p>
          )}

          {snapshot.requiresElevation === true &&
            (snapshot.status === "available" || snapshot.status === "downloaded" || snapshot.status === "installing") && (
              <p className="font-mono text-xs text-muted-foreground" data-testid="app-update-elevation">
                Esta atualização vai pedir permissões de administrador do Windows quando for instalada.
              </p>
            )}

          {/* Verificação automática — preferência REAL do updater. */}
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-secondary/50 p-3">
            <div>
              <p className="text-sm font-mono text-foreground">Verificação automática</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {snapshot.status === "unconfigured" || snapshot.status === "unsupported"
                  ? "Indisponível enquanto as atualizações não estiverem configuradas."
                  : snapshot.automaticCheckEnabled
                    ? "Ligada — a aplicação verifica automaticamente."
                    : "Desligada."}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={snapshot.automaticCheckEnabled}
              aria-label="Verificação automática"
              data-testid="app-update-automatic"
              disabled={!controls.automatic}
              onClick={() => actions.setAutomaticCheck(!snapshot.automaticCheckEnabled)}
              className={cn(
                "relative w-11 h-6 shrink-0 rounded-full transition-colors",
                snapshot.automaticCheckEnabled ? "bg-primary" : "bg-secondary",
                "disabled:opacity-50 disabled:pointer-events-none",
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 w-5 h-5 rounded-full bg-card border border-border transition-transform",
                  snapshot.automaticCheckEnabled ? "translate-x-5.5" : "translate-x-0.5",
                )}
              />
            </button>
          </div>
        </div>
      )}

      {confirmacao !== null && installVersion.length > 0 && (
        <InstallConfirmDialog
          version={installVersion}
          podeConfirmar={podeConfirmarInstalacao}
          requiresElevation={snapshot?.requiresElevation}
          onCancel={() => setConfirmacao(null)}
          onConfirm={() => {
            const pode = podeConfirmarInstalacao;
            setConfirmacao(null);
            if (pode) actions.install(installVersion);
          }}
        />
      )}
    </section>
  );
}
