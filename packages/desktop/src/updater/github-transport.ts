import { TransportError, type HttpStreamOpener } from "./node-transport.ts";

// Fixed repository, no credentials forwarded. Metadata authentication remains
// mandatory after transport; GitHub hosting alone is not a trust anchor.
export function isGitHubReleaseUrl(value: string, redirected = false): boolean {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password || u.port || u.hash) return false;
    if (u.hostname === "github.com") {
      return /^\/MatrixChill\/cybersafe-assistant\/releases\/(?:download\/[^/]+\/[^/]+|latest\/download\/[^/]+)$/.test(u.pathname)
        && !u.search && !/%2f|%5c/i.test(u.pathname);
    }
    return redirected && u.hostname === "release-assets.githubusercontent.com"
      && u.pathname.startsWith("/github-production-release-asset/");
  } catch { return false; }
}

/** Bounded redirects only for this release repository and its asset CDN. */
export function createGitHubReleaseOpener(inner: HttpStreamOpener): HttpStreamOpener {
  return {
    async open(initial, signal) {
      let current = initial;
      for (let hop = 0; hop <= 3; hop++) {
        if (signal.aborted) throw new TransportError("aborted", "pedido cancelado");
        if (!isGitHubReleaseUrl(current, hop > 0)) throw new TransportError("redirect", "destino de release não autorizado");
        const response = await inner.open(current, signal);
        if (response.status < 300 || response.status >= 400) return response;
        const location = response.headers.location;
        response.abort();
        if (![301, 302, 303, 307, 308].includes(response.status) || !location || hop === 3) {
          throw new TransportError("redirect", "redirecionamento inválido ou excessivo");
        }
        try { current = new URL(location, current).href; }
        catch { throw new TransportError("redirect", "destino inválido"); }
      }
      throw new TransportError("redirect", "limite de redirecionamentos");
    },
  };
}
