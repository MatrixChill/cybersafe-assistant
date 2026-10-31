/**
 * Fluxo de "terminar processo" (kill) do Gestor de Tarefas.
 *
 * Bug manual: ao excluir uma tarefa a página ficava preta/vazia (overlay escuro
 * preso) e a tarefa reaparecia ao voltar. Causas estruturais no renderer:
 *  - não havia timeout: se a `invoke` nunca resolvia, `isKilling` ficava `true`
 *    para sempre e o overlay `bg-background/80` nunca fechava;
 *  - não havia refetch autoritativo depois do kill: o desaparecimento da linha
 *    dependia só do evento `process.killed` + snapshot em cache.
 *
 * Este módulo isola essa lógica em funções puras/testáveis. Não remove itens da
 * lista localmente (sem remoção otimista): quem manda é o snapshot do serviço.
 * O resultado do backend é agora `ProcessKillResult` estruturado — protected,
 * timeout, reused, access-denied, alias-stub, failed e already-exited têm
 * mensagens específicas (o erro real do taskkill quando o backend o propaga).
 * Cada desfecho que mexeu no cache do serviço (killed/already-exited/timeout/
 * alias-stub/reused) obriga a um refetch: quem manda na lista é o Windows.
 */

import type { ProcessKillResult, ProcessKillStatus, ProcessKillProtectionReason } from "@cybersafe/shared-types";

// ─────────────────────────────────────────────────────────────────────────────
// Badge de recomendação da análise de um processo.
//
// P0 (CLAMAV_INCONCLUSIVE_VERDICT): o serviço devolve `inconclusive` quando o
// motor não conseguiu avaliar o ficheiro — medido, o Defender remove-o no
// instante em que o clamscan o abre. A UI desenhava esse caso com o `else`:
// styling VERDE, ícone de escudo, palavra "Seguro". Era um pixels green de uma
// mentira.
//
// A correção NÃO é dizer "suspeito" (fabricar uma ameaça) nem "inseguro"
// (idem). É um quarto estado que diz "não sei", com um tom que não é o do
// "safe". Fonte única: o badge e os testes leem os dois daqui.
// ─────────────────────────────────────────────────────────────────────────────

export type ProcessRecommendation = "safe" | "suspicious" | "dangerous" | "inconclusive";

export interface ProcessRecommendationMeta {
  label: string;
  /** Classe de styling. `unknown` é deliberadamente distinto de `safe`. */
  tone: "safe" | "warn" | "danger" | "unknown";
}

const RECOMMENDATION_META: Record<ProcessRecommendation, ProcessRecommendationMeta> = {
  safe: { label: "Seguro", tone: "safe" },
  suspicious: { label: "Suspeito", tone: "warn" },
  dangerous: { label: "Perigoso", tone: "danger" },
  inconclusive: {
    label: "Inconclusivo — o motor não conseguiu avaliar o ficheiro",
    tone: "unknown",
  },
};

export function processRecommendationMeta(
  recommendation: ProcessRecommendation | null | undefined,
): ProcessRecommendationMeta {
  if (!recommendation) return RECOMMENDATION_META.inconclusive;
  return RECOMMENDATION_META[recommendation] ?? RECOMMENDATION_META.inconclusive;
}

/**
 * Prazo máximo para o serviço responder a um pedido de kill.
 *
 * DERIVADO do orçamento do serviço (packages/service/src/engine.ts), não um
 * número solto: cada `await` do `killProcess` recebe `remaining()`, logo o
 * serviço nunca passa do orçamento — a única excepção é o reap, cuja probe pode
 * transbordar `remaining()` até ao piso (é o que lhe permite confirmar a morte
 * em vez de fabricar `still-running`). Pior caso do serviço:
 * 12 000 + 2 000 = 14 000 ms. A margem final é o que o renderer gasta ANTES do
 * relógio do serviço arrancar (invoke + pipe + fila do handler).
 *
 * Se mexeres numa destas parcelas, o contrato é verificado por
 * packages/service/test/kill-budget.test.js, que lê este ficheiro — não deixe
 * os dois lados divergir em silêncio.
 */
const KILL_SERVICE_TOTAL_BUDGET_MS = 12_000;
const KILL_REAP_FLOOR_MS = 2_000;
const KILL_PIPE_MARGIN_MS = 2_000;

