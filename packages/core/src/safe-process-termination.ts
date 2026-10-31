import { randomUUID } from "node:crypto";
import { PROCESS_TERMINATION_TICKET_MS, PROCESS_TERMINATION_WAIT_MS } from "@cybersafe/shared-types";
import type { ProcessTerminationPreparation, ProcessTerminationResult } from "@cybersafe/shared-types";
export interface TerminationIdentity {
    pid: number;
    name: string;
    path: string;
    startedAt: string;
    creation: string;
    eligible: boolean;
    reason?: string;
}
export interface TerminationLease {
    read(): TerminationIdentity;
    exited(): boolean;
    terminate(): void;
    close(): void;
}
export interface TerminationAudit {
    pid: number;
    status: ProcessTerminationResult["status"];
    source: "user-confirmed";
    operationId: string;
    win32Code?: number;
}
interface Dependencies {
    open(pid: number): TerminationLease;
    blocked(identity?: TerminationIdentity): string | null;
    audit(event: TerminationAudit): void;
}
/** Parse a round-trip timestamp without losing the fractional component. */
export function exactCreationStamp(value: unknown): string | null {
    if (typeof value !== "string" || value.length > 40)
        return null;
    const match = /\.(\d{7})(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
    const ms = Date.parse(value);
    if (!match || !Number.isFinite(ms) || ms > Date.now())
        return null;
    return ((BigInt(ms) + 11644473600000n) * 10000n + BigInt(match[1].slice(3))).toString();
}
/** Win32_Process/CIM publishes microseconds (the round-trip .NET string
 * pads a seventh zero). Preparing is non-destructive; the confirmation modal
 * receives the full native identity and its ticket pins that exact object.
 * Comparisons after prepare use the complete FILETIME, never this projection. */
export function matchesSnapshotCreation(snapshot: unknown, nativeCreation: string): boolean {
    const selected = exactCreationStamp(snapshot);
    if (!selected || !/^\d+$/.test(nativeCreation))
        return false;
    return selected.endsWith("0") ? BigInt(selected) / 10n === BigInt(nativeCreation) / 10n : selected === nativeCreation;
}
const message = {
    protected: "Processo protegido ou não elegível; nenhuma terminação foi executada.",
    failed: "Não foi possível confirmar a identidade ou a disponibilidade da operação.",
    reused: "A identidade do processo mudou; selecione novamente o processo.",
    "access-denied": "O Windows recusou o acesso ao processo (erro 5).",
    "already-exited": "O processo já tinha saído; nenhuma terminação foi atribuída ao CyberSafe.",
    timeout: "Terminação solicitada, mas a saída não foi confirmada dentro do prazo. Não foi declarado sucesso.",
};
export class SafeProcessTermination {
    private tickets = new Map<string, {
        lease: TerminationLease;
        identity: TerminationIdentity;
        expiresAt: number;
        timer: NodeJS.Timeout;
    }>();
    private disposed = false;
    private inFlight = false;
    readonly waitMs = PROCESS_TERMINATION_WAIT_MS;
    constructor(private readonly deps: Dependencies) { }
    private failure(pid: number, status: keyof typeof message, win32Code?: number): ProcessTerminationResult {
        return { success: false, pid, status, error: message[status] + (win32Code === undefined || win32Code === 5 ? "" : ` (Windows: ${win32Code})`), ...(win32Code === undefined ? {} : { win32Code }) };
    }
    prepare(input: unknown): ProcessTerminationPreparation {
        const p = input as {
            pid?: number;
            startedAt?: string;
        } | null;
        const creation = exactCreationStamp(p?.startedAt);
        if (!p || !Number.isInteger(p.pid) || p.pid! <= 100 || p.pid! > 0xffffffff || !creation || this.disposed || this.inFlight || this.deps.blocked())
            return { ok: false, status: "failed", error: message.failed };
        let lease: TerminationLease | undefined;
        try {
            if (this.tickets.size >= 8)
                return { ok: false, status: "failed", error: "Há confirmações pendentes; feche-as antes de continuar." };
            lease = this.deps.open(p.pid!);
            if (lease.exited())
                return { ok: false, status: "already-exited", error: message["already-exited"] };
            const identity = lease.read();
            if (identity.pid !== p.pid || !matchesSnapshotCreation(p.startedAt, identity.creation) || exactCreationStamp(identity.startedAt) !== identity.creation)
                return { ok: false, status: "reused", error: message.reused };
            if (!identity.eligible || this.deps.blocked(identity))
                return { ok: false, status: "protected", error: message.protected };
            const ticket = randomUUID();
            const expiresAt = Date.now() + PROCESS_TERMINATION_TICKET_MS;
            const timer = setTimeout(() => this.cancel(ticket), PROCESS_TERMINATION_TICKET_MS);
            timer.unref();
            this.tickets.set(ticket, { lease, identity, expiresAt, timer });
            lease = undefined;
            return { ok: true, ticket, target: { pid: identity.pid, name: identity.name, startedAt: identity.startedAt }, expiresAt };
        }
        catch (error) {
            const code = (error as {
                win32Code?: number;
            }).win32Code;
            return { ok: false, status: code === 5 ? "access-denied" : code === 87 ? "already-exited" : "failed", error: code === 5 ? message["access-denied"] : code === 87 ? message["already-exited"] : message.failed + (Number.isInteger(code) ? ` (Windows: ${code})` : ""), ...(Number.isInteger(code) ? { win32Code: code } : {}) };
        }
        finally {
            lease?.close();
        }
    }
    cancel(ticket: unknown): {
        cancelled: boolean;
    } {
        if (typeof ticket !== "string")
            return { cancelled: false };
        const entry = this.tickets.get(ticket);
        if (!entry)
            return { cancelled: false };
        this.tickets.delete(ticket);
        clearTimeout(entry.timer);
        entry.lease.close();
        return { cancelled: true };
    }
    async confirm(ticket: unknown): Promise<ProcessTerminationResult> {
        const entry = typeof ticket === "string" ? this.tickets.get(ticket) : undefined;
        if (!entry)
            return this.failure(0, "failed");
        this.tickets.delete(ticket as string);
        clearTimeout(entry.timer);
        const { lease, identity } = entry;
        let result: ProcessTerminationResult = this.failure(identity.pid, "failed");
        if (this.inFlight) {
            lease.close();
            return result;
        }
        this.inFlight = true;
        try {
            if (this.disposed || Date.now() >= entry.expiresAt)
                return result;
            if (this.deps.blocked())
                return result = { ...this.failure(identity.pid, "protected"), error: "Operação recusada: existe uma operação crítica ou a sessão deixou de ser elegível." };
            if (lease.exited())
                return result = { success: false, status: "already-exited", pid: identity.pid, error: message["already-exited"] };
            // No await between final gate/read and native action. The retained handle
            // pins the object; no PID lookup, taskkill or tree traversal follows.
            const current = lease.read();
            if (current.pid !== identity.pid || current.creation !== identity.creation || current.path !== identity.path)
                return result = this.failure(identity.pid, "reused");
            if (!current.eligible || this.deps.blocked(current))
                return result = this.failure(identity.pid, "protected");
            lease.terminate();
            const deadline = performance.now() + this.waitMs;
            while (!lease.exited()) {
                if (performance.now() >= deadline)
                    return result = this.failure(identity.pid, "timeout");
                await new Promise(resolve => setTimeout(resolve, 25));
            }
            return result = { success: true, status: "killed", pid: identity.pid, confirmation: "handle-signaled", scope: "single-process" };
        }
        catch (error) {
            const code = (error as {
                win32Code?: number;
            }).win32Code;
            return result = this.failure(identity.pid, code === 5 ? "access-denied" : "failed", Number.isInteger(code) ? code : undefined);
        }
        finally {
            this.inFlight = false;
            lease.close();
            try {
                this.deps.audit({ pid: identity.pid, status: result.status, source: "user-confirmed", operationId: ticket as string, win32Code: result.win32Code });
            }
            catch { }
        }
    }
    dispose(): void { this.disposed = true; for (const ticket of this.tickets.keys())
        this.cancel(ticket); }
}
