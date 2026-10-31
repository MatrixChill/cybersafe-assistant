/** Shared authenticated bearer accessor. Never persist a password or a bearer
 * in browser localStorage. Desktop persistence is encrypted in the main process.
 */
const LEGACY_KEY = "cybersafe_token";
const LOGGED_OUT = "cybersafe_auth_logged_out";
let token: string | null = null;
let generation = 0;
type Bridge = { read(): Promise<string | null>; write(token: string, remember: boolean): Promise<void>; clear(): Promise<void> };
function bridge(): Bridge | undefined {
  return typeof window === "undefined" ? undefined : window.electronAPI?.authSession;
}
export function getAuthToken(): string | null { return token; }
/** Expiry is only used to drop local identity, never to grant access. */
export function authTokenExpiresAt(value = token): number | null {
  try {
    if (!value) return null;
    const encoded = value.split(".")[1].replaceAll("-", "+").replaceAll("_", "/");
    const { exp } = JSON.parse(atob(encoded));
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
  } catch { return null; }
}
export async function restoreAuthSession(): Promise<string | null> {
  const current = ++generation;
  token = null;
  if (localStorage.getItem(LOGGED_OUT) === "1") {
    try { localStorage.removeItem(LEGACY_KEY); } finally { await bridge()?.clear(); }
    return null;
  }
  const legacy = localStorage.getItem(LEGACY_KEY);
  localStorage.removeItem(LEGACY_KEY);
  // Existing accounts remain valid; legacy bearers get no new persistence
  // without explicit consent. /auth/me must validate them before access.
  const restored = await bridge()?.read() ?? legacy ?? null;
  if (current !== generation) return null;
  token = restored;
  return token;
}
export async function saveAuthSession(next: string, remember: boolean): Promise<void> {
  if (!next || typeof next !== "string") throw new Error("Sessão inválida.");
  const current = ++generation;
  const store = bridge();
  if (remember && !store) throw new Error("Lembrar-me requer o armazenamento seguro da aplicação desktop.");
  await store?.write(next, remember);
  if (current !== generation) return;
  token = next;
  localStorage.removeItem(LEGACY_KEY);
  localStorage.removeItem(LOGGED_OUT);
}
export async function clearAuthSession(): Promise<void> {
  ++generation;
  token = null;
  // Nonsecret, synchronous logout marker also protects against a crash before
  // the main process receives the request to remove the encrypted bearer.
  try {
    localStorage.setItem(LOGGED_OUT, "1");
    localStorage.removeItem(LEGACY_KEY);
  } finally { await bridge()?.clear(); }
}
