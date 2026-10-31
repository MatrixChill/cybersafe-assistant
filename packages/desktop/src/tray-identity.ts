/**
 * TP-OBJ-TRAY-IDENTITY — identidade inequívoca do run DEV (candidato, staging).
 *
 * Objectivo: quando corre uma instância DEV isolada (perfil verificado), o
 * tooltip da bandeja tem de dizer **qual** instância é, para não se confundir
 * com a instalação de produção (que tem outro PID, outra raiz e outro pipe).
 *
 * Regras (puras, sem Electron, sem IPC, sem infra nova):
 *  - empacotado (`isPackaged`) => sufixo VAZIO: o tooltip do produto fica
 *    exactamente como está;
 *  - dev normal (perfil NÃO isolado/verificado) => sufixo VAZIO: também
 *    fica igual;
 *  - dev isolado + PID válido => sufixo " — DEV PID <pid>".
 *
 * O PID identifica a instância sem expor caminhos, tokens, roots de perfil ou
 * qualquer segredo: só o número do processo.
 */

/** Entradas do cálculo. `devIsolated` vem do perfil verificado (ver main.ts). */
export type TrayIdentityInput = {
  /** `app.isPackaged`: true = instalação de produção. */
  isPackaged: boolean;
  /** O perfil DEV está isolado e verificado (base/pipe próprios). */
  devIsolated: boolean;
  /** PID do processo da app (para distinguir instâncias). */
  pid?: number;
};

/** Sufixo a juntar ao tooltip. String vazia = tooltip inalterado. */
export function devTrayIdentitySuffix(input: TrayIdentityInput): string {
  if (input.isPackaged) return "";
  if (!input.devIsolated) return "";
  const pid = input.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return "";
  return ` — DEV PID ${pid}`;
}

/** Atalho: o tooltip completo, já com a identidade quando aplicável. */
export function trayTooltipWithIdentity(tooltip: string, input: TrayIdentityInput): string {
  return `${tooltip}${devTrayIdentitySuffix(input)}`;
}
