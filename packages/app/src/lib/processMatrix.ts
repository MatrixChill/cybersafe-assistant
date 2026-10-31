import type { ProcessIntelligenceContext, ProcessSnapshot } from '@cybersafe/shared-types';
import type { ProcessDiagnostic } from './processIntelligence';

function processName(name: string): string {
  return name.split(/[\\/]/).pop()?.replace(/[\r\n\u0000-\u001f]/g, '').slice(0, 80) || 'Processo';
}

/** Percentagem medida para leitura humana; não é um juízo de valor. */
function percentagemMedida(numerador: number, denominador: number): string {
  return `${((numerador / denominador) * 100).toFixed(1).replace('.', ',')}%`;
}

/**
 * INSTANTE DO CONTRATO — ISO-8601 com milissegundos, exactamente o que
 * `Date#toISOString()` publica e o que a API valida.
 *
 * A fonte Windows (`CreationDate.ToUniversalTime().ToString('o')`) traz SETE
 * casas decimais (precisão de 100 ns). Enviá-las tal e qual fazia o validador
 * recusar TODO o contexto com 400 antes de chegar ao fornecedor — a falha
 * humana de 2026-10-23, com o WmiPrvSE.exe 15112 e com a pergunta geral da
 * máquina. Converter aqui normaliza a REPRESENTAÇÃO (o milissegundo é a
 * precisão que a app consegue comparar), não apaga a medição.
 *
 * Sem instante legível devolve `null`: uma identidade que não se lê não pode
 * passar como texto arbitrário (o placeholder `now` da fonte, em ms epoch, era
 * outro 400 à espera). Quem não tem instante continua a ter pid/nome/Working
 * Set; perde só a tendência, que exige identidade estável.
 */
