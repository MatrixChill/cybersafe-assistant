import { randomUUID } from "node:crypto";
import { PROCESS_TERMINATION_TICKET_MS, PROCESS_TERMINATION_WAIT_MS } from "@cybersafe/shared-types";
import type { ProcessTerminationMode, ProcessTerminationPreparation, ProcessTerminationResult } from "@cybersafe/shared-types";
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
    /**
     * Como este lease prende o objeto entre a preparação e o sinal. O lease do
     * Windows deixa isto em `undefined` e recebe `"handle-signaled"`, que é o
     * que ele faz. Um lease POSIX sem `pidfd` não pode dizer isso: relê a
     * identidade instantes antes do sinal e tem de nomear esse facto.
     */
    confirmation?: Exclude<ProcessTerminationResult["confirmation"], undefined>;
}
export interface TerminationAudit {
    pid: number;
    status: ProcessTerminationResult["status"];
    source: "user-confirmed";
    operationId: string;
    win32Code?: number;
    /** O modo pinado no bilhete. Auditoria sem isto não diria o que foi pedido. */
    signal?: ProcessTerminationMode;
}
interface Dependencies {
    /**
     * O lease é aberto JÁ com o modo, por isso o sinal fica fixado entre a
     * preparação e o sinal: um `confirm` não pode promover SIGTERM a SIGKILL.
     * A escalada tem de ser um novo `prepare` — novo bilhete, nova confirmação
     * explícita, exatamente como o pedido separava as duas operações.
     */
    open(pid: number, mode: ProcessTerminationMode): TerminationLease;
    blocked(identity?: TerminationIdentity): string | null;
    audit(event: TerminationAudit): void;
    /** Modos que esta plataforma sabe cumprir. Omitido = apenas o pedido normal. */
    modes?: ProcessTerminationMode[];
}
/**
 * O modo vem dito à letra no pedido: `undefined` é o pedido normal (`sigterm`)
 * e `sigkill` tem de vir explícito. Qualquer outro valor é RECUSADO em vez de
 * suavizado para SIGTERM — engolir `"SIGKILL"` ou `"sigkill "` e converter-lhe
 * um terminate normal faria a UI anunciar uma operação e o serviço fazer outra.
 */
export function modoTerminacaoPedido(value: unknown): ProcessTerminationMode | null {
    if (value === undefined || value === "sigterm")
        return "sigterm";
    return value === "sigkill" ? "sigkill" : null;
}
/**
 * O que cada plataforma pode cumprir, não o que a UI gostaria de mostrar.
 * Em Windows o bilhete pinha um handle e `TerminateProcess` é uma coisa só: não
 * há SIGTERM nem SIGKILL, e anunciar `sigkill` aqui seria um botão que o
 * backend não tem. Em POSIX os dois sinais existem e o `process.kill` entrega
 * ambos ao processo do próprio utilizador — daí a escalada explícita existir
 * apenas neste lado.
 */
