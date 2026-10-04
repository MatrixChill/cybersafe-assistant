/**
 * Fixture de TESTE do canario dev.
 *
 * O literal vive aqui e nos testes, nunca em src de producao. Esta fixture e
 * importada pelos testes do servico para escrever o ficheiro canario e para
 * registar o conteudo no core, de modo a que a deteccao por conteudo
 * funcione igual a antes. Em runtime empacotado nada regista o conteudo e o
 * detector fica inerte.
 */
import { setDevCanaryContent } from "@cybersafe/core";

export const DEV_CANARY_CONTENT = "CYBERSAFE-E2E-TEST-SIGNATURE-v1";

/** Regista o conteudo no core para que a deteccao por conteudo funcione. */
export function installDevCanary() {
  setDevCanaryContent(DEV_CANARY_CONTENT);
}
