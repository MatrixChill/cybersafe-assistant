// ── Onboarding — estado de "boas-vindas já vistas" ──
// Persistido localmente: só aparece na primeira utilização e pode ser reaberto.

const ONBOARDING_DONE_KEY = "cybersafe.onboarding.v1";

export function hasSeenOnboarding(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_DONE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markOnboardingSeen(): void {
  try {
    localStorage.setItem(ONBOARDING_DONE_KEY, "1");
  } catch {
    /* storage indisponível não deve bloquear a app */
  }
}

export function resetOnboardingSeen(): void {
  try {
    localStorage.removeItem(ONBOARDING_DONE_KEY);
  } catch {
    /* noop */
  }
}