export function modosTerminacao(plataforma: NodeJS.Platform = process.platform): ProcessTerminationMode[] {
    return plataforma === "win32" ? ["sigterm"] : ["sigterm", "sigkill"];
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
/**
 * Estas duas não passam por `failure()`, que só aceita estados de kill. Um
 * pedido de modo inválido não é um `protected` nem um `timeout`: não houve
 * identidade avaliada nem sinal entregue, houve uma recusa de protocolo.
 */
const recusaModo = {
    invalido: "Modo de terminação não reconhecido; nenhum bilhete foi emitido e nenhum sinal foi enviado.",
    indisponivel: "A terminação imediata (SIGKILL) não está disponível nesta plataforma; nenhum bilhete foi emitido e nenhum sinal foi enviado.",
};
export class SafeProcessTermination {
    private tickets = new Map<string, {
        lease: TerminationLease;
        identity: TerminationIdentity;
        mode: ProcessTerminationMode;
        expiresAt: number;
        timer: NodeJS.Timeout;
    }>();
    private disposed = false;
    private inFlight = false;
    readonly waitMs = PROCESS_TERMINATION_WAIT_MS;
    private readonly modes: readonly ProcessTerminationMode[];
    constructor(private readonly deps: Dependencies) {
        this.modes = Object.freeze([...deps.modes ?? ["sigterm"]]);
    }
    private failure(pid: number, status: keyof typeof message, win32Code?: number): ProcessTerminationResult {
        return { success: false, pid, status, error: message[status] + (win32Code === undefined || win32Code === 5 ? "" : ` (Windows: ${win32Code})`), ...(win32Code === undefined ? {} : { win32Code }) };
    }
    prepare(input: unknown): ProcessTerminationPreparation {
        const p = input as {
            pid?: number;
            startedAt?: string;
            mode?: unknown;
        } | null;
        const creation = exactCreationStamp(p?.startedAt);
        if (!p || !Number.isInteger(p.pid) || p.pid! <= 100 || p.pid! > 0xffffffff || !creation || this.disposed || this.inFlight || this.deps.blocked())
            return { ok: false, status: "failed", error: message.failed };
        // O modo é validado antes de abrir seja o que for: uma recusa de
        // protocolo não pode deixar um lease pendurado nem, pior, um bilhete
        // que o utilizador confirme depois achando que pediu outra coisa.
        const mode = modoTerminacaoPedido(p.mode);
        if (!mode)
            return { ok: false, status: "failed", error: recusaModo.invalido };
        if (!this.modes.includes(mode))
            return { ok: false, status: "failed", error: recusaModo.indisponivel };
        let lease: TerminationLease | undefined;
        try {
            if (this.tickets.size >= 8)
                return { ok: false, status: "failed", error: "Há confirmações pendentes; feche-as antes de continuar." };
            lease = this.deps.open(p.pid!, mode);
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
            this.tickets.set(ticket, { lease, identity, mode, expiresAt, timer });
            lease = undefined;
            return { ok: true, ticket, target: { pid: identity.pid, name: identity.name, startedAt: identity.startedAt }, expiresAt, mode, modes: [...this.modes] };
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
        const { lease, identity, mode } = entry;
        /**
         * Todo resultado posterior a um bilhete nomeia o sinal que esse bilhete
         * pinou. Um `timeout` sem isto diria "a terminação falhou" sem dizer que
         * foi um SIGTERM legítimo a não produzir saída — que é precisamente a
         * situação em que uma escalada para SIGKILL pode ser oferecida.
         */
        const sinalar = (r: ProcessTerminationResult): ProcessTerminationResult => ({ ...r, signal: mode });
        let result: ProcessTerminationResult = sinalar(this.failure(identity.pid, "failed"));
        if (this.inFlight) {
            lease.close();
            return result;
        }
        this.inFlight = true;
        try {
            if (this.disposed || Date.now() >= entry.expiresAt)
                return result;
            if (this.deps.blocked())
                return result = sinalar({ ...this.failure(identity.pid, "protected"), error: "Operação recusada: existe uma operação crítica ou a sessão deixou de ser elegível." });
            if (lease.exited())
                return result = sinalar({ success: false, status: "already-exited", pid: identity.pid, error: message["already-exited"] });
            // No await between final gate/read and native action. The retained handle
            // pins the object; no PID lookup, taskkill or tree traversal follows.
            const current = lease.read();
            if (current.pid !== identity.pid || current.creation !== identity.creation || current.path !== identity.path)
                return result = sinalar(this.failure(identity.pid, "reused"));
            if (!current.eligible || this.deps.blocked(current))
                return result = sinalar(this.failure(identity.pid, "protected"));
            lease.terminate();
            const deadline = performance.now() + this.waitMs;
            while (!lease.exited()) {
                if (performance.now() >= deadline)
                    return result = sinalar(this.failure(identity.pid, "timeout"));
                await new Promise(resolve => setTimeout(resolve, 25));
            }
            return result = sinalar({ success: true, status: "killed", pid: identity.pid, confirmation: lease.confirmation ?? "handle-signaled", scope: "single-process" });
        }
        catch (error) {
            const code = (error as {
                win32Code?: number;
            }).win32Code;
            return result = sinalar(this.failure(identity.pid, code === 5 ? "access-denied" : "failed", Number.isInteger(code) ? code : undefined));
        }
        finally {
            this.inFlight = false;
            lease.close();
            try {
                this.deps.audit({ pid: identity.pid, status: result.status, source: "user-confirmed", operationId: ticket as string, win32Code: result.win32Code, signal: mode });
            }
            catch { }
        }
    }
    dispose(): void { this.disposed = true; for (const ticket of this.tickets.keys())
        this.cancel(ticket); }
}
