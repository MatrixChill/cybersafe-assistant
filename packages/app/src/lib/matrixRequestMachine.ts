/**
 * TP-MATRIX-HUMAN-FAIL-20261023 — maquina de estado do pedido MATRIX.
 *
 * Porque existe: o gate humano mostrou cinco leituras erradas que vim resolver com
 * etiquetas novas espalhadas pelo componente. «Explicar frequentemente offline»,
 * «fornecedor verificado» lido como «esta resposta veio da IA», erro de fornecedor
 * que sobrevivia a uma conversa nova, e consentimento que dizia «autorizado noutro
 * alvo» enquanto a caixa estava marcada. Todas sao a mesma doenca: nao havia UMA
 * definicao do que se passa num pedido, portanto cada sitio dizia uma coisa.
 *
 * Isto e um modulo puro: o componente importa e usa estas funcoes, e os testes
 * chamam-nas. E a unica forma de cobrir os estados sem DOM neste arvore (nao ha
 * jsdom nem react-test-renderer, e instalar nao e opcao), por isso as alegacoes
 * ficam ao nivel que se pode provar: transicao de estado e render SSR, nao ciclo
 * de GUI.
 *
 * Os estados distinguiveis do pedido:
 *  necessita-autorizacao · a-enviar · a-stream · generativa · indisponivel ·
 *  local · erro-recuperavel · pedido-recusado · recusado-pelo-fornecedor
 *
 * `pedido-recusado` existe desde a falha humana de 2026-10-23: um 400 do NOSSO
 * serviço (contexto inválido / sem autorização / credenciais bloqueadas) era
 * mostrado como «Erro temporário, podes tentar» e voltava a falhar exactamente
 * igual. Recusa estável não é falha de rede, e repetir o mesmo pedido não é a
 * acção que a resolve.
 */

/** Estados observaveis de um pedido. Sem atalhos. */
export type MatrixRequestState =
  | "necessita-autorizacao"
  | "a-enviar"
  | "a-stream"
  | "generativa"
  | "indisponivel"
  | "local"
  | "erro-recuperavel"
  | "pedido-recusado"
  /** Recusa do FORNECEDOR (4xx depois do pedido ter chegado). Distinta de
   *  `pedido-recusado`, que e a recusa do NOSSO servico antes do envio. */
  | "recusado-pelo-fornecedor";

/**
 * Codigos estaveis devolvidos pela API (`classifyError` em packages/api/src/ai.ts).
 * A distincao entre «o fornecedor nao esta la» e «falhou desta vez, podes tentar»
 * e o que falta ao utilizador para nao chamar «offline» a tudo.
 */
export const CODIGOS_RECUPERAVEIS = ["rate_limited", "timeout", "network"] as const;
export const CODIGOS_INDISPONIVEIS = ["no_provider", "model_unavailable", "auth", "provider_unavailable"] as const;
/**
 * Recusa estável do NOSSO serviço, antes de qualquer fornecedor: 400 decidido
 * pelo gate de processos/credenciais. Repetir o mesmo texto não muda o resultado.
 * `process_consent_missing` e `process_context_invalid` são os códigos que
 * passaram a separar «a pessoa não autorizou» de «a app construiu mal o pedido».
 */
export const CODIGOS_RECUSADOS = [
  "process_consent_authorization_invalid",
  "process_consent_authorization_expired",
  "process_consent_authorization_used",
  "process_consent_target_mismatch",
  "process_consent_payload_out_of_scope",
  "process_consent_ambiguous",
  "invalid_request",
  "credential_blocked",
  "process_consent_missing",
  "process_context_invalid",
  // Recusa do fornecedor (4xx no adaptador seguro): estavel, mas o pedido
  // chegou a sair da maquina — o rotulo de `pedido-recusado` mentiria.
  "provider_rejected",
] as const;

export function classeDeErro(code?: string): "recuperavel" | "indisponivel" | "recusado" | "desconhecido" {
  if (!code) return "desconhecido";
  if ((CODIGOS_RECUSADOS as readonly string[]).includes(code)) return "recusado";
  if ((CODIGOS_RECUPERAVEIS as readonly string[]).includes(code)) return "recuperavel";
  if ((CODIGOS_INDISPONIVEIS as readonly string[]).includes(code)) return "indisponivel";
  return "desconhecido";
}

/**
 * De onde veio o resultado, derivado do estado — nunca o contrario. `nenhuma`
 * existe porque «a enviar» e «a stream» ainda nao tem resposta para atribuir.
 */
