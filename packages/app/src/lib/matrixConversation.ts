import {
  estadoDoPedido,
  matrixStateLabel,
  origemDoEstado,
  type MatrixRequestState,
} from "./matrixRequestMachine";

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  privateProcessData?: boolean;
  /**
   * De onde VEIO esta resposta. `"ai"` só quando o pedido ao fornecedor foi
   * feito E devolveu conteúdo concluído; `"local"` para tudo o resto, incluindo
   * erro, 429, indisponibilidade e cooldown. Deliberadamente NÃO é derivado de
   * `mode`/`/api/ai/status`: a configuração diz o que está ligado, não o que
   * respondeu a esta mensagem. Ausente = sem resposta (saudação, mensagem do
   * utilizador) e por isso sem etiqueta.
   */
  origin?: MatrixAnswerOrigin;
  /**
   * O QUE aconteceu ao pedido, dos sete estados distinguiveis. Eixo separado de
   * `origin`: `origin` diz de onde o texto veio; `state` diz o que passou — e sem
   * ele «local» servia para «não autorizaste», «o fornecedor caiu» e «a máquina
   * respondia primeiro», que são três coisas que a pessoa trata de três maneiras.
   */
  state?: MatrixRequestState;
}

export type MatrixAnswerOrigin = "local" | "ai";

/**
 * Escolha VISÍVEL do painel: «Local» responde no PC e não contacta o fornecedor;
 * «Online» permite que perguntas gerais vão ao fornecedor. É intenção do
 * utilizador, não disponibilidade do fornecedor — essa continua noutro eixo
 * (`matrixConfigLabel`), e a origem de cada resposta é provada pelo resultado.
 */
export type MatrixChatMode = "local" | "online";

export function matrixChatModeLabel(mode: MatrixChatMode): string {
  return mode === "online" ? "Online" : "Local";
}

/** Texto PT-PT do que cada escolha faz — sem prometer o que o gate não deixa. */
export function matrixChatModeDescription(mode: MatrixChatMode): string {
  return mode === "online"
    ? "Perguntas gerais podem ir ao fornecedor de IA. As medições de processos continuam a exigir autorização."
    : "Respostas construídas no PC, sem enviar nada ao fornecedor de IA.";
}

/**
 * Não há resposta pronta no conhecimento local. A frase tem de distinguir a
 * ESCOLHA «Local» de uma indisponibilidade real: dizer «a ligação ao fornecedor
 * não está disponível» a quem escolheu não enviar era uma desculpa falsa.
 */
export function respostaSemConhecimentoLocal(mode: MatrixChatMode, dica?: string | null): string {
  const sugestao = dica || "por exemplo, o que é phishing ou como criar palavras-passe fortes.";
  if (mode === "local") {
    return `Estou em **modo Local** por escolha tua: não envio esta pergunta ao fornecedor de IA. Não tenho uma resposta pronta para isso — podes mudar para **Online** para tentar a IA, ou fica na segurança — ${sugestao}`;
  }
  return `Estou em **modo local** (a ligação ao fornecedor de IA não está disponível), então notei que não tenho uma resposta pronta para isso. Posso tentar de novo, ou foca-te na segurança — ${sugestao}`;
}

/**
 * Os sete estados do pedido vivem em `matrixRequestMachine.ts` e são reexportados
 * daqui para quem trata de mensagens. Uma única lista, uma única origem de verdade:
 * haver dois vocabulários de estado era como começar a divergir entre eles.
 */
export type { MatrixRequestState };

/** Rotulo PT-PT do estado. Nunca nomeia fornecedor nem caminhos. */
export function matrixRoutingStateLabel(estado?: MatrixRequestState | null): string | null {
  return matrixStateLabel(estado ?? null);
}

/** O estado de um motivo de intercepção local (ainda sem ida ao fornecedor). */
export function estadoDoMotivoLocal(motivo: string | null): MatrixRequestState {
  return estadoDoPedido({ motivo, pediuProvider: false });
}

/**
 * Estado FINAL do pedido. Quando já havia motivo local, é esse motivo: um
 * fornecedor que pudesse responder não muda o facto de faltar autorização. O resto
 * é decidido na maquina, que é tambem o sitio onde «resposta da IA» se define — a
 * origem passa a ser derivada daqui, e nao uma segunda conta do mesmo facto.
 */
export function estadoDoResultado(i: {
  motivo: string | null;
  pediuProvider: boolean;
  ok?: boolean;
  content?: string;
  code?: string;
  emCooldown?: boolean;
}): MatrixRequestState {
  return estadoDoPedido({ motivo: i.motivo, pediuProvider: i.pediuProvider, ok: i.ok, conteudo: i.content, code: i.code, emCooldown: i.emCooldown });
}