export const KILL_TIMEOUT_MS = KILL_SERVICE_TOTAL_BUDGET_MS + KILL_REAP_FLOOR_MS + KILL_PIPE_MARGIN_MS;

export const KILL_UNAVAILABLE_ERROR =
  "Gestão de processos indisponível: execute a app a partir do ambiente de trabalho.";

export const KILL_FAILED_ERROR =
  "Falha ao terminar processo. Pode ser um serviço protegido do sistema.";

export const KILL_TIMEOUT_ERROR =
  "O serviço de proteção não respondeu ao pedido. O processo pode não ter sido terminado.";

export const KILL_ERROR_ERROR = "Erro ao terminar processo.";

/**
 * A recusa NOMEADA da fronteira Windows de leitura.
 *
 * Não é um término que falhou: o pedido foi barrado no processo main do
 * Electron antes de chegar ao serviço, por isso o Windows não mudou de estado e
 * nenhum processo foi morto. Dizer «Erro ao terminar processo» aqui minte nas
 * duas direções — sugere uma tentativa real e empurra o utilizador para repetir
 * a mesma ação já recusada.
 */
export const KILL_READONLY_UNAVAILABLE =
  "Ação indisponível nesta sessão — o CyberSafe está em modo de leitura e nenhum processo foi terminado.";

/**
 * Reconhece APENAS a recusa nomeada do efeito negado.
 *
 * `ipcRenderer.invoke` não propaga objetos: quando o handler do main lança, o
 * renderer recebe um `Error` com o texto embrulhado
 * (`Error occurred in handler for '…': …`). Por isso se testa o SUBSTRING do
 * código da fronteira, e não a classe do erro — a classe ficou no main.
 *
 * A lista de não-correspondências importa tanto como a de correspondências:
 * `metodo_nao_e_leitura_permitida_neste_modo` é outra recusa (leitura não
 * permitida) e uma falha de rede ou um `access denied` REAL têm de continuar a
 * dar `null` para não mascarar um problema verdadeiro como indisponibilidade.
 */
export function classifyKillRejection(erro: unknown): "dev_windows_readonly" | null {
  const mensagem = erro instanceof Error ? erro.message : null;
  if (typeof mensagem !== "string" || mensagem === "") return null;
  if (mensagem.includes("dev_windows_readonly: efeito_negado_por_modo_leitura")) {
    return "dev_windows_readonly";
  }
  return null;
}

export const KILL_PROTECTED_ERROR =
  "Processo protegido do CyberSafe/sistema: não pode ser terminado.";

/**
 * O que o serviço JA sabe e o renderer deitava fora.
 *
 * `classifyKillTarget` distingue estas cinco razões, e o contrato
 * (`ProcessKillResult.protectedReason`) leva-as até ao renderer. Antes, as
 * cinco chegavam ao ecrã como a MESMA frase, e o dado era descartado.
 *
 * A diferença é o que o utilizador pode fazer a seguir, e não é académica:
 *   · `self`/`ancestor` — o alvo é o CyberSafe ou quem o lançou: nunca deve
 *     ser terminado, e não há nada para repetir;
 *   · `internal` — é um componente do próprio CyberSafe: protegê-lo é o
 *     comportamento correto, não um erro;
 *   · `system-pid` — é um processo de sistema do Windows: repetir não resolve,
 *     porque a recusa é do sistema e não de uma falha pontual;
 *   · `fallback-name` — o NOME bateu com um protegido, mas o caminho não pôde
 *     ser confirmado: aqui a suspeita é real e o utilizador é informado.
 *
 * Texto PT-PT. A chave `error` que o serviço envia hoje está em inglês técnico
 * (`Cannot terminate protected CyberSafe/system process`) e nunca é mostrada
 * aqui: o ecrã fala português.
 */
export const KILL_PROTECTED_REASON_MESSAGE: Record<ProcessKillProtectionReason, string> = {
  "self": "É o próprio serviço de proteção do CyberSafe. Nunca pode ser terminado.",
  "ancestor": "É o processo que iniciou o CyberSafe. Nunca pode ser terminado.",
  "internal": "É um componente do próprio CyberSafe: está protegido de propósito e não pode ser terminado.",
  "system-pid": "É um processo de sistema do Windows: não pode ser terminado, e repetir não resolve porque a recusa é do sistema.",
  "fallback-name": "O nome corresponde a um processo protegido do CyberSafe ou do sistema, mas o caminho não pôde ser confirmado: não pode ser terminado.",
};

