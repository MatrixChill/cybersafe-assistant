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
 *  - anuncia uma transição real (disponível → indisponível) OU uma mudança de
 *    motivo/estado enquanto o motor continua indisponível (ex.: degraded →
 *    unavailable): uma degradação mais grave não fica escondida à espera de
 *    uma recuperação que pode não acontecer;
 *  - a MESMA fingerprint não repete dentro de `cooldownMs`, nem volta a
 *    anunciar-se enquanto o estado não mudar;
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
  // Arranque sem leitura prévia: não se anuncia uma queda que não foi observada.
  if (!previous) return false;
  const key = engineUnavailableKey(next);
  const last = lastPublished;
  if (last && last.key === key && Number.isFinite(last.at) && now - last.at < cooldownMs) return false;
  // Transição real (disponível → indisponível).
  if (previous.available) return true;
  // Continua indisponível, mas por um motivo/estado DIFERENTE: mudança relevante.
  return engineUnavailableKey(previous) !== key;
}
