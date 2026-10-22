/**
 * Fonte unica de resolucao de paths para assets estaticos servidos de
 * `packages/app/public/**`.
 *
 * Porque existe:
 *   `packages/app/vite.config.ts` usa `base: './'`, obrigatorio porque o shell
 *   Electron carrega o renderer com `loadFile(dist/index.html)` em `file://`.
 *   Um caminho de corda absoluto ("/branding/...") funciona no dev server
 *   (http://localhost:5173/branding/...) mas em `file://` e resolvido contra a
 *   RAIZ DO SISTEMA (file:///branding/...), que nao existe — o asset falha nos
 *   dois temas, so no .exe. E pre-existente a esta correccao.
 *
 * Como funciona:
 *   Resolve sempre contra a base real do documento (`document.baseURI`), que e
 *   o que o browser ja sabe sobre onde a pagina vive:
 *     dev       baseURI = http://localhost:5173/          -> .../branding/...
 *     staged    baseURI = file:///.../desktop/dist/index.html
 *               -> file:///.../desktop/dist/branding/...
 *   O chamador passa apenas segmentos relativos, sem barra inicial. Nao ha
 *   deteccao de contexto nem try/catch por componente: a regra vive aqui.
 */
export function publicAssetUrl(...segments: string[]): string {
  const relative = segments.join("/");
  if (typeof document !== "undefined" && document.baseURI) {
    return new URL(relative, document.baseURI).href;
  }
  return relative;
}