/**
 * O pedido de explicação só se segura para autorizar QUANDO autorizar muda o
 * resultado. Nos outros casos enviar (ou prometer um reenvio) seria mentira:
 *  - `identidade-perdida`: a instância já não existe, autorização nenhuma a traz;
 *  - sem `temContextoProcesso`: não há medições para autorizar, a resposta é
 *    local por falta de dados e continuar-ia local depois de marcar a caixa;
 *  - pergunta que não é de processo: não leva medições, não precisa de gate.
 *
 * Mantém-se deliberadamente a PRÓXIMA da mesma condição de
 * `motivoDoEncaminhamentoLocal` — uma segunda definição de «quando é que o
 * processo fica em casa» é onde as duas começariam a divergir.
 */
export function devePedirAutorizacaoAntes(i: {
  perguntaProcesso: boolean;
  temContextoProcesso: boolean;
  consentimentoEfectivo: boolean;
  identidadePerdida: boolean;
}): boolean {
  if (i.identidadePerdida) return false;
  return i.perguntaProcesso && i.temContextoProcesso && !i.consentimentoEfectivo;
}

/** Rótulo PT-PT, discreto. Nunca nomeia fornecedor nem caminhos. */
export function matrixOriginLabel(origin?: MatrixAnswerOrigin): string | null {
  if (origin === "ai") return "IA online";
  if (origin === "local") return "Diagnóstico local";
  return null;
}

/**
 * Origem declarada apenas pelo resultado real do pedido. `ok` sem conteúdo
 * concluído não é «IA»: um stream que abriu e não terminou respondeu localmente
 * ao utilizador, por muito «online» que o painel pareça.
 */
export function originDaResposta(r: {
  pediuProvider: boolean;
  ok?: boolean;
  content?: string;
  /** `rate_limited`, `no_provider`, `auth`, `model_unavailable` — registrado só para leitura; a decisão é `ok`+conteúdo. */
  code?: string;
}): MatrixAnswerOrigin {
  if (!r.pediuProvider) return "local";
  // Uma so definicao do que conta «resposta da IA»: a maquina de estado. «ia» é
  // o estado `generativa`, tudo o resto é local — os dois deixam de poder
  // discordar porque um passou a derivar do outro.
  return origemDoEstado(estadoDoPedido({ motivo: null, pediuProvider: r.pediuProvider, ok: r.ok, conteudo: r.content, code: r.code })) === "provider" ? "ai" : "local";
}

/** Tudo o que decide o destino de uma mensagem, sem estado e sem rede. */
export type MatrixRotaInput = {
  texto: string;
  perguntaProcesso: boolean;
  perguntaSegurancaLocal: boolean;
  identidadePerdida: boolean;
  perigo: boolean;
  foraDoTema: boolean;
  consentimentoProcesso: boolean;
  temContextoProcesso: boolean;
  /** Cooldown após falha do fornecedor: não se martela o provider. */
  modoLocal: boolean;
  /** Escolha explícita «Local»: nenhum pedido vai ao fornecedor neste turno. */
  modoConversaLocal?: boolean;
};

/**
 * Para onde vai a pergunta, decidido ANTES de qualquer chamada — a ordem é a do
 * componente (identidade → privacidade de processo → estado do PC → segurança →
 * cooldown), porque cada uma destas respostas é construída com dados que já estão
 * na máquina e não precisam do fornecedor.
 *
 * Único caso em que «local» é PRIORIDADE e não garantia: a pergunta de estado do
 * PC usa o snapshot real do serviço e só existe resposta se ele for recente. Sem
 * snapshot, o componente segue para o fornecedor — uma pergunta sem resposta local
 * não pode ser respondida com ausência de notícias.
 */
export function destinoDaMensagem(i: MatrixRotaInput): "local" | "provider" {
  return motivoDoEncaminhamentoLocal(i) === null ? "provider" : "local";
}

/** `null` = pode ir ao provider. Caso contrário, o motivo estável (sem valores). */
export function motivoDoEncaminhamentoLocal(i: MatrixRotaInput): string | null {
  if (i.identidadePerdida) return "identidade-perdida";
  // O estado do PC tenta primeiro o snapshot local; se ele faltar, a decisão
  // volta a esta matriz e o modo escolhido impede o fornecedor. Pôr o modo à
  // frente disto respondia «local» genérico a uma pergunta que tinha leitura real.
  if (i.perguntaSegurancaLocal) return "seguranca-local";
  // Escolha explícita do utilizador: precede o gate de consentimento porque não
  // há envio nenhum a autorizar. Pedir uma autorização que não vai ser usada era
  // a contradição entre a caixa e o modo que este lote fecha.
  if (i.modoConversaLocal === true) return "modo-local-escolhido";
  if (i.perguntaProcesso && (!i.consentimentoProcesso || !i.temContextoProcesso)) return "sem-consentimento";
  if (i.perigo) return "perigo";
  if (i.foraDoTema) return "fora-do-tema";
  if (i.modoLocal) return "modo-local";
  return null;
}

