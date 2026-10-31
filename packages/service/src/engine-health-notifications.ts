/**
 * Quando é que uma indisponibilidade de motor merece uma notificação?
 *
 * Evidência humana (R6): os motores alternaram entre `active` e `degraded` e as
 * notificações repetiram-se. O `getProtectionState` publicava sempre que a
 * disponibilidade passava a `false`, sem histerese — um probe a repetir gerava
 * uma notificação por oscilação.
 *
 * O tecto é por MOTIVO (`engine` + `status`), não por motor: uma
 * indisponibilidade diferente ou mais grave depois de uma recuperação continua a
 * ser anunciada; o que se corta é repetir exactamente a mesma transição dentro
 * da janela de arrefecimento.
 *
 * Regras:
 *  - só uma transição real (antes disponível → agora indisponível) anuncia;
 *  - a MESMA fingerprint não repete dentro de `cooldownMs`;
 *  - voltar a estar disponível nunca gera notificação de indisponibilidade.
 */
export interface EngineHealthSnapshot {
  engine: string;
  available: boolean;
  status: string;
}

export interface EngineUnavailableNotice {
  key: string;
  at: number;
}

export const ENGINE_UNAVAILABLE_NOTIFY_COOLDOWN_MS = 10 * 60_000;

export function engineUnavailableKey(snapshot: EngineHealthSnapshot): string {
  return `${snapshot.engine}:${snapshot.status}`;
}

export function shouldPublishEngineUnavailable(
  previous: EngineHealthSnapshot | null,
  next: EngineHealthSnapshot,
  now: number,
  lastPublished: EngineUnavailableNotice | undefined,
  cooldownMs: number = ENGINE_UNAVAILABLE_NOTIFY_COOLDOWN_MS,
): boolean {
  if (next.available) return false;
  if (!previous || previous.available !== true) return false;
  const key = engineUnavailableKey(next);
  if (lastPublished && lastPublished.key === key && Number.isFinite(lastPublished.at) && now - lastPublished.at < cooldownMs) {
    return false;
  }
  return true;
}
