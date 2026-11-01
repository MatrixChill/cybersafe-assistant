/**
 * HARNESS PARTILHADO — POSITIVO DE CONTROLO EICAR EM MEMÓRIA vs. ANTIVÍRUS DA MÁQUINA.
 *
 * ── O problema medido (2026-11-01, esta máquina) ───────────────────────────
 * `createYaraClassicScanner().scanBuffer(buffer)` escreve o buffer em
 * `%TEMP%\cybersafe-yara-buffer-<rand>\target.bin` e corre
 * `yara64.exe -w -N -a <secs> <regras> <alvo>`. Com o positivo de controlo
 * EICAR o subprocesso recebe `exit 1` e escreve em stderr:
 *
 *     error scanning <...>\target.bin: could not open file
 *
 * Medido com o binário vendorizado (4.6.0) e o canário do produto:
 *   - o MESMO comando com um buffer BENIGNO devolve `exit 0`, stdout e stderr
 *     vazios → a forma dos argumentos, o binário e as regras estão bem;
 *   - com o conteúdo EICAR a abertura é negada AO PROCESSO FILHO. O Node ainda
 *     descreve o ficheiro. É o antivírus da máquina a bloquear a leitura do
 *     conteúdo de teste, não um defeito do CyberSafe e não uma quarentena do
 *     ficheiro.
 * O produto já cai fechado: `scanBuffer` lança e `YaraEngine.match` re-lança
 * "YARA could not scan the buffer" — nada é reportado como limpo.
 *
 * ── O que este harness NÃO faz ─────────────────────────────────────────────
 * Não adiciona exclusões de antivírus, não mexe em definições do Windows e não
 * transforma um defeito real em `pass`. Saltar é permitido SÓ depois de medir
 * as duas coisas em simultâneo:
 *   1. o erro do scan do alvo com conteúdo EICAR traz `could not open file`
 *      PARA O ALVO do buffer (não para as regras, não um prazo, não um sinal);
 *   2. o MESMO motor ainda consegue scanear um buffer benigno — prova de que o
 *      caminho regra→match funciona. Sem esta prova o erro propaga-se e o
 *      teste continua a FAILAR, porque aí a hipótese "é o antivírus" não está
 *      sustentada por nada.
 * Quando as duas condições se verificam, o teste é marcado SKIP com um motivo
 * que nomeia a causa e cita o stderr medido. SKIP não é PASS: a asserção do
 * positivo não foi executada nesta máquina, e numa máquina sem interferência o
 * mesmo teste executa a asserção normalmente.
 */

/** Assinatura do yara para um ALVO que ele não consegue abrir (stderr medido). */
const TARGET_DENIED = /error scanning\s+.*?:\s*could not open file/i;

/** O alvo é o ficheiro do buffer em memória, nunca um ficheiro do utilizador. */
const BUFFER_TARGET = /(?:cybersafe-yara-buffer|target\.bin)/i;

/** Buffer benigno: prova que o motor e o subprocesso funcionam; não é malware. */
export const BENIGN_PROBE_BUFFER = Buffer.from(
  "CYBERSAFE-AV-DENIAL-HARNESS-BENIGN-CONTROL-NOT-MALWARE",
  "ascii",
);

const MAX_REASON_CHARS = 400;

/** Mensagens de toda a cadeia de `cause` — `YaraEngine.match` embrulha o erro. */
export function yaraErrorChain(error) {
  const messages = [];
  let current = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    messages.push(String(current?.message ?? current));
    current = typeof current === "object" && current.cause ? current.cause : undefined;
  }
  return messages;
}

/**
 * O erro é MEDIDAMENTE "o yara não conseguiu abrir o alvo do buffer"?
 * Não confunde com `error: could not open file: <regras>` (ficheiro de regras),
 * com prazos (`SIGKILL`/`prazo`), com `output-limit` nem com o scanner indisponível.
 */
export function isYaraBufferTargetDenied(error) {
  return yaraErrorChain(error).some(
    (message) => TARGET_DENIED.test(message) && BUFFER_TARGET.test(message),
  );
}

/** O texto do próprio erro que sustenta o skip, aparado para caber no motivo. */
export function yaraDenialDetail(error) {
  const measured = yaraErrorChain(error).find((message) => TARGET_DENIED.test(message)) ?? "";
  const match = TARGET_DENIED.exec(measured);
  return (match ? match[0] : measured).replace(/\s+/g, " ").trim().slice(0, MAX_REASON_CHARS);
}

/** Motivo do SKIP: nomeia a causa, o que foi provado e o que NÃO foi executado. */
export function avDenialSkipReason(error) {
  return (
    "SKIP (ambiente, não produto): o antivírus da máquina negou ao yara64.exe a " +
    "leitura do alvo temporário do buffer com conteúdo de teste " +
    `[${yaraDenialDetail(error)}]. O mesmo motor avaliou um buffer benigno, ` +
    "portanto o caminho regra→match está funcional; a asserção do positivo de " +
    "controlo EICAR NÃO foi executada e nada foi avaliado como limpo. Numa " +
    "máquina sem esta interferência a asserção corre normalmente."
  );
}

/**
 * `engine.match(buffer)` com a única tolerância permitida: se e só se a
 * falha for a negação de leitura do alvo pelo antivírus DA MÁQUINA, provada
 * contra um scan benigno funcional no mesmo motor, o teste é marcado SKIP e é
 * devolvido `null`. Qualquer outra falha propaga-se sem alteração.
 *
 * @param {{ skip: (message: string) => void }} t contexto do `node:test`
 * @param {{ match: (buffer: Buffer) => unknown[] }} engine motor YARA do produto
 * @param {Buffer} buffer positivo de controlo (conteúdo de teste)
 * @returns {unknown[] | null} os matches, ou `null` quando o teste foi saltado
 */
export function positiveControlMatchOrSkip(t, engine, buffer) {
  let matches;
  let denial;
  try {
    matches = engine.match(buffer);
  } catch (error) {
    if (!isYaraBufferTargetDenied(error)) throw error;
    denial = error;
  }
  if (!denial) return matches;

  // A hipótese só se sustenta se o pipeline estiver vivo nesta máquina AGORA.
  // Um scan benigno que também falhe não é interferência específica do EICAR:
  // é o motor/binário avariado e tem de continuar a dar FAIL.
  try {
    engine.match(BENIGN_PROBE_BUFFER);
  } catch (benignError) {
    throw new Error(
      "YARA não consegue scanear nem o buffer benigno do harness; a falha do " +
        "positivo de controlo não pode ser atribuída ao antivírus da máquina.",
      { cause: { denial, benignError } },
    );
  }

  t.skip(avDenialSkipReason(denial));
  return null;
}
