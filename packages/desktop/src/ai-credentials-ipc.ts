import { MECANISMO_INDETERMINADO, mecanismoPermiteCifra } from "./mecanismo-credenciais.js";
import { RecusaArmazenamento, type AiCredentialsStore } from "./ai-credentials-store.js";

type ModoEscrita = "cifra" | "local-protegido" | "limpar";

/** Caller must provide Main's trusted-frame + read-only-policy wrapper. */
export function registerAiCredentialsIpc(
  handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => unknown,
  createStore: () => AiCredentialsStore,
  configure: (store: AiCredentialsStore) => Promise<boolean>,
): void {
  let store: AiCredentialsStore | undefined;
  let busy = false;
  const current = () => (store ??= createStore());
  handle("ai-credentials:get-status", () => {
    try {
      return { ...current().estado(), state: "unverified" };
    } catch {
      // Sem leitura possível continuamos a dizer que não há chave; o mecanismo
      // fica «por confirmar» em vez de afirmar uma cifra que não verificámos.
      return { hasKey: false, provider: "groq", origem: null, mecanismo: MECANISMO_INDETERMINADO, state: "unavailable" };
    }
  });
  const change = async (modo: ModoEscrita, key?: unknown, provider?: unknown, consentido?: unknown) => {
    if (busy) return { ok: false, error: "A configuração anterior ainda está em curso." };
    busy = true;
    try {
      const atual = current();
      if (modo === "limpar") atual.clear();
      else if (modo === "local-protegido") atual.writeKeyLocalProtegido(key, provider, consentido);
      else atual.writeKey(key, provider);
      const applied = await configure(atual);
      return {
        ...atual.estado(),
        ok: true,
        applied,
        state: applied ? "configured" : "pending-api",
      };
    } catch (error) {
      if (error instanceof RecusaArmazenamento) {
        // Nomear o motivo real é o que permite ao ecrã dizer «sem mecanismo
        // seguro» em vez de uma falha genérica — sem nunca ecoar a chave.
        return { ...current().estado(), ok: false, error: error.message, codigo: error.codigo };
      }
      return { ...current().estado(), ok: false, error: "Não foi possível atualizar a configuração protegida da IA." };
    } finally {
      busy = false;
    }
  };
  handle("ai-credentials:save", (_event, key, provider, consentido) =>
    // O consentimento só escolhe o destino quando não há cifra verificada; com
    // mecanismo seguro a chave vai sempre para o ficheiro cifrado.
    change(
      consentido === true && !mecanismoPermiteCifra(current().estado().mecanismo) ? "local-protegido" : "cifra",
      key,
      provider,
      consentido,
    ));
  handle("ai-credentials:clear", () => change("limpar"));
}