export function origemDoEstado(estado: MatrixRequestState): "provider" | "local" | "nenhuma" {
  if (estado === "generativa") return "provider";
  if (estado === "a-enviar" || estado === "a-stream") return "nenhuma";
  return "local";
}

/** Rotulos PT-PT. Nenhum estado de configuracao usa palavras de resposta. */
export function matrixStateLabel(estado: MatrixRequestState | null): string | null {
  switch (estado) {
    case "necessita-autorizacao": return "A precisar da tua autorização";
    case "a-enviar": return "A enviar o pedido";
    case "a-stream": return "A responder";
    case "generativa": return "Resposta da IA";
    case "indisponivel": return "IA indisponível";
    case "local": return "Resposta local";
    case "erro-recuperavel": return "Erro temporário, podes tentar";
    case "pedido-recusado": return "Pedido recusado — nada foi enviado ao fornecedor";
    case "recusado-pelo-fornecedor": return "O fornecedor recebeu o pedido e recusou-o";
    default: return null;
  }
}

/**
 * O cabecalho so pode falar do que sabe: `mode` vem de `/api/ai/status`, que e
 * CONFIGURACAO. «Fornecedor verificado» nao autoriza nenhuma mensagem a dizer que
 * foi a IA que respondeu — essa prova so existe no resultado do pedido.
 */
export function providerConfigurado(mode: "online" | "local" | "a-verificar"): boolean {
  return mode === "online";
}

/** Entrada unica da decisao: o que se passou e o que se pode dizer que passou. */
export type MatrixPedido = {
  /** Motivo estavel de intercepcao local (`motivoDoEncaminhamentoLocal`), ou null. */
  motivo: string | null;
  pediuProvider: boolean;
  ok?: boolean;
  conteudo?: string;
  code?: string;
  /** Cooldown activo depois de falhar: nao se volta a martelar o fornecedor. */
  emCooldown?: boolean;
};

/**
 * Estado FINAL de um pedido concluido. A ordem importa:
 *  1. motivo local primeiro — se faltou autorizacao, o fornecedor nem foi tentado
 *     e dizer «indisponivel» mentia sobre o que aconteceu;
 *  2. cooldown: o fornecedor ate pode estar configurado, mas ha uma falha recente
 *     que ja decidimos nao repetir → «indisponivel», com a causa;
 *  3. concluido com texto → «generativa»;
 *  4. erro com forma de tentar de novo → «erro-recuperavel»;
 *  5. o resto → «indisponivel».
 * Um `ok` sem conteudo NUNCA e generativo: stream aberto e fechado sem tokens nao
 * respondeu nada, e contava como IA antes disto.
 */
export function estadoDoPedido(p: MatrixPedido): MatrixRequestState {
  if (p.motivo === "sem-consentimento") return "necessita-autorizacao";
  // «Local» escolhido pelo utilizador é uma resposta local intencional, não um
  // fornecedor indisponível: `modo-local` (cooldown) tem o estado próprio abaixo.
  if (p.motivo === "modo-local-escolhido") return "local";
  // Cooldown é o fornecedor que está indisponível, não a pessoa: dizer «local»
  // aqui escondia a causa e fazia uma pergunta normal parecer «modo offline».
  if (p.motivo === "modo-local") return "indisponivel";
  if (p.motivo !== null) return "local";
  if (p.emCooldown) return "indisponivel";
  if (!p.pediuProvider) return "local";
  if (p.ok === true && typeof p.conteudo === "string" && p.conteudo.trim().length > 0) return "generativa";
  // A recusa do fornecedor vem primeiro: `provider_rejected` esta em
  // CODIGOS_RECUSADOS, mas o pedido SAIU da maquina. Chamar-lhe
  // «nada foi enviado ao fornecedor» seria falso.
  if (p.code === "provider_rejected") return "recusado-pelo-fornecedor";
  if (classeDeErro(p.code) === "recusado") return "pedido-recusado";
  if (classeDeErro(p.code) === "recuperavel") return "erro-recuperavel";
  return "indisponivel";
}

/** Transicao de transporte, antes de haver resultado. */
export function estadoDoTransporte(abortado: boolean, bytesRecebidos: boolean): MatrixRequestState {
  if (abortado) return "erro-recuperavel";
  return bytesRecebidos ? "a-stream" : "a-enviar";
}

