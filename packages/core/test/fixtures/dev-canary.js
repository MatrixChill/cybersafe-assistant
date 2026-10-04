/**
 * Fixture de TESTE do canario dev.
 *
 * Este e o unico lugar em packages/core onde o literal pode viver. O src de
 * producao (packages/core/src) mantem apenas a deteccao por hash, que nao
 * contem a assinatura, para que uma build empacotada do CyberSafe nunca
 * possa sinalizar o proprio bundle. As pastas test/ nao entram no app.asar.
 */
import { setDevCanaryContent } from "../../dist/index.js";

export const DEV_CANARY_CONTENT = "CYBERSAFE-E2E-TEST-SIGNATURE-v1";

/** Regista o conteudo para que a deteccao por conteudo funcione nos testes. */
export function installDevCanary() {
  setDevCanaryContent(DEV_CANARY_CONTENT);
}
