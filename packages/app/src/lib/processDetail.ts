import type { ConnectionSnapshot, ProcessSnapshot } from "@cybersafe/shared-types";
import { isProtectedProcess } from "@cybersafe/shared-types";

/**
 * HORA 2 — factos do painel de detalhe do processo, derivados SO do que o
 * cliente realmente tem: o snapshot do servico, a lista atual (pai/filhos por
 * `ppid`) e o join de conexoes por `processPid`.
 *
 * Regras de honestidade (auditado): `signer`, `hash` nunca vem preenchidos e
 * `trusted` e sempre "neutral" em producao — nada daqui le esses campos. Tudo
 * o que nao existe escreve-se como desconhecido; nada e inventado.
 */

export interface ProcessDetailFacts {
  pathText: string;
  parentText: string;
  children: ProcessSnapshot[];
  childrenText: string;
  protectionText: string;
}

/** Caminho real ou a falta escrita por extenso. */
export function describePath(p: ProcessSnapshot): string {
  return typeof p.path === "string" && p.path.trim() !== "" ? p.path : "Caminho não disponível";
}

/** Pai pela lista atual: nome quando visivel, senao o PID sozinho ou "desconhecido". */
export function describeParent(p: ProcessSnapshot, all: ProcessSnapshot[]): string {
  const ppid = typeof p.ppid === "number" && Number.isFinite(p.ppid) ? p.ppid : 0;
  if (ppid <= 0) return "desconhecido";
  const parent = all.find((c) => c.pid === ppid);
  if (parent) return `PID ${ppid} · ${parent.name}`;
  return `PID ${ppid} (fora da lista atual)`;
}

/** Filhos derivados DO CLIENTE dos `ppid` da lista atual — nunca do servico. */
export function deriveChildren(p: ProcessSnapshot, all: ProcessSnapshot[]): ProcessSnapshot[] {
  return all.filter((c) => c.pid !== p.pid && c.ppid === p.pid);
}

export function describeChildren(children: ProcessSnapshot[]): string {
  if (children.length === 0) return "nenhum filho visível";
  const nomes = children.slice(0, 6).map((c) => `${c.name} (${c.pid})`).join(", ");
  return children.length > 6 ? `${nomes} · +${children.length - 6}` : nomes;
}

/** Classificacao real: protegido ou nao — so isto. `trusted` neutral nao e sinal. */
export function describeProtection(p: ProcessSnapshot): string {
  return isProtectedProcess(p)
    ? "Protegido — o Windows precisa dele"
    : "Não protegido";
}

export function buildProcessDetailFacts(p: ProcessSnapshot, all: ProcessSnapshot[]): ProcessDetailFacts {
  const children = deriveChildren(p, all);
  return {
    pathText: describePath(p),
    parentText: describeParent(p, all),
    children,
    childrenText: describeChildren(children),
    protectionText: describeProtection(p),
  };
}

/** Join cliente-side: conexoes cujo `processPid` e este PID. `undefined` nunca entra. */
export function connectionsForPid(connections: ConnectionSnapshot[], pid: number): ConnectionSnapshot[] {
  return connections.filter((c) => typeof c.processPid === "number" && c.processPid === pid);
}

/**
 * F1 — identidade de INSTANCIA, nao de PID.
 *
 * O PID e um numero emprestado: entre dois snapshots o Windows pode reusa-lo
 * para um processo novo. `startedAt` e a identidade que o proprio servico
 * usa para a mesma decisao. PID igual com `startedAt` diferente = processo
 * NOVO: o detalhe antigo nao pode colar-se a ele.
 */
export interface ProcessInstance {
  pid: number;
  startedAt: string;
}

export function sameInstance(a: ProcessInstance | null | undefined, b: ProcessInstance | null | undefined): boolean {
  if (!a || !b) return false;
  return a.pid === b.pid && a.startedAt === b.startedAt;
}

/** Linha de conexao com os campos que existem de facto. */
export function formatConnectionLine(c: ConnectionSnapshot): string {
  const destino = `${c.remoteAddress}:${c.remotePort ?? "-"}`;
  const seta = c.direction === "inbound" ? "← entrada" : "→ saída";
  const extra = c.state ?? c.protocol ?? "estado não reportado";
  return `${seta} ${destino} · ${extra}`;
}

/**
 * Estado da leitura de conexoes no painel (o join e feito quando o resultado
 * chega). F2: `readAt` e a HORA DA LEITURA — a lista e um snapshot, nao um
 * direto; o painel diz desde quando fala.
 */
export type DetailConnections =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; connections: ConnectionSnapshot[]; readAt?: string };
