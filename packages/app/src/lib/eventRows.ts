import type { SecurityEvent } from "@cybersafe/shared-types";

/**
 * Agregação APRESENTATIVA do fluxo de eventos (Hora 1 — spam de processo).
 *
 * A fonte é legitima: um `process.started` por PID novo real (helpers do
 * Opera, rajada de arranque). Não dedupamos nem filtramos nada — apenas
 * dobramos, NA LISTA VISIVEL, os `process.started` do MESMO nome de processo
 * numa linha de grupo expansivel. Cada evento original continua dentro do
 * grupo, com a sua hora e o seu resumo, e nada sai do store.
 *
 * O input é a lista ja ordenada por `sequence` descendente (a ordem do
 * painel). A funcao preserva essa ordem: o grupo aparece na posicao da sua
 * entrada MAIS RECENTE, como estava.
 */

export type EventRow =
  | { kind: "single"; key: string; event: SecurityEvent }
  | { kind: "started-group"; key: string; name: string; events: SecurityEvent[] };

const STARTED_SUMMARY_PREFIX = "Processo iniciado: ";

/** Nome do processo de um `process.started`, ou null se nao discernivel. */
export function startedProcessName(event: SecurityEvent): string | null {
  if (event.type !== "process.started") return null;
  const data = event.data as { name?: unknown } | undefined;
  if (typeof data?.name === "string" && data.name.trim() !== "") return data.name.trim();
  // Fallback: o resumo gerado pelo servico e `Processo iniciado: <nome>`.
  if (event.summary.startsWith(STARTED_SUMMARY_PREFIX)) {
    const name = event.summary.slice(STARTED_SUMMARY_PREFIX.length).trim();
    if (name !== "") return name;
  }
  return null;
}

/**
 * Rows estaveis para render: grupos so quando count >= 2; caso contrario a
 * linha e normal.
 */
export function buildEventRows(events: SecurityEvent[]): EventRow[] {
  const byName = new Map<string, SecurityEvent[]>();
  for (const event of events) {
    const name = startedProcessName(event);
    if (name === null) continue;
    const bucket = byName.get(name);
    if (bucket) bucket.push(event);
    else byName.set(name, [event]);
  }

  const rows: EventRow[] = [];
  const emittedGroups = new Set<string>();
  for (const event of events) {
    const name = startedProcessName(event);
    if (name === null) {
      rows.push({ kind: "single", key: event.id, event });
      continue;
    }
    const bucket = byName.get(name)!;
    if (bucket.length < 2) {
      rows.push({ kind: "single", key: event.id, event });
      continue;
    }
    if (emittedGroups.has(name)) continue; // ja esta na linha, mais acima
    emittedGroups.add(name);
    // Key so pelo nome: unica na lista visivel (os grupos do mesmo nome sao
    // fundidos) e NAO muda quando chega uma entrada nova — quem expandiu um
    // grupo ve-o continuar expandido durante a rajada.
    rows.push({ kind: "started-group", key: `started:${name}`, name, events: bucket });
  }
  return rows;
}

/** Etiqueta PT-PT da contagem na linha de grupo. */
export function startedGroupLabel(count: number): string {
  return count === 1 ? "1 processo iniciado" : `${count} processos iniciados`;
}

/** Prova de que a apresentacao nao perde nenhum evento. */
export function eventsCoveredByRows(rows: EventRow[]): SecurityEvent[] {
  return rows.flatMap((row) => (row.kind === "single" ? [row.event] : row.events));
}
