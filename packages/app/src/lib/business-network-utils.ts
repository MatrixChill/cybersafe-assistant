import type { ConnectionSnapshot, ProcessSnapshot } from "@cybersafe/shared-types";

export interface EnrichedConnection {
  connection: ConnectionSnapshot;
  processName: string;
  processPid: number | null;
  processPath: string | null;
}

/**
 * True state of the data source: the Windows bridge currently collects
 * TCP connections only (Get-NetTCPConnection). UDP counting would be a
 * misleading zero, so availability is tracked explicitly and the UI
 * must show "Indisponível" instead of a fabricated number.
 */
export const UDP_COLLECTION_AVAILABLE = false;

export function buildProcessMap(processes: ProcessSnapshot[]): Map<number, ProcessSnapshot> {
  const map = new Map<number, ProcessSnapshot>();
  for (const p of processes) {
    map.set(p.pid, p);
  }
  return map;
}

export function enrichConnections(
  connections: ConnectionSnapshot[],
  processMap: Map<number, ProcessSnapshot>,
): EnrichedConnection[] {
  return connections.map((conn) => {
    const pid = conn.processPid ?? null;
    const process = pid != null ? processMap.get(pid) : undefined;
    return {
      connection: conn,
      processName: process?.name ?? conn.processName ?? "Processo desconhecido",
      processPid: pid,
      processPath: process?.path ?? null,
    };
  });
}

/**
 * True "unique destination" count = distinct observed remoteAddress
 * values, regardless of whether they are public or local (LAN/loopback).
 * The card is therefore labeled "Destinos únicos" — not "Destinos externos"
 * — because no external/private classification is performed here.
 */
export function countUniqueDestinations(connections: ConnectionSnapshot[]): number {
  const seen = new Set<string>();
  for (const c of connections) {
    const addr = c.remoteAddress?.trim();
    if (addr && !seen.has(addr)) {
      seen.add(addr);
    }
  }
  return seen.size;
}

export function isTCP(conn: ConnectionSnapshot): boolean {
  const p = (conn.protocol ?? "").toLowerCase();
  return p === "tcp" || p === "tcp4" || p === "tcp6" || (!p && conn.state !== "unspecified");
}

/** Filtering helper used only when UDP collection is truly available. */
export function isUDP(conn: ConnectionSnapshot): boolean {
  const p = (conn.protocol ?? "").toLowerCase();
  return p === "udp" || p === "udp4" || p === "udp6";
}