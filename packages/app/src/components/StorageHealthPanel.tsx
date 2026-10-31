import { TechnicalDiagnostic, redactDiagnostic } from "./TechnicalDiagnostic";
import type { DiskSnapshot } from "@cybersafe/shared-types";
import { estadoContadoresPorDisco, storageHealthView } from "@/lib/storageHealthDisplay";

/**
 * Saúde FÍSICA dos discos, dentro do cartão de armazenamento existente.
 *
 * Presentational puro: recebe o `DiskSnapshot` e mostra o que foi medido.
 * Não calcula saúde, não inventa percentagens e não mostra 0% quando não há
 * leitura. O estado do Windows e o estado dos contadores são linhas separadas.
 *
 * Divulgação progressiva (GUI-TEST 02): o resumo (modelo, tipo, capacidade,
 * Windows, contadores, quantidade de discos e última leitura) fica compacto no
 * cartão. As leituras e os motivos por disco vivem num `<details>` que, no PC
 * Center, é montado numa superfície própria FORA da grelha — abrir os detalhes
 * não estica Rede/Bateria. `<details>`/`<summary>` são nativos: sem estado novo,
 * sem animação e operáveis por teclado.
 */
export function StorageHealthPanel({
  disk,
  nowMs,
  mode = "full",
}: {
  disk: DiskSnapshot | null | undefined;
  nowMs?: number;
  /**
   * `summary` = só o resumo compacto (cartão de armazenamento);
   * `details` = identificação por disco + leituras/motivos (superfície independente);
   * `full` = os dois, mantendo o contrato dos testes existentes.
   */
  mode?: "full" | "summary" | "details";
}) {
  const view = storageHealthView(disk, nowMs);
  const diagnostic = [...new Set([disk?.physicalDetail, disk?.physicalErrorDetail].filter((text): text is string => Boolean(text)))].join("\n\n");
  const hint = !disk?.physical
    ? "Ainda não há leitura da saúde física dos discos."
    : view.overallStatus === "denied"
      ? "O Windows não permitiu consultar os contadores de fiabilidade."
      : view.overallStatus === "unsupported"
        ? "Os sensores de fiabilidade não são suportados neste sistema."
        : view.overallStatus === "partial"
          ? `Suporte parcial: ${view.disks.filter(d => d.countersStatus === "available").length} de ${view.disks.length} discos com contadores disponíveis.`
          : view.overallStatus === "invalid"
            ? "A consulta não devolveu valores utilizáveis."
            : view.overallStatus === "unavailable"
              ? "Não foi possível consultar a saúde física dos discos."
              : null;
  const mostrarResumo = mode !== "details";
  const mostrarDetalhes = mode !== "summary";
  const agregado = mode === "summary";
  const contagem =
    view.disks.length === 1 ? "1 disco físico" : `${view.disks.length} discos físicos`;

  // O resumo agregado não repete modelo/tipo/Windows/counters de cada disco.
  // A heterogeneidade é dita uma vez; a identificação por disco fica nos detalhes.
  const windowsCounts = new Map<string, number>();
  for (const d of view.disks) {
    const label = d.windowsHealthText.replace(/^Windows:\s*/, "");
    windowsCounts.set(label, (windowsCounts.get(label) ?? 0) + 1);
  }
  const windowsSummary =
    view.disks.length > 0
      ? `Windows: ${[...windowsCounts.entries()].map(([label, n]) => `${label} (${n})`).join(" · ")}`
      : null;
  const estadosDistintos =
    new Set(view.disks.map((d) => `${d.countersStatus}|${d.windowsHealthText}`)).size > 1;

  return (
    <div
      data-testid="storage-health"
      data-mode={mode}
      className={`min-w-0 max-w-full [overflow-wrap:anywhere] ${mode === "details" ? "" : "mt-3 border-t border-border/40 pt-2"}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Saúde física
        </span>
        <span data-testid="storage-health-overall" className="font-mono text-[11px] text-foreground">
          {view.overallText}
        </span>
      </div>

      {hint && (
        <p data-testid="storage-health-hint" className="mt-1 font-mono text-[11px] leading-snug text-muted-foreground">
          {hint}
        </p>
      )}

      {view.updatedText && (
        <p data-testid="storage-health-updated" className="mt-1 font-mono text-[11px] text-muted-foreground/70">
          {view.updatedText}
        </p>
      )}
      {view.staleText && (
        <p data-testid="storage-health-stale" role="status" className="mt-0.5 font-mono text-[11px] leading-snug text-cyber-yellow">
          {view.staleText}
        </p>
      )}
      {view.errorText && (
        <p data-testid="storage-health-error" role="status" className="mt-1 text-xs text-cyber-yellow">
          A última tentativa de leitura falhou. Os valores anteriores, quando existentes, não são uma leitura nova.
        </p>
      )}
      {mostrarDetalhes && diagnostic && (
        <TechnicalDiagnostic summary="Diagnóstico da consulta de saúde física." details={diagnostic} />
      )}

      {mostrarResumo && view.disks.length === 0 && (
        <p data-testid="storage-health-empty" className="mt-1 font-mono text-[11px] text-muted-foreground">
          Nenhum disco físico reportado.
        </p>
      )}

      {mostrarResumo && view.disks.length > 0 && (
        <p data-testid="storage-health-disk-count" className="mt-1 font-mono text-xs text-muted-foreground">
          {contagem}
        </p>
      )}

      {agregado && windowsSummary && (
        <p data-testid="storage-windows-summary" className="mt-0.5 font-mono text-[11px] text-muted-foreground">
          {windowsSummary}
        </p>
      )}

      {agregado && estadosDistintos && (
        <p data-testid="storage-health-heterogeneous" role="status" className="mt-0.5 font-mono text-[11px] leading-snug text-cyber-yellow">
          Estados diferentes por disco; a identificação de cada um está em «Detalhes por disco».
        </p>
      )}

      {mostrarResumo && !agregado &&
        view.disks.map((d) => {
          // O aviso global de `denied` já foi dado uma vez. Só se repete por disco
          // quando aquele disco difere do estado global.
          const contadoresDoDisco = estadoContadoresPorDisco(view.overallStatus, d.countersStatus);
          return (
            <div key={`${d.deviceId}-resumo`} data-testid="storage-disk" className="mt-2">
              <p className="font-mono text-[11px] text-foreground">{redactDiagnostic(d.title)}</p>
              <p data-testid="storage-disk-subtitle" className="font-mono text-[10px] text-muted-foreground">
                {redactDiagnostic(d.subtitle)}
              </p>
              <p data-testid="storage-disk-windows-health" className="font-mono text-[10px] text-muted-foreground">
                {d.windowsHealthText}
              </p>
              {contadoresDoDisco && (
                <p data-testid="storage-disk-counters" className="font-mono text-[10px] text-muted-foreground">
                  {contadoresDoDisco}
                </p>
              )}
            </div>
          );
        })}      {mostrarDetalhes &&
        view.disks.map((d) => {
          const repetirGlobalDenied = view.overallStatus === "denied" && d.countersStatus === "denied";
          const motivoDoDisco =
            repetirGlobalDenied && d.countersHint === view.overallHint ? null : d.countersHint;
          const notaDoDisco = repetirGlobalDenied ? null : d.missingReadingNote;
          const contadoresDoDisco = repetirGlobalDenied
            ? null
            : estadoContadoresPorDisco(view.overallStatus, d.countersStatus);
          const temDetalhes =
            d.readings.length > 0 || motivoDoDisco !== null || notaDoDisco !== null;
          const conteudo = (
            <>
              {d.readings.length > 0 && (
                <p data-testid="storage-disk-readings" className="mt-1 font-mono text-[11px] text-foreground">
                  {d.readings.map((r) => `${r.label}: ${r.value}`).join(" · ")}
                </p>
              )}
              {motivoDoDisco && (
                <div data-testid="storage-disk-reason" className="mt-0.5 font-mono text-[11px] leading-snug text-muted-foreground/70">
                  <TechnicalDiagnostic summary="Diagnóstico dos sensores deste disco." details={motivoDoDisco} />
                </div>
              )}
              {notaDoDisco && (
                <p data-testid="storage-disk-missing" className="mt-0.5 font-mono text-[11px] leading-snug text-muted-foreground/70">
                  {notaDoDisco}
                </p>
              )}
            </>
          );
          // Na superfície independente o próprio `<details>` exterior já é a
          // divulgação: não se pede um segundo clique por disco. A identificação
          // (modelo, tipo/capacidade, Windows e estado SMART individual) aparece
          // SEMPRE, mesmo quando não há leituras nem motivo próprio a repetir.
          if (!mostrarResumo) {
            return (
              <div key={`${d.deviceId}-detalhes`} data-testid="storage-disk-details" className="mt-3">
                <p className="font-mono text-xs text-foreground">{redactDiagnostic(d.title)}</p>
                <p data-testid="storage-disk-subtitle" className="font-mono text-[11px] text-muted-foreground">
                  {redactDiagnostic(d.subtitle)}
                </p>
                <p data-testid="storage-disk-windows-health" className="font-mono text-[11px] text-muted-foreground">
                  {d.windowsHealthText}
                </p>
                {contadoresDoDisco && (
                  <p data-testid="storage-disk-counters" className="font-mono text-[11px] text-muted-foreground">
                    {contadoresDoDisco}
                  </p>
                )}
                {conteudo}
              </div>
            );
          }
          if (!temDetalhes) return null;
          return (
            <details key={`${d.deviceId}-detalhes`} data-testid="storage-disk-details" className="mt-1">
              <summary className="cursor-pointer font-mono text-[10px] text-muted-foreground">
                Detalhes
              </summary>
              {conteudo}
            </details>
          );
        })}

      {mostrarResumo && view.occupationNote && (
        <p data-testid="storage-occupation-note" className="mt-2 font-mono text-[10px] leading-snug text-muted-foreground/70">
          {view.occupationNote}
        </p>
      )}
    </div>
  );
}