export function instanteDoContrato(valor: string | null | undefined): string | null {
  if (!valor) return null;
  const ms = Date.parse(valor);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Resposta local quando a INSTÂNCIA pedida já não existe. Uma definição só,
 * usada pelo diagnóstico local imediato e pelo fluxo de envio: um PID
 * reutilizado é outra instância e não se substitui em silêncio.
 */
export function buildIdentityLostReply(pid: number | null | undefined, estado: "sumido" | "reutilizado"): string {
  return estado === "sumido"
    ? `**INSTÂNCIA FORA DAS MEDIÇÕES**\n\nO processo pedido (PID ${pid}) já não está nas medições atuais. Não o substituo por outro processo com o mesmo número — um PID reutilizado é outra instância. A IA generativa não foi utilizada.`
    : `**PID REUTILIZADO**\n\nA instância mostrada (PID ${pid}) já não existe; o Windows reatribuiu o número a outra instância. Sem a identidade original não há diagnóstico desta amostra. A IA generativa não foi utilizada.`;
}

/**
 * CPU por processo: a janela de amostragem pode exceder 100 % (o delta de tempo
 * de CPU inclui a leitura do CIM), e o diagnóstico já trata isso como «sem
 * leitura». O processo ESCOLHIDO passa pela mesma regra — ter duas regras era
 * como o mesmo número passava no top5 e era recusado no alvo.
 */
export function cpuDoContrato(valor: number | null | undefined): number | null {
  return typeof valor === "number" && Number.isFinite(valor) && valor >= 0 && valor <= 100 ? valor : null;
}

/** Explicit allowlist: never spread a ProcessSnapshot into an outbound payload. */
export function buildProcessMatrixContext(diagnostic: ProcessDiagnostic, selectedPid?: number, selected?: ProcessSnapshot): ProcessIntelligenceContext {
  const medidos = diagnostic.topProcesses.slice(0, 5).map(p => ({
    pid: p.pid, name: processName(p.name), startedAt: instanteDoContrato(p.startedAt),
    cpuPercent: cpuDoContrato(p.cpuPercent), workingSetMb: p.workingSetMb,
  }));
  const alvo = selected && selected.pid === selectedPid ? {
    pid: selected.pid, name: processName(selected.name), startedAt: instanteDoContrato(selected.startedAt),
    cpuPercent: cpuDoContrato(selected.cpu),
    workingSetMb: Number.isFinite(selected.memoryMb) && selected.memoryMb >= 0 ? selected.memoryMb : null,
  } : medidos.find(p => p.pid === selectedPid) ?? null;
  // PRIVACIDADE POR ALVO: quando a explicação é de UMA instância, o payload
  // não pode levar o Top5 inteiro só porque a pessoa autorizou esse alvo. Os
  // outros processos continuam em casa; RAM/CPU globais são o contexto que o
  // âmbito explícito permite. Sem alvo explícito (pergunta da máquina), o Top5
  // mantém-se — é outro âmbito, não uma autorização para juntar alvos.
  const topProcesses = selectedPid === undefined ? medidos : alvo ? [alvo] : [];
  return {
    version: 1, measuredAt: diagnostic.measuredAt,
    ram: {totalMb: diagnostic.ram.totalMb, usedMb: diagnostic.ram.usedMb, availableMb: diagnostic.ram.availableMb},
    cpuPercent: diagnostic.cpuPercent, topProcesses,
    selectedProcess: alvo,
    // A comparação é feita sobre o instante CANÓNICO dos dois lados: bruto vs
    // bruto perdia a tendência quando a fonte e a amostra diferissem só na
    // representação, e o validador exige que a tendência aponte para uma
    // instância presente no payload.
    //
    // Sem instante legível NÃO há série: comparar `null === null` fazia uma
    // tendência sem identidade passar como se fosse daquele processo — inventar
    // tendência a partir da ausência de início. O validador exige instante nas
    // duas pontas e continua igual.
    trends: diagnostic.trends.flatMap(t => {
      const inicio = instanteDoContrato(t.startedAt);
      if (!inicio) return [];
      const pertence = topProcesses.some(p => p.pid === t.pid && p.startedAt === inicio)
        || (alvo !== null && alvo.pid === t.pid && alvo.startedAt === inicio);
      if (!pertence) return [];
      return [{
        pid: t.pid, startedAt: inicio, previousMb: t.previousMb, currentMb: t.currentMb,
        deltaMb: t.deltaMb, intervalMs: t.intervalMs, samples: t.samples,
      }];
    }).slice(0, 5),
    limitations: diagnostic.limitations.slice(0, 8).map(s => s.slice(0, 240)),
  };
}

export function matrixTelemetryContext(context: string, consent: boolean): string {
  return consent ? context : '';
}

/**
 * ALVO do consentimento. A linha de consentimento autoriza «o estado de proteção,
 * CPU/RAM, nomes de processos, Working Set e tendências» — mas «Explicar na
 * MATRIX» é sempre sobre UMA instância concreta (pid + instante da amostra). Sem
 * registo do alvo, marcar a caixa para um processo e depois clicar noutro
 * reaproveitava a autorização anterior para enviar as medições de outro alvo ao
 * fornecedor. Comparação por identidade congelada no clique, não por PID isolado
 * (o Windows reutiliza PIDs).
 */
export type AlvoProcesso = { pid: number | null; startedAt: string | null };

export function alvoDeExplicacao(pedido?: { pid?: number | null; startedAt?: string | null } | null): AlvoProcesso | null {
  if (!pedido) return null;
  return { pid: pedido.pid ?? null, startedAt: pedido.startedAt ?? null };
}

export function mesmoAlvo(a: AlvoProcesso | null, b: AlvoProcesso | null): boolean {
  if (a === null || b === null) return a === b;
  return a.pid === b.pid && (a.startedAt ?? null) === (b.startedAt ?? null);
}

/** Consentimento só vale para o alvo em que foi dado. */
export function consentValeParaAlvo(consentido: AlvoProcesso | null, actual: AlvoProcesso | null): boolean {
  return consentido !== null && mesmoAlvo(consentido, actual);
}

/** Rótulo da privacidade no painel: distingue «autorizado» de «autorizado noutro alvo». */
export function rotuloDeConsentimento(ligado: boolean, consentido: AlvoProcesso | null, actual: AlvoProcesso | null): string {
  if (!ligado) return 'não autorizado';
  if (consentValeParaAlvo(consentido, actual)) return 'autorizado para este alvo';
  return 'autorizado noutro alvo';
}

/**
 * Explicação pedida e AINDA não enviada, à espera de autorização para o alvo
 * concreto. Guarda o texto e o alvo do momento do clique: é isto que permite
 * autorizar e obter a resposta da pergunta que a pessoa já fez, em vez de a
 * obrigar a escrever tudo outra vez.
 */
export type PendenteExplicacao = {
  id: number;
  pid: number | null;
  startedAt: string | null;
  texto: string;
  alvo: AlvoProcesso;
};

/**
 * A identidade da instância pedida perdeu-se. Uma definição só, usada pelo efeito
 * de «Explicar» e pelo envio: se o PID sumiu ou foi reatribuído, não há
 * autorização que faça sentido pedir — nem reenvio que se possa prometer.
 */
export function identidadeDeExplicacaoPerdida(
  pedido: { pid?: number | null } | null | undefined,
  identidade: string,
): boolean {
  return pedido?.pid !== undefined && (identidade === 'sumido' || identidade === 'reutilizado');
}

/**
 * Retomar o pedido pendente depois de autorizar — UMA vez.
 *
 * As duas condições que importam, e que o clique não pode contornar:
 *  - a autorização tem de valer para o ALVO do pedido, não apenas «a caixa está
 *    marcada». Autorizar o processo B não envia as medições de A, e o mesmo PID
 *    reatribuído a outra instância também não é o mesmo processo;
 *  - `jaConsumido` é o `id` já retomado: sem ele, cada re-render a seguir à
 *    autorização reenviava a mesma pergunta ao fornecedor.
 */
export function deveReenviarExplicacaoAposAutorizacao(
  pendente: PendenteExplicacao | null | undefined,
  estado: {
    consentimentoEfectivo: boolean;
    alvoAutorizado: AlvoProcesso | null;
    identidadePerdida: boolean;
    jaConsumido: number | null;
  },
): boolean {
  if (!pendente) return false;
  if (estado.identidadePerdida) return false;
  if (estado.jaConsumido === pendente.id) return false;
  if (!estado.consentimentoEfectivo) return false;
  return consentValeParaAlvo(estado.alvoAutorizado, pendente.alvo);
}

/** Campos de consentimento que o chat pode transportar. Estrutural para não
 *  prender `processMatrix` ao cliente HTTP; a decisão de QUEM os fornece vive
 *  em `matrixExternalConsent`/`AIAssistant`. */
export type ProcessConsentFields = {
  consentProviderKey?: string;
  consentGrantId?: string;
  consentAuthorization?: string;
  processConsent?: true;
};

export type ProcessPayload = {
  processIntelligence?: ProcessIntelligenceContext;
  processConsent?: true;
  consentProviderKey?: string;
  consentGrantId?: string;
  consentAuthorization?: string;
};

/**
 * Payload do chat de processos.
 *
 * Sem terceiro argumento mantém a forma legada de 2 argumentos (os harnesses
 * antigos dependem dela). Com terceiro argumento, a cablagem é UMA:
 *  - grant persistente: `processIntelligence` + `consentProviderKey` +
 *    `consentGrantId`, nunca `processConsent`;
 *  - oferta A (R2): `processIntelligence` + `consentProviderKey` +
 *    `consentAuthorization` (token do POST one-shot), nunca `processConsent`
 *    nem `consentGrantId`;
 *  - sem autorização para este envio: só `consentProviderKey`, sem medições.
 *
 * Se sinais concorrentes chegarem juntos, o payload transporta UMA autoridade:
 * o token one-shot vence o grant, e o grant vence a flag legada. O servidor
 * recusa os dois canais (`process_consent_ambiguous`); o cliente não os produz.
 * A flag legada só sobrevive no caminho de 2 argumentos, para harnesses antigos;
 * nunca é o caminho de envio da UI.
 */
export function processPayload(
  context: ProcessIntelligenceContext | null,
  consent: boolean,
  consentFields?: ProcessConsentFields,
): ProcessPayload {
  if (!context || !consent) return {};
  if (consentFields === undefined) return {processIntelligence: context, processConsent: true};

  const payload: ProcessPayload = {};
  if (consentFields.consentAuthorization) {
    payload.processIntelligence = context;
    if (consentFields.consentProviderKey) payload.consentProviderKey = consentFields.consentProviderKey;
    payload.consentAuthorization = consentFields.consentAuthorization;
    return payload;
  }
  if (consentFields.consentGrantId || consentFields.processConsent === true) {
    payload.processIntelligence = context;
  }
  if (consentFields.consentProviderKey) payload.consentProviderKey = consentFields.consentProviderKey;
  if (consentFields.consentGrantId) payload.consentGrantId = consentFields.consentGrantId;
  else if (consentFields.processConsent === true) payload.processConsent = true;
  return payload;
}

/**
 * Histórico para o fornecedor. Sem terceiro argumento mantém o filtro booleano
 * antigo (compatibilidade com chamadas/testes existentes); com `alvoAutorizado`
 * — mesmo `null` — aplica a privacidade POR ALVO. O caminho de envio passa
 * sempre o alvo, para não voltar a haver um filtro que não distingue A de B.
 */
export function processChatHistory<T extends {role: string; content: string; privateProcessData?: boolean; privateTarget?: AlvoProcesso | null}>(
  history: T[],
  consent: boolean,
  /**
   * Terceiro argumento presente = filtro POR ALVO (o caminho de envio).
   * Ausente = comportamento antigo, mantido para chamadas/testes que ainda não
   * passam identidade. Nunca usar a forma ausente para enviar ao fornecedor.
   */
  alvoAutorizado?: AlvoProcesso | null,
): Array<{role: string; content: string}> {
  // O consentimento é a primeira porta: `false` exclui TODO o privado, mesmo
  // que um alvo tenha sido passado por engano. O ramo por alvo não pode ser
  // uma segunda autoridade que se sobreponha a esta.
  if (!consent) return processChatHistoryParaAlvo(history, null);
  // Terceiro argumento PRESENTE (mesmo `undefined`) entra no modo por alvo e
  // falha fechado sem identidade. A forma de 2 argumentos só existe para
  // chamadas antigas que não são o caminho de envio; `AIAssistant` passa sempre
  // os três e o teste de cablagem fixa isso.
  if (arguments.length >= 3) return processChatHistoryParaAlvo(history, alvoAutorizado ?? null);
  return history.filter(message => consent || !message.privateProcessData)
    .map(({role, content}) => ({role, content}));
}

/**
 * Identidade CANÓNICA de um alvo para o histórico privado: PID + instante de
 * início. A fonte Windows publica 7 casas e o contrato usa 3; comparar o texto
 * bruto perderia a mesma instância. `null` num processo NÃO prova identidade
 * (sem início legível não há como distinguir uma reutilização de PID). «Esta
 * máquina» é o único alvo com `pid === null`, e esse é explícito.
 */
export function mesmoAlvoCanonico(a: AlvoProcesso | null | undefined, b: AlvoProcesso | null | undefined): boolean {
  if (!a || !b) return false;
  if (a.pid !== b.pid) return false;
  if (a.pid === null) return true;
  const inicioA = instanteDoContrato(a.startedAt);
  const inicioB = instanteDoContrato(b.startedAt);
  return inicioA !== null && inicioA === inicioB;
}

/**
 * Histórico para o fornecedor com PRIVACIDADE POR ALVO. Uma mensagem privada só
 * viaja se pertencer ao MESMO alvo autorizado (PID + instante canónico).
 * Mensagens sem `privateTarget` (versões antigas ou ausência de identidade) e
 * alvos `null` ficam de fora: falha fechada. As mensagens gerais são sempre
 * preservadas. O metadata local nunca é enviado: a saída tem só role/content.
 */
export function processChatHistoryParaAlvo<T extends {role: string; content: string; privateProcessData?: boolean; privateTarget?: AlvoProcesso | null}>(
  history: T[],
  alvoAutorizado: AlvoProcesso | null | undefined,
): Array<{role: string; content: string}> {
  return history
    .filter(message => !message.privateProcessData || mesmoAlvoCanonico(message.privateTarget ?? null, alvoAutorizado ?? null))
    .map(({role, content}) => ({role, content}));
}

export function isProcessQuestion(text: string): boolean {
  return /\b(ram|cpu|mem[oó]ria|processo[s]?|programa|chrome|firefox|msedge|memory compression|msmpeng(?:\.exe)?|lento|lentid[aã]o|encerrar|fechar|consum[oie]|working set)\b/i.test(text);
}

/**
 * A pergunta aponta ao alvo MEDIDO que está em causa?
 *
 * `isProcessQuestion` diz que a pergunta é do domínio de processos; NÃO diz que
 * o contexto selecionado lhe pertence. Sem esta segunda decisão, pedir «O Chrome
 * tem vários processos?» com o WmiPrvSE selecionado enviava as medições do WMI —
 * contexto por acidente. Só três sinais provam o alvo: PID explícito, nome do
 * processo em causa, ou uma referência deictica («este processo», «esta
 * instância»). Sem processo medido não há contexto a anexar; a explicação da
 * máquina tem o seu caminho explícito (`explainRequest`).
 */
export function perguntaApontaParaAlvo(
  texto: string,
  alvo: AlvoProcesso | null | undefined,
  nome?: string | null,
): boolean {
  if (!alvo || alvo.pid === null) return false;
  const baixo = String(texto ?? "").toLowerCase();
  if (!baixo) return false;
  if (new RegExp(`\\b(?:pid|processo)\\s*[:#]?\\s*${alvo.pid}\\b`, "i").test(baixo)) return true;
  const base = nome ? processName(nome).toLowerCase().replace(/\.exe$/i, "") : "";
  if (base.length >= 3) {
    const escapado = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^a-z0-9])${escapado}($|[^a-z0-9])`, "i").test(baixo)) return true;
  }
  return /\b(?:este|deste|desse|nesse|aquele|mesmo)\s+(?:processo|programa)\b|\besta\s+inst[âa]ncia\b|\bo\s+processo\s+em\s+causa\b/i.test(texto);
}

/* ==========================================================================
 * CONHECIMENTO TÉCNICO LOCAL, POR FAMÍLIA (TP-MATRIX-LOCAL-FIRST-20261023).
 *
 * O diagnóstico local já existia e é determinístico; o que faltava era dizer
 * alguma coisa ÚTIL sobre o processo em causa sem inventar função nem culpa.
 * Cada família traz: o que o processo é (hipótese técnica), o que é seguro
 * fazer, e o que continua por medir. Nada aqui afirma infeção por consumo,
 * nada soma processos por analogia de nome, e uma amostra nunca vira tendência.
 * Referências: documentação Microsoft (WMI/WmiPrvSE, Defender), documentação
 * dos próprios navegadores/apps sobre arquitetura multiprocesso. Sem pesquisa
 * extensa e sem dados do utilizador.
 * ======================================================================== */

export type FamiliaProcesso =
  | "memory-compression"
  | "defender"
  | "wmi"
  | "navegador"
  | "discord"
  | "cliente-jogos"
  | "ferramenta-ia"
  | "desconhecido";

// Fontes oficiais usadas apenas nas afirmações técnicas desta secção:
// - arquitetura multiprocesso do Chromium:
//   https://www.chromium.org/developers/design-documents/multi-process-architecture/
// - WmiPrvSE como anfitrião WMI e consumo elevado:
//   https://learn.microsoft.com/en-us/troubleshoot/windows-server/system-management-components/troubleshoot-wmi-high-cpu-issues
// O texto não vai além do que estas fontes sustentam; as restantes famílias
// dizem apenas o que o nome e a medição permitem.
const NAVEGADOR = /^(chrome|msedge|brave|opera|opera_gx|firefox|vivaldi|arc)\.exe$/i;
const CLIENTE_JOGOS = /^(steam|steamwebhelper|epicgameslauncher|battle\.net|riotclientservices|eadesktop|ubisoftconnect)\.exe$/i;
// Basenames exactos, não prefixos: "freebuff-updater.exe" ou "node.exe" não
// são a aplicação e não podem herdar a narrativa pelo nome.
const FERRAMENTA_IA = /^(freebuff|maestri)\.exe$/i;

/**
 * Família pelo NOME do executável; nomes com caminho são reduzidos ao base.
 *
 * Freebuff/Maestri só recebem narrativa quando a MESMA instância tem uma
 * tendência de >= 3 amostras. Isso prova estabilidade da instância, NÃO prova
 * que o software seja aquela ferramenta nem o que está a fazer: a narrativa
 * fala sempre em "basename reconhecido" e em "não confirmado". `node.exe` e
 * `electron.exe` são ambíguos e ficam sempre em `desconhecido`.
 */
export function familiaDoProcesso(nome: string, estabilidadeDaInstancia = false): FamiliaProcesso {
  const base = processName(nome).toLowerCase();
  if (base === "memory compression") return "memory-compression";
  if (base === "msmpeng.exe") return "defender";
  if (base === "wmiprvse.exe") return "wmi";
  if (NAVEGADOR.test(base)) return "navegador";
  if (base === "discord.exe" || base === "discordcanary.exe" || base === "discordptb.exe") return "discord";
  if (CLIENTE_JOGOS.test(base)) return "cliente-jogos";
  if (FERRAMENTA_IA.test(base)) return estabilidadeDaInstancia ? "ferramenta-ia" : "desconhecido";
  return "desconhecido";
}

/** Texto por família: hipótese técnica, acções seguras e o que falta medir. */
export function narrativaDaFamilia(familia: FamiliaProcesso): { explicacao: string; acoes: string; falta: string } {
  switch (familia) {
    case "memory-compression":
      return {
        explicacao: "Memory Compression é o gestor de memória do Windows que comprime páginas de memória menos usadas para reduzir paginação. O Working Set que observa inclui páginas partilhadas e limpas; um valor isolado não é o tamanho da memória comprimida, não confirma fuga, ameaça ou normalidade. Este é um componente do Windows; não encerrar.",
        acoes: "Não encerrar este componente. Se necessário, feche aplicações do utilizador (navegadores, editores) normalmente; observar.",
        falta: "Falta medir: memória comprimida efetiva, falhas de página/paginação, memória comprometida (commit), tendência de RAM. Working Set não é memória comprimida nem exclusiva; a soma dos processos não explica toda a RAM.",
      };
    case "defender":
      return {
        explicacao: "MsMpEng.exe pertence ao Microsoft Defender. A sua presença não confirma uma análise em curso; atividade de proteção é uma possível explicação, não medida aqui. Não encerrar nem desativar este componente.",
        acoes: "Não encerrar nem desativar o Microsoft Defender. Fechar aplicações do utilizador que já não sejam necessárias; observar mais amostras.",
        falta: "Falta medir: estado da proteção em tempo real e análise em curso (não medidos aqui). Working Set não é memória privada nem prova de análise. A soma dos processos não explica toda a RAM.",
      };
    case "wmi":
      return {
        explicacao: "WmiPrvSE.exe é o anfitrião de fornecedores WMI (Windows Management Instrumentation): responde a consultas de instrumentação e gestão pedidas por serviços e aplicações. As medições desta própria app usam WMI, por isso a atividade observada pode incluir medição. Consumo alto, por si, não é sinal de malware.",
        acoes: "Não encerrar: é um componente do Windows e outros serviços dependem dele. Se o consumo persistir, observar mais amostras e a que aplicações correspondem as consultas.",
        falta: "Falta medir: origem e número de consultas WMI, e a tendência da MESMA instância em amostras suficientes.",
      };
    case "navegador":
      return {
        explicacao: "Navegadores modernos separam separadores, extensões e processos auxiliares (GPU, rede, utilitários) em vários processos. O consumo pode vir de um separador ou de uma extensão; estas medições não dizem qual, e não atribuem culpa. Somar processos com o mesmo nome não transforma o total em memória do processo principal.",
        acoes: "Fechar separadores ou extensões que já não sejam necessários, um a um, e observar. Não encerrar processos do navegador às cegas: pode perder trabalho por guardar. Nada aqui sugere que o navegador esteja infetado.",
        falta: "Falta medir: consumo por separador/extensão (não exposto por estas medições) e memória privada por processo. Working Set inclui páginas partilhadas e não é atribuível a um único processo.",
      };
    case "discord":
      return {
        explicacao: "O Discord é uma aplicação construída sobre tecnologias web (Electron): corre vários processos (interface, renderização, GPU, áudio). Consumo de CPU/RAM pode vir de chamada, vídeo, sobreposição ou cache; estas medições não identificam qual, e não provam infeção.",
        acoes: "Se não estiver a ser usado, fechar a aplicação normalmente (guardar o que precisar). Desativar sobreposição ou vídeo ajuda a comparar; observar mais amostras.",
        falta: "Falta medir: consumo por processo do Discord (interface/render/GPU) e memória privada. Working Set não é memória exclusiva deste processo.",
      };
    case "cliente-jogos":
      return {
        explicacao: "Clientes de jogos (e jogos) usam CPU, GPU e memória de forma legítima enquanto estão a correr; carga alta durante o jogo é esperada e não é, por si, sinal de infeção. Estas medições não confirmam que é um jogo a correr nem qual.",
        acoes: "Fechar só depois de guardar o progresso; alguns jogos não guardam ao encerrar. Comparar com o jogo fechado para ver o que sobra.",
        falta: "Falta medir: uso de GPU por processo, memória privada e comportamento com o jogo fechado (AMOSTRAS da MESMA instância).",
      };
    case "ferramenta-ia":
      return {
        explicacao: "O basename do executável corresponde a Freebuff ou Maestri, ferramentas de desenvolvimento/automação: tarefas intensivas podem usar CPU e RAM, mas isto é uma correspondência de NOME; as amostras não confirmam que o software é aquela ferramenta nem a operação em curso, e não provam infeção.",
        acoes: "Não encerrar sem guardar o trabalho. Se o consumo coexistir com uma tarefa pesada, comparar com a aplicação em pausa; observar mais amostras da mesma instância.",
        falta: "Falta medir: assinatura/editor do executável, versão, linha de comando (nunca enviada), uso por thread/GPU e a operação concreta. Working Set não é memória privada nem exclusiva.",
      };
    default:
      return {
        explicacao: "Não há informação suficiente para atribuir uma função a este processo a partir das medições. Só os valores observados são factos: nome, PID, Working Set e CPU. Se corresponde a um jogo aberto, carga alta de CPU/GPU é esperada; a medição não o confirma. Consumo alto não é prova de malware.",
        acoes: "Não encerrar processos do sistema sem os identificar. Fechar aplicações do utilizador que já não sejam necessárias e observar; guardar trabalho antes de fechar.",
        falta: "Falta medir: assinatura/editor do executável, uso de GPU, memória privada e tendência da MESMA instância. Working Set não é memória privada nem exclusiva.",
      };
  }
}

export function buildProcessLocalReply(diagnostic: ProcessDiagnostic | null, selectedPid?: number, selected?: ProcessIntelligenceContext['selectedProcess']): string {
  if (!diagnostic) return '**DIAGNÓSTICO LOCAL**\n\n**INFORMAÇÃO INSUFICIENTE:** A recolher dados. Ainda não há medições disponíveis. A IA generativa não foi utilizada.';
  const chosen = selected ?? (selectedPid === undefined ? diagnostic.topProcesses[0] : diagnostic.topProcesses.find(p => p.pid === selectedPid));
  const observed = [`Medição: ${diagnostic.measuredAt}.`];
  const ram = diagnostic.ram;
  if (ram.usedMb !== null && ram.totalMb !== null) observed.push(`RAM utilizada: ${Math.round(ram.usedMb)} MB de ${Math.round(ram.totalMb)} MB.`);
  if (ram.availableMb !== null) observed.push(`RAM disponível: ${Math.round(ram.availableMb)} MB.`);
  if (diagnostic.cpuPercent !== null) observed.push(`CPU global: ${diagnostic.cpuPercent.toFixed(1)}%.`);
  /** Tendência da MESMA instância; também decide se o nome é suficiente para a narrativa condicional. */
  let tendenciaDaInstancia: ProcessDiagnostic['trends'][number] | undefined;
  if (chosen) {
    const ws = typeof chosen.workingSetMb === 'number' && Number.isFinite(chosen.workingSetMb) ? `${Math.round(chosen.workingSetMb)} MB` : 'sem leitura';
    const cpuPct = typeof chosen.cpuPercent === 'number' && Number.isFinite(chosen.cpuPercent) ? `${chosen.cpuPercent.toFixed(1)}%` : 'sem leitura';
    observed.push(`${processName(chosen.name)} (PID ${chosen.pid}): Working Set ${ws}; CPU ${cpuPct}.`);
    // A comparação é sobre a representação CANÓNICA dos dois lados: o
    // `selectedProcess` que o builder entrega já está normalizado (3 casas) e as
    // tendências do diagnóstico continuam no formato da fonte (7 casas). Igualdade
    // textual perdia uma tendência REAL da mesma instância. Sem instante canónico
    // NÃO se associa: `null` nunca prova identidade, e instantes diferentes na
    // precisão disponível são outra instância.
    const instanteChosen = instanteDoContrato(chosen.startedAt);
    const trend = instanteChosen === null
      ? undefined
      : diagnostic.trends.find(t => t.pid === chosen.pid && instanteDoContrato(t.startedAt) === instanteChosen);
    // Janela VÁLIDA: mesma instância (já filtrada), >= 3 amostras e intervalo
    // mínimo do contrato. Fora disso não há direção a afirmar.
    const trendValida = trend && trend.samples >= 3 && trend.intervalMs >= 30_000 ? trend : undefined;
    tendenciaDaInstancia = trendValida;
    if (trendValida) observed.push(`Working Set: ${Math.round(trendValida.previousMb)} → ${Math.round(trendValida.currentMb)} MB (${trendValida.deltaMb >= 0 ? '+' : ''}${Math.round(trendValida.deltaMb)} MB em ${Math.round(trendValida.intervalMs / 1000)} s, ${trendValida.samples} amostras).`);
    else observed.push('Tendência deste processo: A recolher dados. Uma amostra isolada não é tendência.');

    const totalMb = ram.totalMb;
    const totalFisico = typeof totalMb === 'number' && Number.isFinite(totalMb) && totalMb > 0 ? totalMb : null;
    const wsMedido = chosen.workingSetMb;

    // RESUMO CONTEXTUAL: uma frase que DECIDE com base no que foi medido —
    // fracção do Working Set, margem global e direção na janela válida. Não há
    // thresholds nem rótulos de leak/anormal/crítico; a comparação descreve a
    // amostra e não julga desempenho nem estabelece causa.
    const resumo: string[] = [];
    if (totalFisico === null) {
      resumo.push(typeof wsMedido === 'number' && Number.isFinite(wsMedido) && wsMedido >= 0
        ? 'sem total de RAM física, não há fracção do Working Set a calcular'
        : 'Working Set e total de RAM sem leitura nesta amostra');
    } else if (typeof wsMedido === 'number' && Number.isFinite(wsMedido) && wsMedido >= 0) {
      resumo.push(`Working Set = ${percentagemMedida(wsMedido, totalFisico)} da RAM física (inclui páginas partilhadas; não é memória exclusiva nem percentagem exclusiva do processo)`);
    } else {
      resumo.push('Working Set sem leitura nesta amostra, não há fracção a calcular');
    }
    if (totalFisico !== null && typeof ram.availableMb === 'number' && Number.isFinite(ram.availableMb) && ram.availableMb >= 0) {
      resumo.push(`RAM disponível = ${percentagemMedida(ram.availableMb, totalFisico)} do total`);
    } else if (typeof ram.availableMb === 'number' && Number.isFinite(ram.availableMb) && ram.availableMb >= 0) {
      resumo.push(`RAM disponível = ${Math.round(ram.availableMb)} MB (sem total de RAM física, não há percentagem a calcular)`);
    } else {
      resumo.push('sem leitura de RAM disponível nesta amostra, não se afirma folga');
    }
    if (trendValida) {
      const direcao = trendValida.deltaMb === 0
        ? 'ficou estável'
        : `${trendValida.deltaMb > 0 ? 'cresceu' : 'diminuiu'} ${Math.abs(Math.round(trendValida.deltaMb))} MB`;
      resumo.push(`na janela válida de ${Math.round(trendValida.intervalMs / 1000)} s (${trendValida.samples} amostras da MESMA instância), o Working Set ${direcao}; é uma comparação medida, não um juízo de desempenho nem uma causa`);
    } else {
      resumo.push('sem janela válida (menos de 3 amostras ou intervalo insuficiente), não se afirma direção nem se assume normalidade');
    }
    observed.push(`Resumo medido: ${resumo.join('; ')}.`);
  }
  else if (selectedPid !== undefined) observed.push('O processo selecionado não está nas medições disponíveis; não o substituí por outro.');
  const name = chosen ? processName(chosen.name).toLowerCase() : '';
  const familia = familiaDoProcesso(name, (tendenciaDaInstancia?.samples ?? 0) >= 3);
  const isMemoryCompression = familia === "memory-compression";
  const { explicacao: explanation, acoes: acoesSeguras, falta: faltaMedir } = narrativaDaFamilia(familia);
  const nomeBase = chosen ? processName(chosen.name).toLowerCase() : "";
  const relacionados = nomeBase ? diagnostic.topProcesses.filter(p => processName(p.name).toLowerCase() === nomeBase).length : 0;
  if (chosen && relacionados > 1) {
    // Só se afirma a RELAÇÃO que a medição sustenta: mesmo nome no top5. Não se
    // atribui a soma ao processo principal nem se assume hierarquia.
    observed.push(`${relacionados} processos com este nome nas medições disponíveis; a soma do Working Set não é memória exclusiva de um deles.`);
  }
  const ramObs = diagnostic.ram.availableMb !== null ? `RAM medida: ${Math.round(diagnostic.ram.availableMb)} MB disponível.` : 'RAM: sem leitura de RAM disponível — não é possível confirmar pressão com as métricas actuais.';
  const normalOuPreocupante = isMemoryCompression
    ? `Estado: **não concludente**. Working Set isolado não prova problema nem normalidade — pode variar com páginas residentes e a causa desta amostra é desconhecida. ${ramObs} Sem falhas de página, memória comprometida (commit) ou memória comprimida efetiva, a pressão não é confirmável a partir destes dados.`
    : diagnostic.ram.availableMb !== null
      ? `Estado: **não concludente**. ${ramObs} Pressão de memória não é confirmável a partir de Working Set isolado.`
      : `Estado: **não concludente**. RAM sem leitura de RAM disponível — pressão não é confirmável.`;
  const naoConfirmado = `${normalOuPreocupante}\n\nLimite: ${faltaMedir}`;
  const acaoSegura = [
    acoesSeguras,
    diagnostic.recommendations.join('\n') || 'Guardar o trabalho e observar mais amostras. Não encerrar processos críticos do Windows.',
  ].join('\n\n');

  return [
    '**DIAGNÓSTICO LOCAL** — explicação determinística, sem fornecedor externo e sem autorização de dados; a IA generativa não foi utilizada.',
    `**MEDIDO:**\n${observed.join('\n')}`,
    `**HIPÓTESE:** ${explanation}`,
    `**NÃO CONFIRMADO:**\n${naoConfirmado}`,
    `**AÇÃO SEGURA:**\n${acaoSegura}`,
  ].join('\n\n');
}

/* ==========================================================================
 * CONSENTIMENTO POR ALVO, com ambito, campos e duracao explicitos.
 * TP-MATRIX-HUMAN-FAIL-20261023.
 *
 * O gate humano mostrou o defeito: a caixa era um booleano da conversa. Marcar
 * para um processo e mudar de alvo deixava a caixa marcada enquanto o texto dizia
 * «autorizado noutro alvo» — duas verdades na mesma linha, e a pessoa sem forma de
 * saber se o que estava a ver estava coberto. A linha ficava tambem sem dizer O QUE
 * autoriza, quanto tempo vale, nem como se tira.
 *
 * O modelo passa a ser uma lista de alvos autorizados nesta conversa, cada um com a
 * hora em que foi concedido. Um alvo so conta se o pid E a instancia baterem (o
 * Windows reatribui numeros), e a autorizacao expira. Voltar a um alvo ainda valido
 * respeita o que foi dado; um alvo novo exige a propria.
 * ======================================================================== */

/** O que a linha de consentimento autoriza, dito por palavras. */
export const CAMPOS_AUTORIZADOS = [
  "estado de proteção",
  "CPU %",
  "RAM (total, usada, disponível)",
  "nomes de processos",
  "Working Set por processo",
  "tendências medidas (com amostras e intervalo)",
] as const;

/** O que NUNCA sai, mesmo autorizado. Negado por allowlist, não por confiança. */
export const CAMPOS_NUNCAS_AUTORIZADOS = [
  "caminhos de ficheiros",
  "linhas de comando",
  "nomes de utilizador",
  "conteúdo de janelas",
  "conteúdo de ficheiros",
] as const;

export type EscopoConsentimento = "nesta-conversa-por-alvo";

/** Âmbito e duração declarados, para a UI poder dizê-los em vez de implicar. */
export const AMBITO_CONSENTIMENTO: {
  escopo: EscopoConsentimento;
  duracaoMs: number;
} = {
  escopo: "nesta-conversa-por-alvo",
  // Uma conversa ativa raramente passa nisto; depois de meia hora sem usar, a
  // pergunta volta a ser feita em vez de se assentir num valor antigo.
  duracaoMs: 30 * 60 * 1000,
};

export type AutorizacaoAlvo = {
  alvo: AlvoProcesso;
  concedidoEm: number;
  /** Fornecedor NO MOMENTO da autorização; uma troca invalida-a (não é a chave). */
  fornecedor?: string | null;
};

/**
 * Autorizável é todo o alvo que existe: um processo (PID + instante) OU «esta
 * máquina», que é como se chama um alvo sem PID. `null` — nenhum alvo — não
 * autoriza nada.
 *
 * Porque é que `pid === null` conta: o cartão de consentimento escreve «(esta
 * máquina)» e oferece «Autorizar» precisamente nesse caso; recusar a entrada em
 * silêncio deixava o botão azer nada e o pedido pendente sem saída — que é o
 * género de contradição entre o que a UI mostra e o que a store guarda que este
 * pacote veio corrigir. As medições da máquina (CPU %, RAM, Top5) são exatamente
 * o que `CAMPOS_AUTORIZADOS` declara, por isso precisam de autorização também.
 */
function utilizavel(alvo: AlvoProcesso | null): alvo is AlvoProcesso {
  return alvo !== null;
}

/** Autoriza (ou renova) um alvo. Idempotente: reautorizar só move a hora. */
export function autorizarAlvo(
  lista: readonly AutorizacaoAlvo[],
  alvo: AlvoProcesso | null,
  agora: number,
  fornecedor?: string | null,
): AutorizacaoAlvo[] {
  if (!utilizavel(alvo)) return [...lista];
  return [
    ...revogarAlvo(lista, alvo),
    { alvo, concedidoEm: agora, ...(fornecedor === undefined ? {} : { fornecedor }) },
  ];
}

/** Revogável a qualquer momento, por alvo. */
export function revogarAlvo(
  lista: readonly AutorizacaoAlvo[],
  alvo: AlvoProcesso | null,
): AutorizacaoAlvo[] {
  return lista.filter((a) => !mesmoAlvo(a.alvo, alvo));
}

/**
 * Autorização ainda válida para ESTE alvo: identidade igual e dentro da duração.
 * É a única coisa que pode deixar um booleano de UI «ligado».
 */
export function autorizacaoValida(
  lista: readonly AutorizacaoAlvo[],
  alvo: AlvoProcesso | null,
  agora: number,
  fornecedorActual?: string | null,
): boolean {
  if (!utilizavel(alvo)) return false;
  return lista.some((a) => mesmoAlvo(a.alvo, alvo)
    && agora - a.concedidoEm < AMBITO_CONSENTIMENTO.duracaoMs
    // `undefined` = chamada antiga, sem identidade de fornecedor. O envio passa
    // sempre o valor actual (mesmo `null`) e uma troca deixa de autorizar.
    && (fornecedorActual === undefined || (a.fornecedor ?? null) === fornecedorActual));
}

/** Existe alguma autorização viva, nem que seja para outro alvo? Move o rótulo. */
export function existeAlgumaAutorizacao(
  lista: readonly AutorizacaoAlvo[],
  agora: number,
): boolean {
  return lista.some((a) => agora - a.concedidoEm < AMBITO_CONSENTIMENTO.duracaoMs);
}

/** Descarta o que expirou, para a lista não crescer à espera de nada. */
export function limparAutorizacoesExpiradas(
  lista: readonly AutorizacaoAlvo[],
  agora: number,
): AutorizacaoAlvo[] {
  return lista.filter((a) => agora - a.concedidoEm < AMBITO_CONSENTIMENTO.duracaoMs);
}

/** Texto da linha de privacidade, dito contra a lista e o alvo actual. */
export function rotuloDeAutorizacao(
  lista: readonly AutorizacaoAlvo[],
  alvoActual: AlvoProcesso | null,
  agora: number,
  fornecedorActual?: string | null,
): string {
  if (autorizacaoValida(lista, alvoActual, agora, fornecedorActual)) return "autorizado para este alvo";
  if (existeAlgumaAutorizacao(lista, agora)) return "autorizado noutro alvo — não vale para este";
  return "não autorizado";
}

/* ==========================================================================
 * E2E MATRIX (TP-MATRIX-FB2-E2E-20261023): o alvo do consentimento e o rótulo
 * do processo em causa. Vivia tudo dentro do componente, e as duas perguntas
 * ficaram sem resposta: a que alvo se refere uma autorização sem processo
 * escolhido, e o que diz o cabeçalho quando o pedido pendente é da máquina.
 * ======================================================================== */

/** Alvo de uma conversa sem processo escolhido: a própria máquina (pid null). */
export const ALVO_MAQUINA: AlvoProcesso = { pid: null, startedAt: null };

/**
 * O cartão de consentimento já oferecia «(esta máquina)»; a store recusava a
 * entrada em silêncio porque recebia `null`. Aqui a decisão é uma só: sem
 * processo em causa, autoriza-se a máquina — nunca «nenhum alvo».
 */
export function alvoParaConsentimento(alvo: AlvoProcesso | null): AlvoProcesso {
  return alvo ?? ALVO_MAQUINA;
}

/**
 * Uma linha que diz de que processo (ou da máquina) se está a falar. O pendente
 * manda: era o caso em que a barra dizia «sem processo» com uma autorização à
 * espera. Sem processo nenhum, diz «Conversa geral» em vez de negar o que está
 * à vista. Um PID sem amostra mantém-se visível e não é substituído.
 */
export function rotuloDoProcessoEmCausa(i: {
  pendente: { pid: number | null; startedAt?: string | null } | null;
  pedido: { pid?: number | null; startedAt?: string | null } | null;
  alvo: AlvoProcesso | null;
  nome?: string | null;
}): string {
  const temPedido = i.pedido !== null && i.pedido !== undefined;
  const pid = i.pendente
    ? i.pendente.pid
    : temPedido
      ? (i.pedido!.pid ?? null)
      : i.alvo
        ? i.alvo.pid
        : undefined;
  if (pid === undefined) return "Conversa geral";
  if (pid === null) return "Esta máquina · medições do PC";
  const nome = (i.nome ?? "").trim().slice(0, 48) || "Instância fora das medições";
  const inicio = i.pendente
    ? i.pendente.startedAt ?? null
    : temPedido && i.pedido!.pid === pid
      ? i.pedido!.startedAt ?? null
      : i.alvo?.pid === pid
        ? i.alvo.startedAt
        : null;
  return `${nome} · PID ${pid}${inicio ? ` · início ${inicio}` : " · início não confirmado"}`;
}