export const KILL_REUSED_ERROR =
  "O PID mudou de dono (reutilizado). A terminação não foi confirmada.";

export const KILL_ACCESS_DENIED_ERROR =
  "O Windows recusou o término (acesso negado). Pode ser um processo protegido do sistema ou exigir privilégios elevados.";

export const KILL_ALREADY_EXITED_TEXT = "O processo já não estava em execução.";

/**
 * Sucesso, sem mentira.
 *
 * O caminho de sucesso era o ÚNICO silencioso: `killed` devolvia `message: null`
 * e uma tentativa de terminar processo podia acabar sem feedback nenhum. Uma
 * falha visível é melhor do que um sucesso invisível: o utilizador carregou em
 * "Terminar" e tem de saber o que aconteceu.
 *
 * A forma CURTA é a única honesta hoje. Para escrever a forma longa seria
 * preciso provar que os FILHOS também morreram, e o contrato não traz essa
 * prova: `ProcessKillResult` tem `success`, `status`, `pid`, `error`,
 * `protectedReason`, `target`, `exitCode`, `stdout`, `stderr` — nenhum campo
 * diz quantos filhos foram terminados. O `exitCode: 0` é o relatório do
 * taskkill, não uma verificação por filho, e o serviço reapura apenas o PID
 * alvo. Afirmar "e subprocessos" sem prova seria mentira.
 */
export const KILL_SUCCESS_MESSAGE = "Processo terminado com sucesso.";

/**
 * A forma longa, para quando o contrato TRANSPORTAR a prova (ex.: um campo
 * `treeConfirmed` ou a contagem de filhos verificados). Existe para não ter de
 * a inventar no dia em que essa prova existir — e não é usada por omissão,
 * porque hoje não há prova. Um teste fixa que o caminho real devolve sempre a
 * forma curta, para esta constante não entrar em produção sem o campo que a
 * justifica.
 */
export const KILL_SUCCESS_MESSAGE_WITH_TREE =
  "Processo e subprocessos terminados com sucesso.";

/**
 * O serviço disse-nos que o PID que matámos era um stub/App Execution Alias
 * (MSIX — o Notepad do Windows 11, por exemplo) e que o processo REAL continua
 * vivo noutro PID. A mensagem do backend traz esse PID; esta constante é só a
 * rede quando ele vier sem texto.
 */
export const KILL_ALIAS_STUB_ERROR =
  "O PID terminado era apenas o lançador da app; o processo real continua vivo noutro PID.";

/** Estados do renderer: os do backend + "unavailable" (sem bridge Electron). */
export type KillStatus = ProcessKillStatus | "unavailable";

export interface KillOutcome {
  status: KillStatus;
  pid: number;
  /** `true` quando o objetivo (o processo não existir mais) foi atingido. */
  success: boolean;
  /** Mensagem pronta a mostrar (sucesso informativo ou erro); `null` se silencioso. */
  message: string | null;
  /**
   * Porque é que o alvo estava protegido, quando `status === "protected"`.
   * Vem do serviço e antes era engolido aqui. `undefined` quando o serviço não
   * disse — a UI não o deduz.
   */
  protectedReason?: ProcessKillProtectionReason;
}

/**
 * Converte o resultado estruturado do serviço no desfecho que a UI mostra.
 * Cada `status` tem uma mensagem própria — nada de erros genéricos.
 */