/* --------------------------------------------------------------------------
 * Guarda de envio.
 *
 * Duas regras que ja custaram um defeito cada uma:
 *
 * 1. O aviso de revogacao so pode bloquear pedidos que LEVAM medicoes. Um
 *    `if (bloqueado)` incondicional fechava o chat geral depois de uma revogacao
 *    por confirmar — e o chat geral nao carrega telemetria nenhuma, logo nao ha
 *    nada para bloquear. Privacidade restringe o que viaja, nao a conversa.
 * 2. A decisao tem de ser tomada outra vez depois de cada `await`. Entre a
 *    guarda inicial e o `fetch` ha um GET de consentimento; nesse intervalo a
 *    pessoa pode revogar, trocar de conta, ou o pedido pode ter sido substituido.
 *    Decidir antes e enviar depois e a janela onde um payload privado sai sem
 *    autoridade viva.
 * ------------------------------------------------------------------------ */

export function bloqueioDeConsentimentoAplica(bloqueado: boolean, anexarContexto: boolean): boolean {
  return bloqueado && anexarContexto;
}

export type DecisaoDeEnvio =
  | { enviar: true }
  | { enviar: false; code: string; message: string };

/**
 * A ultima pergunta antes de serializar/enviar o payload.
 *
 * Ordem: abortar e substituicao primeiro (nao ha pedido nenhum a proteger); so
 * depois o consentimento, porque ele so diz respeito ao que leva medicoes. A
 * conta comparada e a da sessao autenticada — nunca o `userId` do proprio grant,
 * que seria validar um documento contra si mesmo.
 */
export function revalidarAntesDoEnvio(i: {
  anexarContexto: boolean;
  bloqueado: boolean;
  abortado: boolean;
  vigente: boolean;
  contaActual: string | null;
  /** Conta autenticada quando o pedido nasceu; `null` = sem sessao. */
  contaDoPedido: string | null;
}): DecisaoDeEnvio {
  if (i.abortado) return { enviar: false, code: "aborted", message: "Pedido cancelado antes do envio." };
  if (!i.vigente) return { enviar: false, code: "pedido_substituido", message: "Este pedido já não é o pedido em curso; nada foi enviado." };
  if (!i.anexarContexto) return { enviar: true };
  if (i.bloqueado) {
    return { enviar: false, code: "process_consent_grant_invalid", message: "A revogação do consentimento está por confirmar. Nada foi enviado ao fornecedor; volta a autorizar." };
  }
  if (!i.contaActual) {
    return { enviar: false, code: "process_consent_grant_invalid", message: "Sem sessão verificável para enviar medições. Nada foi enviado ao fornecedor." };
  }
  if (i.contaDoPedido !== i.contaActual) {
    return { enviar: false, code: "process_consent_grant_invalid", message: "A conta mudou desde o início do pedido. Nada foi enviado ao fornecedor; volta a autorizar." };
  }
  return { enviar: true };
}

/* --------------------------------------------------------------------------
 * Identidade do pedido: o que permite trocar de processo a meio sem atribuir a
 * resposta errada ao PID errado.
 * ------------------------------------------------------------------------ */

export type IdentidadePedido = {
  requestId: string;
  conversationId: string;
  /** Target opaco: pid + instante da amostra, nunca nome nem caminho. */
  targetId: string;
  geracao: number;
};

export function alvoDePedido(alvo: { pid: number | null; startedAt: string | null } | null): string | null {
  if (!alvo) return null;
  if (alvo.pid === null) return "maquina";
  return `${alvo.pid}:${alvo.startedAt ?? "sem-inicio"}`;
}

/**
 * Uma resposta atrasada so e aproveitavel se pertencer o MESMO pedido, a MESMA
 * conversa e o MESMO alvo. Faltar qualquer um dos tres e descartar: trocar de
 * processo depressa deixava a resposta do processo anterior aparecer como se fosse
 * do novo, e abrir conversa nova deixava a resposta velha cair la dentro.
 *
 * `actual === null` e DESCARTAR, nunca «deixa passar». O pedido activo apaga-se
 * quando a pessoa muda de alvo (fica a precisar de autorizacão) ou abre uma
 * conversa nova: nao ha pedido em curso a que a resposta possa pertencer, e
 * comparar uma identidade antiga contra si propria — o que acontecia quando o
 * chamador usava `ref ?? identidade` — aceitava a resposta do pedido que ja nao
 * tinha dono. Fail-closed por omissao.
 */
