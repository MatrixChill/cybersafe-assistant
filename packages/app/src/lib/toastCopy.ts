/**
 * Rotulo pt-PT do TIPO de evento nos toasts.
 *
 * Isto nao e traducao de copy: o service publica `type` como chave tecnica de
 * evento (`threat.detected`, `process.blocked`) e nao envia nenhum rotulo
 * legivel nesse campo. Traduzir a chave e outra coisa — e o que este ficheiro
 * faz. O texto do summary, esse, o service ja manda em PT-PT (engine.ts:652,
 * :758, :1114) e a UI mostra-o tal e qual.
 *
 * ── Porque nao ha traducao de summary aqui ────────────────────────────────
 * Houve um `translateToastSummary` com tres padroes em ingles. O service deixou
 * de emitir english, o `service-copy.test.js` passou a PROIBIR que voltasse, e
 * o padrao ficou a traduzir uma cadeia que nao existe: codigo morto que
 * prometia uma garantia que ninguem verificava.
 *
 * A garantia que importa passou a estar em `test/toast-engine-contract.test.ts`:
 * ele le o `engine.ts` real e falha se algum summary voltar a precisar de
 * traducao. Se um dia isso acontecer, a correcao e no service — publicar PT-PT —
 * e nao numa tabela da UI. Duas copies da mesma frase divergem; uma so nao.
 *
 * `TYPE_LABELS` mantem-se porque mapeia identificadores, nao texto.
 */

const TYPE_LABELS: Record<string, string> = {
  "threat.detected": "Ameaça detetada",
  "process.blocked": "Processo bloqueado",
};

/**
 * Um tipo desconhecido devolve a chave, nunca um rotulo inventado. Um evento
 * que a UI nao conhece mostra `weird.event`, que e honesto; "Ameaça" seria uma
 * affirmacao sobre um evento que ela nao conhece.
 */
export function toastTypeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}