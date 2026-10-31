import type { ProcessTerminationPreparation, ProcessTerminationResult, ProcessTerminationSelection } from "@cybersafe/shared-types";
export interface IndividualTerminationBridge {
    prepareProcessTermination(selection: ProcessTerminationSelection): Promise<ProcessTerminationPreparation>;
    confirmProcessTermination(ticket: string): Promise<ProcessTerminationResult>;
    cancelProcessTermination(ticket: string): Promise<unknown>;
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
export async function confirmIndividualTermination(api: IndividualTerminationBridge, ticket: string, pid: number): Promise<ProcessTerminationResult> {
    try {
        const result = await api.confirmProcessTermination(ticket);
        if (!result || result.pid !== pid || (result.status === "killed" &&
            (!result.success || result.confirmation !== "handle-signaled" || result.scope !== "single-process")))
            return { success: false, status: "failed", pid, error: "O serviço não devolveu confirmação válida da saída; nenhum sucesso foi declarado." };
        return result;
    }
    finally {
        void api.cancelProcessTermination(ticket).catch(() => { });
    }
}
