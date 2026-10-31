import type { ProcessTerminationSelection } from "@cybersafe/shared-types";
type Handler = (_event: unknown, ...args: any[]) => unknown;
interface Operations {
    prepare(selection: ProcessTerminationSelection): unknown;
    confirm(ticket: string): unknown;
    cancel(ticket: string): unknown;
    critical(): boolean;
}
export function registerProcessTerminationIpc(handle: (channel: string, handler: Handler) => void, ops: Operations): void {
    const ticket = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
    handle("service:prepare-process-termination", (_event, selection: unknown) => {
        const p = selection as Partial<ProcessTerminationSelection> | null;
        if (!p || !Number.isInteger(p.pid) || p.pid! <= 100 || p.pid! > 0xffffffff || typeof p.startedAt !== "string" || p.startedAt.length > 40 || !Number.isFinite(Date.parse(p.startedAt)))
            return { ok: false, status: "failed", error: "Seleção de processo inválida." };
        if (ops.critical())
            return { ok: false, status: "protected", error: "Terminação indisponível durante operação crítica da aplicação." };
        return ops.prepare({ pid: p.pid!, startedAt: p.startedAt });
    });
    handle("service:confirm-process-termination", (_event, value: unknown) => {
        if (!ticket(value) || ops.critical())
            return { success: false, status: "failed", pid: 0, error: "Confirmação inválida ou operação crítica em curso." };
        return ops.confirm(value);
    });
    handle("service:cancel-process-termination", (_event, value: unknown) => ticket(value) ? ops.cancel(value) : { cancelled: false });
}
