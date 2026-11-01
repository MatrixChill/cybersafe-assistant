/**
 * HARNESS PARTILHADO DA PROVA POSITIVA DE CARGA (`scanId: "load-proof"`).
 *
 * Desde o commit 3a95692 o `active` do ClamAV NUNCA vem de "existência + mtime"
 * da base: `probe()` exige uma corrida benigna e controlada (`runLoadProof`)
 * que (a) adquire a MESMA vaga global dos scans, (b) pede a MESMA lease da base
 * com a chave `"load-proof"` e (c) spawna pelo MESMO seam injectado, com
 * `{ scanId: "load-proof" }`.
 *
 * Consequência para os testes: um `options.spawn` que não conheça a prova vê um
 * SEGUNDO filho e uma LEASE A MAIS, e as invariantes que estes ficheiros
 * protegem (1 spawn por batch, pico de concorrência 1, lease presa até morte
 * confirmada) passam a contar o trabalho da prova em vez do scan.
 *
 * Este módulo não desliga a prova — `loadProofEnabled: false` esconderia o
 * contrato e tornaria o `active` inatingível. Em vez disso ensina o harness a
 * RESPONDER-LHE de forma coerente (exit 0, resumo completo, morte confirmada) e
 * a NÃO a registar nas suas contagens. O resumo é o mesmo das suites que já
 * afirmam a prova a passar (`clamav-load-proof-rev4`, `clamav-load-proof-modes`),
 * validado por `clamavLoadConfirmed`.
 */

export const LOAD_PROOF_SCAN_ID = "load-proof";
export const LOAD_PROOF_LEASE_KEY = "load-proof";

/** stdout que `clamavLoadConfirmed` aceita: cabeçalho + resumo completo, zero infecções. */
export const LOAD_PROOF_SUMMARY =
  "----------- SCAN SUMMARY -----------\nKnown viruses: 3628193\nEngine version: 1.5.4\nScanned files: 1\nInfected files: 0\n";

/** O pedido de spawn é a prova de carga? (a ponte passa `scanId: "load-proof"`). */
export function isLoadProof(request) {
  return (request && request.scanId === LOAD_PROOF_SCAN_ID) === true;
}

/**
 * Handle SINTEÉTICA e invisível para a prova de carga.
 *
 * Resolve o `outcome` de imediato com morte CONFIRMADA (sem `deathUnconfirmed`)
 * e um resultado limpo — por isso a vaga é libertada (nunca envenenada) e a
 * lease sai no `finally`, como num scan que acabou bem.
 *
 * `pid` fica por definir DE PROPÓSITO: o registo em `liveChildPids()` /
 * `trackClamavPid` é guardado por `typeof pid === "number"`, e assim as suites
 * que amostram os PIDs filhos ou esperam pelo registo do filho do batch veem
 * apenas o filho real. `killTree()` é um no-op porque o `outcome` já resolveu.
 */
export function makeLoadProofHandle({
  code = 0,
  stdout = LOAD_PROOF_SUMMARY,
  stderr = "",
  deathUnconfirmed = false,
} = {}) {
  const handle = {
    killTree() {},
    onDeathConfirmed(_fn) {},
    outcome: Promise.resolve({
      code,
      stdout,
      stderr,
      timedOut: false,
      killed: false,
      deathUnconfirmed,
    }),
  };
  return handle;
}

/** Lease da prova: aceite e libertada, sem aparecer nos contadores do teste. */
export function makeLoadProofLease() {
  return { release() {}, released: false };
}

/**
 * Envolve um `acquireDatabaseLease` de teste: o pedido `"load-proof"` recebe uma
 * lease própria e os pedidos reais vão ao harness do teste, que continua a
 * contar adquireções/libertações de scans exatamente como antes.
 */
export function withLoadProofLease(acquire) {
  return (key) => (key === LOAD_PROOF_LEASE_KEY ? makeLoadProofLease() : acquire(key));
}