/**
 * A decisão DEPOIS de se tentar a resposta local de estado do PC. É o remate do
 * ponto acima: `seguranca-local` significa «responde primeiro do snapshot», não
 * «responde sempre localmente». Se o snapshot não está disponível ou falhou, a
 * pergunta passa a ter a decisão de qualquer outra — e os restantes guardas
 * (consentimento, perigo, fora do tema, cooldown) continuam a valer, porque são
 * reavaliados sobre a mesma matriz, não substituídos por um `return` à pressa.
 */
export function decisaoAposTentativaLocal(
  i: MatrixRotaInput,
  respostaLocalDisponivel: boolean,
): { destino: "local" | "provider"; motivo: string | null } {
  if (respostaLocalDisponivel) return { destino: "local", motivo: "seguranca-local" };
  const semTentativa = { ...i, perguntaSegurancaLocal: false };
  const motivo = motivoDoEncaminhamentoLocal(semTentativa);
  return { destino: motivo === null ? "provider" : "local", motivo };
}

/**
 * O que o cabeçalho do painel pode dizer. `mode` vem de `/api/ai/status` — é
 * CONFIGURAÇÃO e disponibilidade do fornecedor, e nunca «esta resposta veio da
 * IA». Dizer «IA ONLINE» no cabeçalho era exactamente a confusão que este lote
 * vem fechar: com um chip a prometer IA, uma resposta local parecia-a.
 */
export function matrixConfigLabel(mode: "online" | "local" | "a-verificar"): string {
  if (mode === "online") return "Fornecedor verificado";
  if (mode === "local") return "Sem fornecedor verificado";
  return "A verificar o fornecedor";
}

/**
 * O texto que «Explicar na MATRIX» usa. Constante no módulo partilhado para que o
 * fluxo automático e o escrito à mão sejam literalmente a mesma mensagem — uma
 * segunda cópia à espera do componente é onde os dois começariam a divergir.
 */
export const MATRIX_EXPLAIN_PROMPT_PROCESSO = "A memória deste processo está a aumentar? É seguro fechá-lo?";
export const MATRIX_EXPLAIN_PROMPT_MAQUINA = "Porque está o meu PC a usar tanta RAM ou CPU?";

export function promptDeExplicacaoDeProcesso(pid?: number | null): string {
  return pid ? MATRIX_EXPLAIN_PROMPT_PROCESSO : MATRIX_EXPLAIN_PROMPT_MAQUINA;
}

/**
 * Um pedido de explicação envia-se UMA vez. Sem este guarda, o efeito que observa
 * `explainRequest` voltar a correr (re-render, mudança de dependência) reenviava
 * a mesma pergunta ao fornecedor em bucle.
 */
export function deveAutoEnviarExplicacao(
  ultimoIdAutoEnviado: number | null,
  pedido: { id: number } | null | undefined,
): boolean {
  if (!pedido) return false;
  return ultimoIdAutoEnviado !== pedido.id;
}

/** Saudação única da Matrix: a mesma no arranque e em «Nova conversa». */
export const MATRIX_GREETING = "Oi! Tudo bem? Em que posso ajudar?";

/** Conversa nova começa com UMA mensagem da assistente, não com zero. */
export function initialMatrixMessages(): ConversationMessage[] {
  return [{ role: "assistant", content: MATRIX_GREETING }];
}

/**
 * A saudação existe no máximo uma vez, no início. Se a conversa já tem
 * mensagens reais, devolve-as intactas: uma resposta atrasada do serviço ou um
 * segundo arranque não pode substituir (nem apagar) o que a pessoa já disse.
 */
export function garantirSaudacao(messages: readonly ConversationMessage[]): ConversationMessage[] {
  if (messages.length > 0) return messages as ConversationMessage[];
  return initialMatrixMessages();
}

/**
 * Append que garante a saudação quando a conversa ainda está vazia. A ordem e
 * as mensagens existentes são preservadas; não há um segundo caminho que
 * recomece a conversa por baixo do utilizador.
 */
export function acrescentarMensagem(
  messages: readonly ConversationMessage[],
  message: ConversationMessage,
): ConversationMessage[] {
  return [...garantirSaudacao(messages), message];
}

/**
 * A conversa ainda não teve intervenção do utilizador. As sugestões iniciais
 * vivem DENTRO desta fase: aparecem sob a saudação e desaparecem na primeira
 * mensagem, sem uma faixa separada que faça o layout saltar.
 */
export function isConversationStart(messages: ReadonlyArray<Pick<ConversationMessage, "role">>): boolean {
  return messages.every((message) => message.role === "assistant");
}

/**
 * O scroll deve seguir o fundo só quando o utilizador já está lá. Sem isto,
 * cada token do streaming puxava a vista para baixo e escondia o que a pessoa
 * estava a ler. `threshold` é a folga em px para não prender o scroll a meio.
 */
export function isNearBottom(
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
  threshold = 56,
): boolean {
  const { scrollTop, scrollHeight, clientHeight } = metrics;
  if (![scrollTop, scrollHeight, clientHeight].every(Number.isFinite)) return false;
  return scrollHeight - scrollTop - clientHeight <= threshold;
}
