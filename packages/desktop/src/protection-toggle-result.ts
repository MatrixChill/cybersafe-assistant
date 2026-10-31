import type { ProtectionCause, ProtectionToggleConfirmation, ServiceResponseMap } from "@cybersafe/shared-types";

/**
 * PONTE DE CONFIRMAÇÃO DA PROTEÇÃO (P0 contrato, 15/10).
 *
 * O pipe é uma fronteira entre processos: o que chega pode ser de um serviço mais
 * velho, cortado a meio, ou simplesmente sem o campo que pedimos. Enquanto o
 * `main.ts` tinha `result.protectionEnabled ?? true`, uma resposta incompleta
 * AFIRMAVA "proteção ligada". Isso não é uma aproximação honesta: é o estado 100
 * do PC Center em sítio pior — um botão que mente sobre proteção.
 *
 * A regra, uma só vez e EXECUTADA em teste (`protection-toggle-contract.test.mjs`,
 * com `request` injetado — nada de Electron nem de efeitos de arranque):
 *   - `ok` e `protectionEnabled` booleanos REAIS, ou não há confirmação;
 *   - sem confirmação → `protectionEnabled: null` ("não confirmado"), nunca
 *     `true` por omissão e nunca `false` como "OFF confirmado" inventado;
 *   - `ok:true` com estado que contradiz o pedido → também é não-confirmado;
 *   - o pedido a REJEITAR (pipe caído, timeout do cliente) é não-confirmado, com
 *     motivo sanitizado (sem caminhos pessoais) e estável em 200 caracteres;
 *   - a causa do motor (`failures[0]`) segue sempre para o texto do toast.
 *
 * LIMITE DECLARADO: esta camada distingue **rejeição** (timeout/erro que o
 * `ServiceClient` devolve) de **resposta incompleta**. Um pedido que nunca
 * assenta — sem resolução nem rejeição — não é decidido aqui; isso exigiria um
 * deadline próprio na ponte, que o packet proibiu explicitamente introduzir.
 */

export type ProtectionTogglePedido = "start" | "stop";

/** Uma só definição para as duas pontas — o `main.ts` e o `electron.d.ts` do renderer. */
export type ProtectionActionResult = ProtectionToggleConfirmation;

function primeiraCausa(raw: unknown): string | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const primeira = raw[0] as Partial<ProtectionCause> | null | undefined;
  if (!primeira || typeof primeira !== "object") return undefined;
  if (typeof primeira.label !== "string" || typeof primeira.reason !== "string") return undefined;
  return `${primeira.label}: ${primeira.reason}`;
}

function degradacoesValidas(raw: unknown): ProtectionCause[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const validas = raw.filter(
    (c): c is ProtectionCause =>
      !!c && typeof c === "object" && typeof (c as ProtectionCause).label === "string" && typeof (c as ProtectionCause).reason === "string",
  );
  return validas.length ? validas : undefined;
}

/**
 * Traduz a resposta crua do pipe em resultado confirmável. Recebe `unknown`
 * de propósito: a validação é o contrato, não a declaração de tipos.
 */
export function interpretProtectionToggle(raw: unknown, pedido: ProtectionTogglePedido): ProtectionActionResult {
  const acao = pedido === "start" ? "a ativação" : "a paragem";

  if (!raw || typeof raw !== "object") {
    return { ok: false, protectionEnabled: null, reason: `O serviço não devolveu resposta para ${acao}.` };
  }

  const corpo = raw as Record<string, unknown>;
  if (typeof corpo.ok !== "boolean" || typeof corpo.protectionEnabled !== "boolean") {
    return {
      ok: false,
      protectionEnabled: null,
      reason: `Resposta incompleta de ${acao}: faltou ` + (typeof corpo.ok !== "boolean" ? "`ok`" : "`protectionEnabled`") + " booleano.",
    };
  }

  const causa = primeiraCausa(corpo.failures);

  if (corpo.ok === false) {
    // O motor disse NÃO e desmontou os subsistemas: o estado devolvido por ele é
    // uma confirmação, não uma suposição.
    return { ok: false, protectionEnabled: corpo.protectionEnabled, reason: causa ?? "O serviço recusou a mudança de estado." };
  }

  // ok:true tem de afirmar o estado que foi pedido. Contradição não se traduz em estado.
  if (corpo.protectionEnabled !== (pedido === "start")) {
    return {
      ok: false,
      protectionEnabled: null,
      reason: `Resposta contraditória de ${acao}: ok:true com protectionEnabled=${String(corpo.protectionEnabled)}.`,
    };
  }

  const revogacao = pedido === "stop" && (corpo.revogacaoRetoma === "confirmada" || corpo.revogacaoRetoma === "nao_confirmada")
    ? corpo.revogacaoRetoma : undefined;
  return {
    ok: true,
    protectionEnabled: corpo.protectionEnabled,
    degraded: degradacoesValidas(corpo.degraded),
    ...(revogacao ? { revogacaoRetoma: revogacao } : {}),
    // OFF vivo e preferência de arranque são factos diferentes. Nem uma flag
    // ausente num serviço antigo nem uma falha de disco confirmam revogação.
    ...(pedido === "stop" && revogacao !== "confirmada" ? {
      reason: "A proteção está desligada agora. A revogação da retoma automática não foi confirmada; a proteção pode voltar a iniciar quando abrir a aplicação. Verifique a preferência de arranque nas Definições.",
    } : {}),
  };
}

