import type { ProcessTerminationMode, ProcessTerminationPreparation, ProcessTerminationResult, ProcessTerminationSelection } from "@cybersafe/shared-types";
export interface IndividualTerminationBridge {
    prepareProcessTermination(selection: ProcessTerminationSelection): Promise<ProcessTerminationPreparation>;
    confirmProcessTermination(ticket: string): Promise<ProcessTerminationResult>;
    cancelProcessTermination(ticket: string): Promise<unknown>;
}
/**
 * As duas provas que o serviço pode dar de que o objeto pinado foi sinalizado
 * sem nova consulta. `identity-reconfirmed` é o caminho POSIX: Node não expõe
 * `pidfd_open`, por isso o `/proc` é relido imediatamente antes do sinal. Exigir
 * apenas `handle-signaled` faria um kill Linux REAL ser anunciado como falha —
 * o erro honesto é o inverso de aceitar uma afirmação sem prova.
 */
const PROVAS_VALIDAS: readonly string[] = ["handle-signaled", "identity-reconfirmed"];
/**
 * Só se pode oferecer SIGKILL quando o serviço o anunciou. Em Windows a lista
 * é `["sigterm"]`, e um botão de escalada ali seria uma interface sem backend.
 */
export function podeOferecerTerminacaoImediata(prepared: ProcessTerminationPreparation | null | undefined): boolean {
    return prepared?.ok === true && Array.isArray(prepared.modes) && prepared.modes.includes("sigkill");
}
/** A delayed prepare response must not leave an unseen confirmation lease. */
export async function prepareIndividualTermination(api: IndividualTerminationBridge, selection: ProcessTerminationSelection, timeoutMs = 5000): Promise<ProcessTerminationPreparation> {
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const request = api.prepareProcessTermination(selection).then(result => {
        if (expired && result?.ok)
            void api.cancelProcessTermination(result.ticket).catch(() => { });
        return result;
    });
    try {
        return await Promise.race([request, new Promise<ProcessTerminationPreparation>(resolve => {
                timer = setTimeout(() => { expired = true; resolve({ ok: false, status: "timeout", error: "O serviço não confirmou a seleção no prazo; nenhuma terminação foi solicitada." }); }, timeoutMs);
            })]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
/** Never retry after IPC uncertainty, and never trust a status without proof. */
export async function confirmIndividualTermination(api: IndividualTerminationBridge, ticket: string, pid: number, esperado?: ProcessTerminationMode): Promise<ProcessTerminationResult> {
    try {
        const result = await api.confirmProcessTermination(ticket);
        // Um `killed` sem prova de identidade, com outro sinal do que o pedido,
        // sem escopo de processo único ou com outro PID não é sucesso: é uma
        // afirmação do serviço que a UI não pode repetir.
        if (!result || result.pid !== pid || (result.status === "killed" &&
            (!result.success || !PROVAS_VALIDAS.includes(result.confirmation ?? "") ||
                result.scope !== "single-process" || (esperado !== undefined && result.signal !== esperado))))
            return { success: false, status: "failed", pid, error: "O serviço não devolveu confirmação válida da saída; nenhum sucesso foi declarado." };
        return result;
    }
    finally {
        void api.cancelProcessTermination(ticket).catch(() => { });
    }
}