export function mapKillResult(result: ProcessKillResult | null | undefined): KillOutcome {
  if (!result || typeof result !== "object") {
    return { status: "failed", pid: 0, success: false, message: KILL_FAILED_ERROR };
  }

  const pid = typeof result.pid === "number" ? result.pid : 0;
  const backendError = typeof result.error === "string" && result.error ? result.error : null;
  // Só se aceita uma razão que existe no contrato: o mapa é sobre
  // `ProcessKillProtectionReason`, e um valor desconhecido não entra.
  const protectedReason = result.protectedReason;

  switch (result.status) {
    case "killed":
      return { status: "killed", pid, success: true, message: KILL_SUCCESS_MESSAGE };
    case "already-exited":
      return { status: "already-exited", pid, success: true, message: KILL_ALREADY_EXITED_TEXT };
    case "protected":
      // A razão do serviço manda. Sem razão (`fallback-name` chega sempre
      // acompanhada de nome), fica a frase genérica honesta — nunca uma
      // razão adivinhada.
      return {
        status: "protected",
        pid,
        success: false,
        message: protectedReason
          ? KILL_PROTECTED_REASON_MESSAGE[protectedReason]
          : KILL_PROTECTED_ERROR,
        protectedReason,
      };
    case "timeout":
      return { status: "timeout", pid, success: false, message: backendError ?? KILL_TIMEOUT_ERROR };
    case "reused":
      return { status: "reused", pid, success: false, message: backendError ?? KILL_REUSED_ERROR };
    case "access-denied":
      return { status: "access-denied", pid, success: false, message: backendError ?? KILL_ACCESS_DENIED_ERROR };
    case "alias-stub":
      // O serviço diz que o PID que a UI mostrava morreu (ou já tinha morrido)
      // e que o processo REAL está noutro PID — a mensagem dele traz esse PID,
      // por isso é ela que se mostra, nunca um "falha genérica".
      return { status: "alias-stub", pid, success: false, message: backendError ?? KILL_ALIAS_STUB_ERROR };
    case "failed":
    default:
      return { status: "failed", pid, success: false, message: backendError ?? KILL_FAILED_ERROR };
  }
}