/**
 * O pedido vai ao pipe com o TIPO do mapa partilhado: se `ServiceResponseMap`
 * voltar a descrever outra coisa que não a forma real do motor, isto deixa de
 * compilar. É este o elo que faltava quando o `main.ts` precisava de um cast.
 */
export type ProtectionToggleRequest = (
  cmd: "monitor.start" | "monitor.stop",
) => Promise<ServiceResponseMap["monitor.start"] | ServiceResponseMap["monitor.stop"] | undefined>;

const CAMINHO_PESSOAL = /[A-Za-z]:[\\/](?:Users|users)[\\/][^\\/\s"']+/g;

/**
 * Motivo legível de uma REJEIÇÃO, sem caminhos pessoais e com teto de 200
 * caracteres. Timeout tem frase própria: "não respondeu a tempo" é facto, enquanto
 * "falhou" seria uma conclusão que o tempo de espera não prova.
 */
export function motivoDaRejeicao(err: unknown): string {
  const nome = err instanceof Error ? err.name : "";
  const mensagem = err instanceof Error ? err.message : String(err);
  const rotulo = nome && nome !== "Error" ? `${nome}: ` : "";
  const seguro = `${rotulo}${mensagem}`
    .replace(CAMINHO_PESSOAL, "C:\\Users\\<utilizador>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  if (/timeout/i.test(`${nome} ${mensagem}`)) {
    return `O serviço não respondeu dentro do tempo previsto${seguro ? ` (${seguro})` : ""}.`;
  }
  return `O serviço não aceitou o pedido (${seguro || "erro sem mensagem"}).`;
}

/**
 * CAMINHO DE PRODUÇÃO DA ATIVAÇÃO/PARAGEM da proteção. O `main.ts` chama esta
 * função com o `client.request` real; os testes chamam a MESMA função com um
 * `request` injetado. Foi esta separação que permitiu à auditoria anterior
 * ("só lido por regex") não ter nunca executado o caminho do `catch`.
 */
export async function requestProtectionToggle(
  request: ProtectionToggleRequest,
  enabled: unknown,
  registarErro?: (err: unknown) => void,
): Promise<ProtectionActionResult> {
  if (typeof enabled !== "boolean") {
    return { ok: false, protectionEnabled: null, reason: "Pedido de proteção inválido: é necessário um valor booleano." };
  }
  const cmd = enabled ? "monitor.start" : "monitor.stop";
  try {
    return interpretProtectionToggle(await request(cmd), enabled ? "start" : "stop");
  } catch (err) {
    registarErro?.(err);
    // Rejeição = nada confirmado. Nunca `true`, nunca OFF "confirmado" inventado.
    return { ok: false, protectionEnabled: null, reason: motivoDaRejeicao(err) };
  }
}

/**
 * Texto do toast de falha, com os dois sentidos separados: "o serviço não
 * confirmou" (não sabemos) não é "o serviço confirmou que não" (sabemos).
 */
export function protectionFailToast(acao: "ativar" | "desativar", res: ProtectionActionResult): { title: string; body: string } {
  const causa = res.reason ? ` ${res.reason}.` : "";
  const title = `Não foi possível ${acao} a proteção`;
  if (res.protectionEnabled === null) {
    return {
      title,
      body: `O serviço não confirmou o estado.${causa} O número no ecrã é a última leitura válida, não uma confirmação.`,
    };
  }
  return {
    title,
    body: `Estado confirmado pelo serviço: proteção ${res.protectionEnabled ? "ligada" : "desligada"}.${causa}`,
  };
}