export function descartarResposta(i: {
  pedido: IdentidadePedido;
  actual: IdentidadePedido | null;
  signalAbortado: boolean;
}): boolean {
  if (i.signalAbortado) return true;
  if (i.actual === null) return true;
  if (i.pedido.conversationId !== i.actual.conversationId) return true;
  if (i.pedido.targetId !== i.actual.targetId) return true;
  if (i.pedido.requestId !== i.actual.requestId) return true;
  if (i.pedido.geracao !== i.actual.geracao) return true;
  return false;
}

/* --------------------------------------------------------------------------
 * Instrumentacao DEV: o minimo do pedido, e so o que nao identifica ninguem.
 *
 * Devolve texto em vez de escrever: o componente decide quando escreve, e um teste
 * pode provar o conteudo sem depender de `console`. Nada fora desta lista existe —
 * texto da pergunta, nomes de processo, caminhos, metricas e chaves nao passam por
 * aqui, nem por via de debug.
 * ------------------------------------------------------------------------ */

export type TracePedido = {
  requestId: string;
  conversationId: string;
  targetId: string;
  consentState: "autorizado" | "pendente" | "negado" | "nao-precisa";
  providerState: MatrixRequestState;
  origin: "provider" | "local" | "nenhuma";
  errorCode?: string;
};

const CAMPOS_TRACE = ["requestId", "conversationId", "targetId", "consentState", "providerState", "origin", "errorCode"] as const;

/** So codigos estaveis da API. Qualquer outra coisa sai como `desconhecido`. */
const ERRO_CONHECIDOS = new Set<string>([...CODIGOS_RECUPERAVEIS, ...CODIGOS_INDISPONIVEIS, ...CODIGOS_RECUSADOS, "aborted", "malformado"]);

function campoSeguro(v: unknown): string {
  if (typeof v !== "string" && typeof v !== "number") return "-";
  const t = String(v);
  // Ids opacos e codigos sao curtos; um valor compro e texto de utilizador, e
  // texto de utilizador nao vai para o log.
  if (t.length > 64 || /[\r\n\t]/.test(t)) return "[omitido]";
  return t;
}

export function traceDePedido(t: Partial<TracePedido>): string {
  const code = typeof t.errorCode === "string" && ERRO_CONHECIDOS.has(t.errorCode) ? t.errorCode : "desconhecido";
  const partes = CAMPOS_TRACE.map((c) => `${c}=${campoSeguro(c === "errorCode" ? code : t[c])}`);
  return `[matrix] ${partes.join(" ")}`;
}

/**
 * A mensagem de uma recusa DO FORNECEDOR.
 *
 * Separada da recusa pre-envio de proposito. Quando e o NOSSO servico que
 * recusa (400 antes do provider), a frase honesta e «nada foi enviado ao
 * fornecedor». Quando e o fornecedor que responde 4xx, o pedido SAIU da
 * maquina: repetir essa frase seria uma alegacao de privacidade falsa. Aqui a
 * mensagem assume o envio e nao promete que nada saiu.
 *
 * Uma mensagem do servico e usada tal como veio (so sem espacos a mais); vazia
 * ou ausente cai no texto proprio — nunca em silencio nem numa alegacao nova.
 */
export function mensagemDeRecusaDoFornecedor(mensagemDoServico?: string): string {
  const propria = typeof mensagemDoServico === "string" ? mensagemDoServico.trim() : "";
  if (propria.length > 0) return propria;
  return "O fornecedor de IA recebeu o pedido e recusou-o. Repetir o mesmo texto não o vai resolver.";
}

/**
 * Sem isto, um 401/403/404/503 do NOSSO serviço chegava ao cliente sem código e
 * era tratado como falha de rede: três tentativas e «não foi possível contactar
 * o fornecedor» para um problema que não era de rede. O código tem de ser o que
 * o servidor classificou; o status é só o fallback estável.
 */
export function codigoDeStatusHttp(status: number): string | undefined {
  // 400 sem corpo JSON é ainda uma recusa estável do serviço — nunca uma falha
  // de rede que se possa repetir às cegas.
  if (status === 400) return "invalid_request"
  if (status === 401 || status === 403) return "auth"
  if (status === 404) return "model_unavailable"
  if (status === 408 || status === 504) return "timeout"
  if (status === 429) return "rate_limited"
  if (status === 503) return "no_provider"
  // O fornecedor a falhar (5xx) nao e a rede do utilizador: e indisponibilidade
  // do lado de la, dita como tal. Um 4xx sem codigo no corpo e uma recusa
  // estavel do servico; repetir o mesmo pedido nao muda o resultado.
  if (status >= 500 && status < 600) return "provider_unavailable"
  if (status >= 400 && status < 500) return "invalid_request"
  return undefined
}