export interface RunKillProcessOptions {
  pid: number;
  kill: (pid: number) => Promise<ProcessKillResult>;
  /** Prazo antes de desistir e fechar o overlay. Default: {@link KILL_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Estado de um pedido de kill em curso. Mutável e minúsculo de propósito: o
 * que se precisa é de uma-bandeira que se lê e se escreve **no mesmo instante**,
 * o que o `useState`/`disabled` de um botão não garantem (o `disabled` só
 * chega no re-render, que em React é no turno seguinte).
 *
 * Um objeto por fluxo, passado por referência. O `useRef` do componente dá
 * exatamente isto, e o que torna isto testável sem React.
 */
export interface KillRequestGate {
  inFlight: boolean;
  /**
   * A fronteira Windows já recusou os kills desta montagem, por nome. Uma vez
   * recusada, a recusa é uma propriedade da SESSÃO (o main barra o pedido antes
   * de ele chegar ao serviço), não um infortúnio pontual — carregar outra vez
   * bate na mesma guarda. Persiste no mesmo objeto `gate` que a página usa para
   * o duplo envio, por isso vive aqui e não num `useState`.
   */
  readonlyRefused?: boolean;
}

export function isKillRequestInFlight(gate: KillRequestGate): boolean {
  return gate.inFlight === true;
}

/** Abre a guarda. Síncrono, no topo do handler. */
export function beginKillRequest(gate: KillRequestGate): void {
  gate.inFlight = true;
}

/** Fecha a guarda. Tem de correr num `finally`: uma exceção não pode deixar o gestor bloqueado. */
export function endKillRequest(gate: KillRequestGate): void {
  gate.inFlight = false;
}

/** O desfecho devolvido a uma confirmação que a guarda já tinha barrado. */
export const KILL_REQUEST_ALREADY_IN_FLIGHT: KillOutcome = {
  status: "unavailable",
  pid: 0,
  success: false,
  message: null,
};

/** O desfecho devolvido a uma ação que a fronteira já tinha recusado. */
export const KILL_REQUEST_READONLY_REFUSED: KillOutcome = {
  status: "unavailable",
  pid: 0,
  success: false,
  message: KILL_READONLY_UNAVAILABLE,
};

/**
 * Este desfecho é a recusa nomeada (e não um `unavailable` de duplo envio, que
 * vem sem mensagem)? É o que decide se a guarda fica travada para a montagem.
 */
export function isReadonlyKillRefusal(outcome: KillOutcome): boolean {
  return outcome.status === "unavailable" && outcome.message === KILL_READONLY_UNAVAILABLE;
}

export interface RunKillRequestOptions extends RunKillProcessOptions {
  /** Guarda síncrona do fluxo. Sem ela, cada clique no mesmo turno é um pedido. */
  gate: KillRequestGate;
  /** Chamado uma vez com o desfecho real (só quando o pedido saiu). */
  onOutcome?: (outcome: KillOutcome) => void;
  /** Fecha o overlay/estado de curso. Corre SEMPRE, mesmo em exceção. */
  onFinish?: () => void;
  /** Snapshot autoritativo, quando aplicável. */
  refresh?: () => Promise<unknown> | void;
}

/**
 * Um pedido de kill, com guarda de duplo envio.
 *
 * 1 confirmação = 1 request. A guarda é testada **antes** de qualquer `await`,
 * por isso dois cliques no mesmo turno — que o `disabled` do botão não apanha,
 * porque o re-render só chega no turno seguinte — dão um só pedido.
 *
 * Não é debounce: não há temporizador nem espera. É uma bandeira que se abre e
 * se fecha no ciclo do próprio pedido.
 *
 * O `onFinish` corre no `finally`, para o estado de curso nunca ficar preso —
 * nem quando o `kill` lança, nem quando o serviço devolve `timeout`.
 */
export async function runKillRequest(options: RunKillRequestOptions): Promise<KillOutcome> {
  const { gate, onOutcome, onFinish, refresh, ...killOptions } = options;

  if (gate.readonlyRefused === true) {
    // A fronteira já recusou esta ação por nome. Repetir o pedido não é
    // re-testar nada: o main barra-o antes do serviço. Devolve-se o MESMO
    // desfecho honesto, sem `kill` e sem refetch (o Windows não mudou).
    //
    // A entrega é o ponto: a página limpa o aviso ANTES de chamar
    // (`TaskManagerPage.tsx:480`) e só o escreve dentro de `onOutcome` (`:498`).
    // Devolver sem entregar deixava a segunda tentativa muda — a mensagem certa
    // entregue ao sítio errado. `onFinish` corre porque é o contrato de fecho
    // de quem chama, não uma otimização.
    const recusado: KillOutcome = { ...KILL_REQUEST_READONLY_REFUSED, pid: killOptions.pid };
    onOutcome?.(recusado);
    onFinish?.();
    return recusado;
  }

  if (isKillRequestInFlight(gate)) {
    // Confirmação duplicada barrada. Não é um kill, logo não há desfecho de
    // kill a inventar: devolve-se um `unavailable` sem mensagem, e o primeiro
    // pedido continua a ser quem trata do resultado.
    return { ...KILL_REQUEST_ALREADY_IN_FLIGHT, pid: killOptions.pid };
  }

  beginKillRequest(gate);
  try {
    const outcome = await runKillProcess(killOptions);
    if (isReadonlyKillRefusal(outcome)) gate.readonlyRefused = true;
    onOutcome?.(outcome);
    if (shouldRefetchAfterKill(outcome)) void refresh?.();
    return outcome;
  } finally {
    endKillRequest(gate);
    onFinish?.();
  }
}

const TIMEOUT_SENTINEL = { timedOut: true } as const;

/**
 * Corre o kill com prazo máximo. **Nunca rejeita**: devolve sempre um
 * {@link KillOutcome}, para que quem chama possa fechar o overlay no `finally`.
 */
export async function runKillProcess({
  pid,
  kill,
  timeoutMs = KILL_TIMEOUT_MS,
}: RunKillProcessOptions): Promise<KillOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
    });

    const raced = await Promise.race<unknown>([
      kill(pid).then((result) => result as unknown),
      timeout,
    ]);

    if (raced === TIMEOUT_SENTINEL) {
      return { status: "timeout", pid, success: false, message: KILL_TIMEOUT_ERROR };
    }

    return mapKillResult(raced as ProcessKillResult);
  } catch (erro) {
    // A recusa da fronteira não é um terminate falhado: é um `unavailable` com
    // uma mensagem que diz que nada foi morto. Qualquer outra exceção
    // continua `failed` — não se dilui uma avaria real numa indisponibilidade.
    if (classifyKillRejection(erro) === "dev_windows_readonly") {
      return { status: "unavailable", pid, success: false, message: KILL_READONLY_UNAVAILABLE };
    }
    return { status: "failed", pid, success: false, message: KILL_ERROR_ERROR };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Snapshot autoritativo nos desfechos em que o processo pode ter mudado:
 * `killed`/`already-exited` (a linha deve sair da lista) e `timeout` (o estado
 * real é desconhecido). `alias-stub` também: o serviço já tirou o PID morto do
 * cache e o processo REAL (outro PID) tem de aparecer. `reused`: o serviço
 * tirou a entrada do dono antigo — sem refetch a linha ficaria a mostrar um
 * processo que já não é aquele.
 * `protected`/`failed` não mexeram no processo que a UI mostrou.
 */
export function shouldRefetchAfterKill(outcome: KillOutcome): boolean {
  return (
    outcome.status === "killed" ||
    outcome.status === "already-exited" ||
    outcome.status === "timeout" ||
    outcome.status === "alias-stub" ||
    outcome.status === "reused"
  );
}

// ── Atualização da LISTA de processos (medido, não chutado) ──────────────────
// Números medidos nesta máquina (Node 24, 390 processos, PowerShell + CIM):
//   · custo de UMA enumeração do SO (snapshotProcesses) = mediana 591 ms,
//     máximo 652 ms (medido em 2026-09-30: 652, 284, 574, 582, 591, 594 ms)
//   · cadência de DESCOBERTA no serviço = 2 000 ms enquanto há observador,
//     10 000 ms em repouso (cadência adaptativa, não uma constante única)
//
// Duas consequências, uma por constante:
// · ESTE poll é um pedido IPC de LEITURA DE CACHE. NÃO é uma enumeração do SO.
//   Quem decide o ritmo de enumerar é o cadence adaptativo do serviço, não a
//   frequência com que perguntamos. Com o serviço a marcar observador a cada
//   pedido, o cache tem sempre ~2 s de idade, muito abaixo do TTL de 20 s: o
//   serviço responde de CACHE e não força enumeração nenhuma.
//   Por isso baixar este número de 10 s para 2 s custa APENAS tráfego IPC de
//   leitura (de 6 para 30 pedidos por minuto), e a custo de CPU ZERO.
//   Se este número ficar mais lento do que o do serviço, o renderer passa a
//   ler a verdade atrasado — que era o furo: o serviço descobria o processo em
//   ~2,1 s e o ecrã só o mostrava ~5 s depois, em média.
// · a janela de rajada tem de ser pequena ao ponto de ser invisível ao
//   utilizador e pequena face a uma enumeração: 250 ms é 0,4× de uma
//   enumeração (591 ms). Agrupa a rajada inteira em UM pedido, sem acrescentar
//   latência que se note.

/**
 * Cadência do poll da lista enquanto a página de processos está aberta.
 *
 * Alinhada com o produtor: o serviço produz nova verdade de 2 em 2 segundos
 * enquanto há observador, e este é o único sítio onde o número vive — o App e a
 * TaskManagerPage importam daqui, não escrevem o seu próprio.
 */
export const PROCESSES_POLL_MS = 2_000;

/** Janela de agrupamento: uma rajada de eventos dá UM pedido de processos. */
export const PROCESSES_REFRESH_COALESCE_MS = 250;

/**
 * Duas cadências e uma razão: noutras páginas a lista é o PRODUTO (cada linha
 * conta), noutras é só a tabela que traduz PID → nome.
 *
 *   · produto (Gestor de Tarefas, Monitor): o ritmo do produtor, 2 s;
 *   · tradução (Segurança Empresarial): 10 s chega — pedir mais depressa publica
 *     as MESMAS linhas e volta a serializá-las pelo cano.
 *
 * Porque isto existe: o painel empresarial tinha um `getProcesses` próprio de 5 s
 * em paralelo com o poll do App. A mesma consulta com dois donos, dois ritmos e
 * duas noções de frescura — e era esse caminho privado que carimbava «Atualizado»
 * com o relógio do cliente. Um dono só, com o ritmo declarado por página.
 */
export const PROCESSES_ENRICHMENT_POLL_MS = 10_000;

/** Página → ritmo. Página fora daqui não mostra processos e não pede nada. */
const PAGINAS_DE_PROCESSOS = new Map<string, number>([
  ["taskmanager", PROCESSES_POLL_MS],
  ["monitor", PROCESSES_POLL_MS],
  ["business", PROCESSES_ENRICHMENT_POLL_MS],
]);

/**
 * O ritmo a que o renderer pede a lista nesta página, ou `null` quando a página
 * não mostra processos. É a única resposta: o App não decide cadência à parte.
 */
export function processosPollMs(pagina: string): number | null {
  return PAGINAS_DE_PROCESSOS.get(pagina) ?? null;
}

/**
 * Eventos cujo tema é a LISTA de processos. Pedem UM pedido (processes), nunca
 * o snapshot completo de 7: um `process.started` não tem nada a dizer sobre
 * ameaças, ligações, quarentena ou PC state.
 */
export function isProcessesEvent(type: string): boolean {
  return type.startsWith("process.");
}

/** O que um evento obriga o renderer a fazer. Uma decisão, um sítio. */
export type EventRefreshRoute = "processes" | "snapshot" | "none";

/**
 * Tabela de rota de um evento de segurança. A regra é por PREFIXO, não por
 * enumeração: assim nenhum evento `process.*` pode cair em `snapshot` por
 * esquecimento de uma linha, e o invariant é verificável sem DOM.
 *
 * Porquê o prefixo: o poll inicial do serviço emite ~180 `process.started` de
 * uma vez (medido), e cada um custava um snapshot completo de 7 pedidos IPC.
 * `process.blocked` também cai aqui — passa a pedir a lista, não o snapshot
 * completo; o aviso de "bloqueado" é mostramdo na mesma, porque o toast vive
 * antes desta rota.
 */
export function resolveEventRefresh(eventType: string): EventRefreshRoute {
  if (eventType === "scan.progress") return "none";
  // Observations and per-file outcomes already reach the history subscription.
  // Findings/confirmed actions have their own events that refresh the snapshot.
  if (["file.created","file.modified","file.deleted","file.renamed","artifact.analyzed","quarantine.requested"].includes(eventType)) return "none";
  if (isProcessesEvent(eventType)) return "processes";
  return "snapshot";
}

export interface ProcessesRefreshGate {
  /** Já há um `getProcesses` em voo: sobrepor seria trabalho deitar fora. */
  inFlight: boolean;
  /** Janela visível: com a aba escondida não há enumeração para fazer. */
  visible: boolean;
  /** A app está a encerrar: o bridge já pode estar desligado. */
  shuttingDown: boolean;
  /** Quando foi pedido o último refresh (coalescing). */
  lastRequestedAt: number;
  now: number;
  /** `@default` PROCESSES_REFRESH_COALESCE_MS */
  coalesceMs?: number;
}

/**
 * Decide se vale a pena pedir a lista agora. Três guardas e a janela: in-flight
 * (não duplica trabalho), aba escondida, shutdown, e a janela de rajada (a
 * segunda e a terceira ondas de uma rajada esperam pela primeira).
 */
export function shouldRefreshProcessesNow(gate: ProcessesRefreshGate): boolean {
  if (gate.inFlight || !gate.visible || gate.shuttingDown) return false;
  const window = gate.coalesceMs ?? PROCESSES_REFRESH_COALESCE_MS;
  return gate.now - gate.lastRequestedAt >= window;
}

/** Tira da lista os PIDs já decididos localmente (a linha some no instante). */
export function withoutPids<T extends { pid: number }>(rows: readonly T[], pids: readonly number[]): T[] {
  if (pids.length === 0) return rows as T[];
  return rows.filter((row) => !pids.includes(row.pid));
}

/**
 * Quais das remoções locais já foram confirmadas pelo snapshot autoritativo.
 * Quando o serviço devolve a lista e o PID já lá não está, a verdade chegou:
 * a remoção local pode ser esquecida e deixa de ser um filtro permanente.
 */
export function pidsConfirmedGone(rows: readonly { pid: number }[], removed: readonly number[]): number[] {
  const present = new Set(rows.map((row) => row.pid));
  return removed.filter((pid) => !present.has(pid));
}

/**
 * O kill ficou TERMINAL para o processo? Só nestas duas a linha pode sair já:
 * `killed` (o Windows confirmou a morte) e `already-exited` (o objetivo — não
 * estar em execução — está atingido). `timeout` é desconhecido, `reused` é
 * outro processo: em nenhum dos dois se pode apagar a linha.
 */
export function isTerminalKillOutcome(outcome: KillOutcome): boolean {
  return outcome.status === "killed" || outcome.status === "already-exited";
}
