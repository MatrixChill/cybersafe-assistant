/**
 * Rotulo HONESTO da politica efetiva de quarentena (P0-3, 15/10). O valor vem
 * do servico em ProtectionStats.quarantinePolicy — lido do disco no arranque
 * (ausente/invalido = "warn"). Sem o campo, a UI diz "desconhecido"; nunca
 * assume OFF nem ON.
 */

export type QuarantinePolicyTone = "off" | "ask" | "auto" | "unknown";

export function quarantinePolicyLabel(policy: unknown): { text: string; tone: QuarantinePolicyTone } {
  switch (policy) {
    case "warn":
      return { text: "Quarentena automática: OFF — nada é isolado sem a tua decisão.", tone: "off" };
    case "ask":
      return { text: "Quarentena automática: OFF — o serviço pede confirmação caso a caso.", tone: "ask" };
    case "automatic-high-confidence":
      return {
        text: "Quarentena automática: LIGADA apenas para casos críticos com hash conhecido e confiança ≥ 99%, sempre restaurável.",
        tone: "auto",
      };
    default:
      return { text: "Quarentena automática: estado desconhecido (o serviço não o reportou).", tone: "unknown" };
  }
}
