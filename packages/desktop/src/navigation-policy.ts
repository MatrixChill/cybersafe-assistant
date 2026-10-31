export const PRODUCTION_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'";

interface NavigationContents {
  on(event: "will-navigate" | "will-redirect", listener: (event: { preventDefault(): void }, url: string) => void): unknown;
  setWindowOpenHandler(handler: () => { action: "deny" }): void;
}

/** Navigation is document-exact, matching the IPC trust boundary. No shell launch. */
export function installNavigationPolicy(contents: NavigationContents, expectedUrl: () => string): void {
  const guard = (event: { preventDefault(): void }, target: string) => {
    let allowed = false;
    try {
      const actual = new URL(target);
      const expected = new URL(expectedUrl());
      actual.hash = "";
      expected.hash = "";
      allowed = actual.href === expected.href;
    } catch { /* Invalid URLs never authorise navigation. */ }
    if (!allowed) event.preventDefault();
  };
  contents.on("will-navigate", guard);
  contents.on("will-redirect", guard);
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
}
