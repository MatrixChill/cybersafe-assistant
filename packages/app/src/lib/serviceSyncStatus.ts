/**
 * Distinção que o ciclo de sincronização precisa de fazer e não fazia.
 *
 * O gate de fixture DEV (`packages/service/src/dev-fixture-gate.ts`) recusa tudo
 * o que não seja o conjunto de scan e responde-lhe com `ok:false`; o ServiceClient
 * converte `ok:false` numa **rejeição** (`packages/desktop/src/service-client.ts`)
 * e a rejeição chega ao renderer com o texto do gate. Antes deste helper, o
 * `Promise.all` do `App.tsx` tratava essa rejeição exactamente como uma falha de
 * sincronização: `setProtection(null)` + a banner «Não foi possível sincronizar
 * com o serviço.», numa sessão onde o pipe está ligado e o scan funciona.
 *
 * Uma recusa deliberada não é uma avaria; uma avaria não pode esconder-se atrás
 * de uma recusa. É só isso que aqui se decide — nenhum estado de produto é
 * inventado aqui.
 */

/** Código que o gate escreve em todas as suas recusas (`GATE_CODE` no serviço). */
export const GATE_PREFIXO = "realdev_fixture_gate";

/** Marcador literal, com os dois pontos. Nunca se procura solto no meio do texto. */
const MARCADOR_GATE = `${GATE_PREFIXO}:`;

/**
 * Canais IPC REAIS das sete leituras da snapshot, na grafia canónica do
 * `preload.ts` tal como `main.ts` os regista. Lista CERRADA: um envelope de
 * outro canal — mesmo bem formado — não é uma recusa deste ciclo, porque nenhuma
 * outra rotina tem direito a aparecer neutra aqui.
 */
const CANAIS_DA_SNAPSHOT: ReadonlySet<string> = new Set<string>([
  "service:get-protection-state",
  "service:get-events",
  "service:get-threats",
  "service:get-processes",
  "service:get-connections",
  "service:get-quarantine",
  "service:get-pcstate",
]);

/**
 * Início do envelope que o Electron aplica a uma rejeição de `ipcMain.handle`.
 * Não é suposição: é o template extraído do runtime instalado nesta cópia
 * (`electron@33.4.11`, `dist/electron.exe`),
 * `… if(r) throw new Error(\`Error invoking remote method '${e}': ${r}\`)`.
 * Como `${r}` é a coerção do Error original, o texto do serviço chega PRECEDIDO
 * de `Error: ` — o prefixo do gate nunca está no início da mensagem.
 */
const ENVOLTURA_ELECTRON = "Error invoking remote method '";
/** O que segue o fecho das aspas do canal, antes do marcador. */
const POS_CANAL = ": Error: ";

/**
 * Reconhece o envelope do Electron só quando as três condições se cumpem:
 * (1) a mensagem COMEÇA por ele; (2) o canal entre aspas é um dos sete reais;
 * (3) logo a seguir vem `: Error: realdev_fixture_gate:`. Sem `includes`, sem
 * regex solta, sem despir envolventes genéricos — texto que apenas cite o
 * marcador continua a custar como falha.
 */
function eEnvolventeDoGate(texto: string): boolean {
  if (!texto.startsWith(ENVOLTURA_ELECTRON)) return false;
  const depoisDaAbertura = texto.slice(ENVOLTURA_ELECTRON.length);
  const fecho = depoisDaAbertura.indexOf("'");
  if (fecho <= 0) return false; // sem canal, ou truncado antes do fecho
  if (!CANAIS_DA_SNAPSHOT.has(depoisDaAbertura.slice(0, fecho))) return false;
  return depoisDaAbertura.slice(fecho + 1).startsWith(`${POS_CANAL}${MARCADOR_GATE}`);
}

export type ClassificacaoLeitura = "ok" | "recusa" | "falha";

export type ResultadoLeitura =
  | { status: "fulfilled"; value?: unknown }
  | { status: "rejected"; reason?: unknown };

export function classificarLeitura(resultado: ResultadoLeitura): ClassificacaoLeitura {
  if (resultado.status === "fulfilled") return "ok";
  const reason = resultado.reason;
  const texto = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
  // Dois reconhecimentos, e só dois: o marcador no início (a resposta direta do
  // serviço, o formato que os testes sempre injetaram) e o envelope do Electron
  // ANCORADO no início, com canal conhecido e o `Error: ` da coerção. Um `reason`
  // sem texto utilizável é falha — classificar em silêncio como recusa suprimia
  // um erro real.
  if (texto === "") return "falha";
  return texto.startsWith(MARCADOR_GATE) || eEnvolventeDoGate(texto) ? "recusa" : "falha";
}

export type ResumoSync = {
  ok: number;
  recusas: number;
  falhas: number;
  /**
   * A bandeira de falha de sincronização só se levanta com uma falha REAL. Com
   * apenas recusas do gate não houve nenhuma avaria para reportar.
   */
  deveMarcarFalhaSync: boolean;
  /** Houve pelo menos uma leitura com conteúdo para mostrar. */
  temLeituraUtil: boolean;
};

export function resumoSync(classificacoes: readonly ClassificacaoLeitura[]): ResumoSync {
  const ok = classificacoes.filter((c) => c === "ok").length;
  const recusas = classificacoes.filter((c) => c === "recusa").length;
  const falhas = classificacoes.filter((c) => c === "falha").length;
  return {
    ok,
    recusas,
    falhas,
    deveMarcarFalhaSync: falhas > 0,
    temLeituraUtil: ok > 0,
  };
}
