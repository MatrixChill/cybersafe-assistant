import { verifyMatrixProvider } from "@/lib/matrixProviderStatus";
import { minimizeContextForAi } from "@/lib/aiContextBuilder";
import { getAuthToken } from "../lib/authSession";
import { MatrixConfigModal } from "./MatrixConfigModal";
import { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect, type PointerEvent as RPointerEvent, type KeyboardEvent as RKeyboardEvent } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { X, Send, Sparkles, MessageSquare, StopCircle, RefreshCw, MoreHorizontal, PanelLeft, PanelRight, Minimize2, Move, PinOff, Plus, KeyRound } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  answerLocalSecurityQuestion,
  cancelLocalSecurityRequest,
  shouldDiscardLateAnswer,
  isLocalSecurityQuestion,
} from "@/lib/localSecurityReply"
import { MatrixAvatar } from "./MatrixAvatar"
import { useAuth } from "@/contexts/AuthContext"
import { subscribeMatrixEscape } from "@/lib/matrixEscape"
import { matrixConfigLabelHonesto } from "@/lib/matrixStatusHonesto"
import { initialMatrixMessages, garantirSaudacao, acrescentarMensagem, isConversationStart, isNearBottom, matrixOriginLabel, matrixChatModeLabel, matrixChatModeDescription, respostaSemConhecimentoLocal, decisaoAposTentativaLocal, motivoDoEncaminhamentoLocal, originDaResposta, promptDeExplicacaoDeProcesso, deveAutoEnviarExplicacao, estadoDoMotivoLocal, estadoDoResultado, matrixRoutingStateLabel, type ConversationMessage, type MatrixRequestState, type MatrixChatMode } from "@/lib/matrixConversation"
import { estadoDoTransporte, alvoDePedido, descartarResposta, traceDePedido, codigoDeStatusHttp, mensagemDeRecusaDoFornecedor, bloqueioDeConsentimentoAplica, revalidarAntesDoEnvio, type IdentidadePedido } from "@/lib/matrixRequestMachine"
import {
  MATRIX_POS_KEY,
  MATRIX_MODE_KEY,
  DOCK_SLOT_PX,
  EDGE_INSET_PX,
  KEYBOARD_STEP_PX,
  clampPos,
  defaultPos,
  computeChatPanelPlacement,
  computeDockedChatPlacement,
  computeMinimizedPos,
  computeSidePanelPlacement,
  isDockGesture,
  movedEnoughToDrag,
  parseStored,
  parseStoredMode,
  projectPointerDrag,
  reservedBottomFromFooter,
  floatingLauncherClearance,
  serialize,
  type MatrixMode,
  type Point,
  type Pos,
  type Size,
} from "@/lib/matrixLauncherPosition"
import type { ProcessIntelligenceContext } from "@cybersafe/shared-types"
import type { ProcessDiagnostic, EstadoIdentidade } from "@/lib/processIntelligence"
import { buildProcessLocalReply, buildIdentityLostReply, isProcessQuestion, perguntaApontaParaAlvo, processPayload, processChatHistory, matrixTelemetryContext, alvoDeExplicacao, alvoParaConsentimento, mesmoAlvo, rotuloDoProcessoEmCausa, consentValeParaAlvo, rotuloDeConsentimento, identidadeDeExplicacaoPerdida, deveReenviarExplicacaoAposAutorizacao, autorizarAlvo, revogarAlvo, autorizacaoValida, limparAutorizacoesExpiradas, AMBITO_CONSENTIMENTO, CAMPOS_AUTORIZADOS, CAMPOS_NUNCAS_AUTORIZADOS, type AlvoProcesso, type PendenteExplicacao, type AutorizacaoAlvo } from "@/lib/processMatrix"
import {
  lerConsentimento,
  criarConsentimento,
  revogarConsentimento,
  pedirAutorizacaoUnica,
  alvoUnicoCanonico,
  autorizacaoUnicaValida,
  camposDeAutorizacaoUnicaNoChat,
  decidirConsentimentoDeEnvio,
  mesmosCamposDeConsentimento,
  codigoDeConsentimentoRecusado,
  mensagemDeConsentimento,
  notificarRevogacaoDeConsentimento,
  subscreverRevogacaoDeConsentimento,
  type MatrixExternalConsentRef,
  type MatrixConsentChatFields,
  type MatrixConsentMode,
  type MatrixOneShotAuthorization,
} from "@/lib/matrixExternalConsent"

/** A mensagem da conversa vive em `lib/matrixConversation.ts` (a mesma forma
    usada pela saudação/reset); aqui só se dá o nome curto que o componente já lia. */
type Message = ConversationMessage & {
  /** Alvo local da mensagem privada; nunca sai no payload (só filtra o histórico). */
  privateTarget?: AlvoProcesso | null
}

// SINCRONIZADO com `Page` exportado por Sidebar.tsx, mesma ordem. São dois
// unions duplicados e o App.tsx passa o valor do Sidebar para aqui: quando o
// histórico teve rota própria, isto caiu com TS2322 em App.tsx:917. A igualdade
// é fixada por test/r7-l3-history-ui.test.ts — mexer num sem o outro parte o
// typecheck da raiz em qualquer um dos sentidos.
type Page = "dashboard" | "pccenter" | "threats" | "quarantine" | "scanner" | "monitor" | "simulator" | "reports" | "taskmanager" | "otimizar" | "settings" | "business"

interface AIAssistantProps {
  currentPage?: Page
  context?: string
  processDiagnostic?: ProcessDiagnostic | null
  processContext?: ProcessIntelligenceContext | null
  explainRequest?: {id: number; pid?: number; startedAt?: string | null} | null
  /**
   * PACOTE C: identidade da explicação pedida, avaliada pelo App contra a
   * amostra atual. Se a instância sumiu ou o PID foi reutilizado, a resposta
   * diz isso — nunca substitui por outro processo, nunca inventa causa.
   */
  explainIdentity?: EstadoIdentidade
}

// S3: a API local só escuta em loopback IPv4 — usa-se 127.0.0.1 e nunca
// "localhost" (que pode resolver para ::1 sem listener).
const API_BASE = (typeof window !== "undefined" ? (window as unknown as { __CYBERSAFE_API_BASE__?: string }).__CYBERSAFE_API_BASE__ : undefined) || "http://127.0.0.1:4000"



// S3: as rotas privadas da API exigem o token da sessão. Lido a cada pedido
// (muda no login/logout) e só da sessão validada — nunca há credenciais
// embutidas no código do cliente.
function authHeaders(): Record<string, string> {
  try {
    const token = getAuthToken()
    return token ? { Authorization: `Bearer ${token}` } : {}
  } catch {
    return {}
  }
}
const MAX_HISTORY = 16
const STREAM_TIMEOUT_MS = 90_000
const MAX_RETRIES = 2

const PAGE_LABELS: Record<Page, string> = {
  dashboard: "Dashboard",
  pccenter: "PC Center",
  threats: "Ameaças",
  quarantine: "Quarentena",
  scanner: "Análise de Segurança",
  monitor: "Monitor",
  simulator: "Simulador de Phishing",
  reports: "Relatórios",
  taskmanager: "Task Manager",
  otimizar: "Otimizar",
  settings: "Configurações",
  business: "Business Center",
}

// Guardas locais para não depender do provider nos fallbacks cruciais.
const OFF_TOPIC_KEYWORDS = [
  "lasanha", "receita", "bolo", "cozinhar", "futebol", "campeonato", "jogo do", "golo",
  "história para", "redação", "poema", "música", "filme", "novela", "série", "receita",
  "temperatura do clima", "previsão do tempo", "polit", "eleição", "celebridade",
]
const DANGEROUS_KEYWORDS = [
  "criar malware", "fazer malware", "escrever malware", "ransomware que", "roubar credenciais",
  "phishing funcional", "invadir", "hackear o", "hackear o meu", "persistência maliciosa",
  "evadir antivírus", "bypass de segurança", "desativar o antivírus", "crackar", "cracking",
  "destruir dados", "apagar tudo o", "exploit", "exploração ofensiva", "keylogger",
]
const SECRET_PATTERN = /(?:senha|password|passwd|palavra[- ]?passe|token|api[ -]?key|chave)\s*[:=]\s*\S+/i

// Sugestões por página (a mais relevante em primeiro).
const SUGGESTIONS: Record<Page, { label: string }[]> = {
  dashboard: [
    { label: "Meu PC está seguro?" },
    { label: "Explica meu índice de proteção" },
    { label: "O que é phishing?" },
    { label: "Como melhorar minha segurança?" },
  ],
  quarantine: [
    { label: "O que acontece aos ficheiros em quarentena?" },
    { label: "É seguro restaurar um ficheiro isolado?" },
    { label: "Porque foi este ficheiro isolado?" },
  ],
  pccenter: [
    { label: "Meu disco está em 86% — devo me preocupar?" },
    { label: "O que significa meu índice de saúde?" },
    { label: "Como libertar espaço em disco?" },
    { label: "O firewall está ativo?" },
  ],
  threats: [
    { label: "O que significa esta ameaça?" },
    { label: "Devo apagar todos os eventos?" },
    { label: "Como funciona a quarentena?" },
    { label: "O que é um falso positivo?" },
  ],
  scanner: [
    { label: "O que é a Análise Rápida do Computador?" },
    { label: "Este ficheiro pode ser perigoso?" },
    { label: "Como funciona a análise de ficheiros?" },
    { label: "O que devo fazer após o scan?" },
  ],  monitor: [
    { label: "O que significa esta conexão?" },
    { label: "Como ler estes eventos?" },
    { label: "O que é a proteção residente?" },
    { label: "Devo bloquear este processo?" },
  ],
  simulator: [
    { label: "Por que este link é phishing?" },
    { label: "Como identificar emails falsos?" },
    { label: "Dá-me uma dica para o Simulador" },
    { label: "O que é engenharia social?" },
  ],
  reports: [
    { label: "Como exportar um relatório PDF?" },
    { label: "O que inclui o relatório?" },
    { label: "Como ler o score de proteção?" },
    { label: "O que são eventos de segurança?" },
  ],
  taskmanager: [
    { label: "Usei bastante CPU/RAM — é normal?" },
    { label: "Como identificar processo suspeito?" },
    { label: "O que fazer se um processo usa 100% CPU?" },
    { label: "Como monitorizar processos?" },
  ],
  otimizar: [
    { label: "O que devo otimizar primeiro?" },
    { label: "Por que meu PC está lento?" },
    { label: "Discos e temporários — o que posso apagar?" },
    { label: "Como melhorar o desempenho?" },
  ],
  settings: [
    { label: "O que é o tema Matrix Terminal?" },
    { label: "Como mudo o tema?" },
  ],
  business: [
    { label: "Explica as ligações desta página" },
    { label: "O que é uma ligação de rede?" },
    { label: "Como ler o Business Security Center?" },
  ],
}

const DEFAULT_SUGGESTIONS = SUGGESTIONS.dashboard

/**
 * Id opaco da conversa. Não é nome, nem caminho, nem hora legível: entra na
 * identidade do pedido para uma resposta da conversa anterior não cair nesta,
 * e é por isso que «conversa nova» tem de gerar um outro.
 */
function novaIdDeConversa(): string {
  return globalThis.crypto?.randomUUID?.() ?? `c${Date.now()}`
}

// Base de conhecimento local (FALLBACK educativo — preservada e alinhada à persona feminina).
const OFFLINE_KB: { keywords: string[]; answer: string }[] = [
  {
    keywords: ["phishing", "email falso", "email suspeito", "link falso", "este link"],
    answer: "**Phishing** é uma técnica onde atacantes enviam emails ou mensagens falsas para roubar dados. Para te proteger:\n\n- **Nunca cliques** em links de emails a pedir dados sensíveis\n- Verifica o remetente real (não apenas o nome exibido)\n- Acede a sites diretamente pelo navegador, não por links de emails\n- Desconfia de urgência excessiva ou ameaças\n\nSe suspeitares de um email, não cliques em nada e apaga-o ou marca-o como phishing."
  },
  {
    keywords: ["senha", "palavra-passe", "palavras-passe", "password", "forte", "fraca", "segura", "123456"],
    answer: "**Palavras-passe fortes** são a primeira linha de defesa:\n\n- **12+ caracteres** com letras, números e símbolos\n- Evita palavras do dicionário, datas ou nomes conhecidos\n- Usa uma **frase-passe** (ex.: `Cafe#Frio2026!`)\n- Ativa **2FA** sempre que possível\n- Usa um **gestor de palavras-passe** (Bitwarden, 1Password)\n\nPior, usar `123456` é deixar a chave de casa debaixo do tapete. Não vale a pena o risco."
  },
  {
    keywords: ["ransomware", "resgate", "criptografar", "encriptar"],
    answer: "**Ransomware** é malware que **criptografa os teus ficheiros** e exige resgate.\n\n**Como te proteger:**\n\n- **Backups regulares** (regra 3-2-1: 3 cópias, 2 mídias, 1 offsite)\n- Não abras anexos suspeitos\n- Mantém o sistema e apps atualizados\n- Ativa a **Proteção de Pasta** do Windows\n\nSe for vítima: **não pagues o resgate** — não há garantia de recuperação e financia o crime."
  },
  {
    keywords: ["2fa", "autenticação", "dois fatores", "mfa"],
    answer: "**2FA (Autenticação em 2 Passos)** adiciona uma segunda camada além da palavra-passe.\n\n- **App authenticator** (Google Authenticator, Authy) — mais seguro\n- **SMS** — melhor que nada, mas suscetível a SIM swap\n- **Hardware key** (YubiKey) — máxima segurança\n\nPrecisas? Tecnicamente ninguém te obriga. Mas se a palavra-passe vazar, o 2FA é o segurança da porta a dizer: 'hoje não, querido'."
  },
  {
    keywords: ["firewall", "rede", "wifi", "conexão", "vpn"],
    answer: "**Firewall e redes:**\n\n- Use **WPA3** ou no mínimo WPA2 (nunca WEP)\n- Evita redes públicas sem VPN\n- Desativa **sharing** de ficheiros e impressoras\n- Mantém o **firewall** ativo (verifica no PC Center)\n- Monitora as conexões no **Monitor** do CyberSafe\n\nA VPN criptografa a conexão, mas atenção à limitação: ela **não** protege contra phishing, malware ou más práticas — é só mais uma camada."
  },
  {
    keywords: ["cybersafe", "como usar", "funcionalidade", "ajuda", "quick scan", "scan"],
    answer: "**CyberSafe Assistant** funciona assim:\n\n- **Dashboard**: visão geral do sistema e alertas\n- **PC Center**: análise de hardware e saúde do Windows\n- **Ameaças**: histórico de eventos detectados\n- **Análise de Segurança**: análise rápida/profunda do computador ou de um ficheiro/pasta\n- **Task Manager**: monitorar processos\n- **Monitor**: conexões de rede e proteção\n- **Simulador**: exercícios práticos de phishing\n- **Otimizar**: recomendações de desempenho\n- **Relatórios**: resumo de segurança\n\nA **Análise Rápida do Computador** verifica as áreas de maior risco; a **Análise Profunda do Computador** percorre o sistema todo e demora mais."
  },
  {
    keywords: ["disco", "espaço", "lento", "desempenho", "86%", "temporários"],
    answer: "**Disco cheio / PC lento:**\n\nUm disco a **86%** não é emergência, mas já está a pedir socorro. Vale:\n\n- Libertar **ficheiros temporários** e de cache\n- Mover ficheiros grandes para um disco externo/cloud\n- Executar **Otimizar** no CyberSafe\n- Ver quais programas ocupam espaço em **Task Manager**\n\nAcima de 90% começa a afetar o desempenho do Windows."
  },
  {
    keywords: ["backup", "cópia", "certificar"],
    answer: "Backup é a tua rede de segurança:\n\n- Prefere a regra **3-2-1**: 3 cópias, 2 tipos de mídia, 1 fora de casa\n- Testa a **restauração** periodicamente — um backup que não restaura não serve\n- Mantém backups **desligados** depois do processo, para proteger contra ransomware\n\nProtege contra malware, falhas de disco e erros humanos."
  },
  {
    keywords: ["malware", "trojan", "spyware", "worm", "adware", "virus", "vírus"],
    answer: "Malware é software malicioso: **Trojan** finge ser legítimo, **Ransomware** criptografa ficheiros, **Spyware** espreita a atividade, **Worm** propaga-se sozinho, **Adware** mostra publicidade intrusiva.\n\nMantém o antivírus atualizado, só baixa software de fontes oficiais e usa a **Análise de Segurança** do CyberSafe para verificar ficheiros suspeitos."
  },
  {
    keywords: ["engenharia social", "social engineering", "golpe", "manipulação"],
    answer: "**Engenharia social** é manipular pessoas para obter acesso ou informações:\n\n- **Pretexto**: história falsa para convencer\n- **Baiting**: prometem algo em troca de dados\n- **Tailgating**: seguem alguém para áreas restritas\n- **Oferta irresistível**: prémios, urgência, medo\n\nDefende-te desconfiando do contacto não solicitado, verificando por outros canais e nunca fornecendo palavras-passe ou códigos por telefone/email."
  },
  {
    keywords: ["oi", "olá", "ola", "hello", "bom dia", "boa tarde", "boa noite", "tudo bem", "quem és", "quem é", "quem es", "quem e"],
    answer: "Sou a **Matrix**, a assistente de IA do **CyberSafe**.\n\nPosso ajudar-te com **phishing, malware, palavras-passe, privacidade, backups, ransomware** e a entender o teu painel. Pergunta o que quiseres!"
  },
]

// Fallback OT para fora-de-tema (variado, para não repetir sempre).
const OFF_TOPIC_REPLIES = [
  "Eu protejo os teus ficheiros — e a tua lasanha, não. Pergunta-me algo sobre segurança digital, o teu PC ou o CyberSafe.",
  "Se eu começar a prever isso, daqui a pouco estou a analisar a vida alheia em vez de malware. Fica comigo na cibersegurança.",
  "Posso proteger a tua redação contra perderes o ficheiro… escrevê-la já foge do meu turno. Manda uma questão sobre segurança ou CyberSafe.",
  "O meu domínio é cibersegurança, não campeonatos. Isso deixava o antivírus com ciúmes. Pergunta-me sobre o teu PC?",
]

// Fallback para pedidos perigosos (recurso defensivo, nunca as instruções).
const DANGER_REPLIES = [
  "Essa já entrou na zona 'a Matrix não quer receber visita da polícia'. Posso mostrar como **detetar, bloquear ou estudar** esse ataque de forma segura.",
  "Isso é linha ofensiva, e eu sou a guardiã do teu PC, não uma arma. Posso ajudar-te a **defender** — detetar, prevenir e analisar na horizontal.",
  "Não entro aí, mas posso ajudar-te a estudar **deteção e mitigação** num laboratório seguro. Proteger > atacar, sempre.",
]

function pickRandom(arr: string[]): string {
  return arr[Math.floor(Math.random() * arr.length)]
}

function offlineReply(input: string, page: Page, modo: MatrixChatMode = "online"): { content: string; isOffTopic?: boolean; isDanger?: boolean } {
  const lower = input.toLowerCase()

  if (SECRET_PATTERN.test(input)) {
    return {
      content: "**Atenção**: parece que colaste uma credencial (palavra-passe/chave). **Nunca** partilhes palavras-passe, tokens ou chaves API no chat — nem comigo. \n\nSe foi acidente, **revoga essa credencial** (troca a palavra-passe / regenera a chave) e usa um **gestor de palavras-passe**. Nenhum serviço legítimo te pede credenciais por chat.",
    }
  }

  if (DANGEROUS_KEYWORDS.some((kw) => lower.includes(kw))) {
    return { content: pickRandom(DANGER_REPLIES), isDanger: true }
  }

  if (OFF_TOPIC_KEYWORDS.some((kw) => lower.includes(kw))) {
    return { content: pickRandom(OFF_TOPIC_REPLIES), isOffTopic: true }
  }

  for (const entry of OFFLINE_KB) {
    if (entry.keywords.some((kw) => lower.includes(kw))) {
      return { content: entry.answer }
    }
  }

  // Fallback educacional com indicação de página — nunca repete a mesma coisa literal.
  const pageMap: Partial<Record<Page, string>> = {
    scanner: "Pergunta-me o que é a Análise Rápida do Computador ou como analisar um ficheiro suspeito.",
    pccenter: "Pergunta-me sobre o índice de saúde, disco ou firewall.",
    monitor: "Pergunta-me o que significa uma conexão ou evento no Monitor.",
    simulator: "Pergunta-me como identificar emails de phishing.",
    otimizar: "Pergunta-me sobre desempenho e disco.",
    taskmanager: "Pergunta-me sobre processos e CPU/RAM.",
  }
  const hint = pageMap[page]
  return {
    // A frase distingue a escolha «Local» de uma avaria real: o texto «não está
    // disponível» só pode aparecer quando o fornecedor falhou ou não existe.
    content: respostaSemConhecimentoLocal(modo, hint),
  }
}

// Markdown simples (negrito, itálico, links e listas).
function renderRich(text: string) {
  const blocks = text.split("\n\n")
  return blocks.map((block, bi) => {
    // lista
    if (/^\s*(?:[-*]|\d+\.)\s+/m.test(block)) {
      const rows = block.trim().split("\n").map((line) => {
        const isUl = /^\s*[-*]\s+/.test(line)
        const content = line.replace(/^\s*(?:[-*]|\d+\.)\s+/, "")
        return { isUl, content: renderInline(content) }
      })
      const isUl = rows[0]?.isUl
      return (
        <div key={bi} className={cn("flex flex-col gap-1")}>
          {rows.map((r, i) => (
            <div key={i} className="flex gap-1.5">
              <span className="text-primary shrink-0">{isUl ? "•" : `${i + 1}.`}</span>
              <span className="min-w-0">{r.content}</span>
            </div>
          ))}
        </div>
      )
    }
    return <div key={bi}>{renderInline(block)}</div>
  })
}

function renderInline(text: string) {
  const parts = text.split(/(\*\*.*?\*\*|\*.*?\*|`.*?`)/g)
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i} className="text-foreground">{part.slice(2, -2)}</strong>
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <em key={i} className="text-muted-foreground italic">{part.slice(1, -1)}</em>
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={i} className="px-1 rounded bg-black/30 font-mono text-cyber-green text-[11px]">{part.slice(1, -1)}</code>
    }
    return <span key={i}>{part}</span>
  })
}

export default function AIAssistant({ currentPage = "dashboard", context = "", processDiagnostic = null, processContext = null, explainRequest = null, explainIdentity = "semAlvo" }: AIAssistantProps) {
  const { user } = useAuth()
  /** Conta dona da conversa; uma troca de conta limpa o estado privado local. */
  const contaId = user?.id ?? null
  /** Espelho síncrono da conta autenticada: um `await` não pode ler a conta de um render antigo. */
  const contaIdRef = useRef<string | null>(contaId)
  contaIdRef.current = contaId
  const contaAnteriorRef = useRef<string | null>(contaId)
  const isOpenRef = useRef(false)
  const [isOpen, setIsOpenState] = useState(false)
  const [input, setInput] = useState("")
  const [messages, setMessages] = useState<Message[]>([])
  const [phase, setPhase] = useState<"idle" | "thinking" | "streaming" | "cancelling" | "error" | "rate_limited">("idle")
  const [mode, setMode] = useState<"online" | "local">("local")
  /**
   * ESCOLHA do utilizador, visível no cabeçalho. `mode` acima é a CONFIGURAÇÃO
   * observada (só passa a «online» depois de uma resposta concluída); esta é a
   * intenção: «Local» não contacta o fornecedor, «Online» permite o chat geral.
   * Nasce em local — a app não fala com o fornecedor sem escolha explícita.
   */
  const [modoConversa, setModoConversa] = useState<MatrixChatMode>("local")
  /** Rótulo do fornecedor devolvido pelo descriptor local — nunca a chave. */
  const [fornecedor, setFornecedor] = useState<string | null>(null)
  /** Chave estável do descriptor; é ela que liga a autorização ao fornecedor. */
  const [providerKey, setProviderKey] = useState<string | null>(null)
  /**
   * Estado externo (descriptor + grant) lido da API local. O ref é a leitura
   * síncrona do envio; o state é o que a UI mostra. Uma falha da API deixa ambos
   * sem grant: não há cache de aceitação nem fallback silencioso para one-shot.
   */
  const [consentimentoExterno, setConsentimentoExternoState] = useState<MatrixExternalConsentRef>({ descriptor: null, grant: null })
  const consentimentoExternoRef = useRef<MatrixExternalConsentRef>({ descriptor: null, grant: null })
  const [consentErro, setConsentErro] = useState<string | null>(null)
  const [consentCarregando, setConsentCarregando] = useState(false)
  /**
   * Bloqueio local de envio depois de uma revogação iniciada ou de um DELETE
   * não confirmado. Não é autoridade nova: é o oposto — nega o envio até uma
   * acção explícita de autorização. O ref é a leitura síncrona do envio; o state
   * é o que a UI mostra.
   */
  const [consentimentoBloqueado, setConsentimentoBloqueado] = useState(false)
  const consentimentoBloqueadoRef = useRef(false)
  /**
   * Relógio da RENDERIZAÇÃO, para a barra poder dizer a verdade sobre a expiração.
   * Não é a hora da decisão: essa lê `Date.now()` no momento do envio
   * (`consentimentoVivoAgora`), porque uma `useRef(Date.now())` congelada na
   * montagem fazia a autorização de 30 minutos nunca expirar enquanto o painel
   * ficasse aberto — o `concedidoEm` era gravado com relógio vivo.
   */
  const [agora, setAgora] = useState(() => Date.now())
  const aplicarConsentimentoExterno = useCallback((next: MatrixExternalConsentRef) => {
    consentimentoExternoRef.current = next
    setConsentimentoExternoState(next)
    setProviderKey(next.descriptor?.providerKey ?? null)
    setFornecedor(next.descriptor?.providerLabel ?? null)
    // O relógio da renderização acompanha uma leitura nova: sem isto, um grant
    // carregado muito depois da montagem era comparado com a hora antiga.
    setAgora(Date.now())
  }, [])
  // Modo do launcher (TP-MATRIX-DOCK). A posição antiga continua a ser lida; o
  // modo é um eixo novo, guardado à parte, que nasce em `floating`.
  const [launcherMode, setLauncherModeState] = useState<MatrixMode>(() => parseStoredMode(safeReadLauncherMode()))
  const [dockHover, setDockHover] = useState(false)
  const [dockSlot, setDockSlot] = useState<Pos | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [configModalAberta, setConfigModalAberta] = useState(false)
  const credentialGeneration = useRef(0)
  const [credentialStatus, setCredentialStatus] = useState({ hasKey: false, provider: "groq", state: "unverified" })
  const [providerState, setProviderState] = useState("Ligação não verificada")
  useEffect(() => {
    if (!configModalAberta) return
    let active = true
    window.electronAPI?.aiCredentials?.getStatus().then((status) => {
      if (active && status) setCredentialStatus(status)
    }).catch(() => { if (active) setProviderState("Armazenamento protegido indisponível") })
    return () => { active = false }
  }, [configModalAberta])
  const dockHoverRef = useRef(false)
  /**
   * Autorizações VIVAS desta conversa, uma por alvo. substitui o booleano único
   * que havia: com `processConsent` a caixa ficava marcada enquanto o texto dizia
   * «autorizado noutro alvo», ou seja, a mesma linha afirmava e negava ao mesmo
   * tempo. Aqui a caixa só pode mostrar o estado efectivo do alvo que está em
   * causa, e a revogação é por alvo. Âmbito e duração: `AMBITO_CONSENTIMENTO`.
   */
  const [autorizacoes, setAutorizacoes] = useState<AutorizacaoAlvo[]>([])
  /**
   * Oferta A: autorização única, válida para UM envio. Vive só no renderer
   * (sem grant) e é consumida antes do primeiro POST de chat; um retry nunca a
   * reutiliza. A oferta B é o grant do servidor; não há terceiro modo.
   */
  const autorizacoesOneShotRef = useRef<Set<string>>(new Set())
  /** Token one-shot do servidor (memoria apenas, 120 s). Nunca entra em
   *  storage/historico/log; a lista local so diz que existe para este alvo. */
  const autorizacaoUnicaRef = useRef<MatrixOneShotAuthorization | null>(null)
  /**
   * Alvo da pergunta em curso: o do clique «Explicar» se o houve, senão o do
   * processo mostrado no contexto. Sem a segunda metade, escrever uma pergunta
   * sobre um processo à mão não tinha alvo a autorizar e a caixa era inerte.
   */
  const alvoExplicacao = alvoDeExplicacao(explainRequest ?? null)
  const alvoActual: AlvoProcesso | null =
    alvoExplicacao ??
    (processContext?.selectedProcess
      ? { pid: processContext.selectedProcess.pid, startedAt: processContext.selectedProcess.startedAt ?? null }
      : null)
  /**
   * Alvo a que o consentimento se refere. Sem processo em causa é a MÁQUINA
   * (pid null), exactamente o que o cartão sempre prometeu com «(esta máquina)»
   * e que a store recusava em silêncio — o botão ficava sem efeito.
   */
  const alvoConsentimento = alvoParaConsentimento(alvoActual)
  /** Id opaco da conversa: entra na identidade do pedido para não trocar de conversa com resposta a meio. */
  const [conversationId, setConversationId] = useState(novaIdDeConversa)
  const autorizacoesVivas = limparAutorizacoesExpiradas(autorizacoes, agora)
  // A autorização é do alvo E do fornecedor em que foi dada: trocar de provider
  // (mesmo com o mesmo alvo) deixa de autorizar. `null` é «fornecedor ainda não
  // conhecido» e também não vale como igualdade permissiva.
  const alvoAutorizado = autorizacoesVivas.find((a) =>
    consentValeParaAlvo(a.alvo, alvoConsentimento) && (a.fornecedor ?? null) === (providerKey ?? null)
  )?.alvo ?? null
  /**
   * Oferta B guardada nesta conta e computador: NÃO está presa a um PID. Vale para futuras
   * explicações explícitas desta conta+instalação enquanto o grant estiver vivo;
   * o histórico continua a ser filtrado pelo alvo do pedido em causa. A decisão
   * é a mesma que o envio usa (conta, instalação, fornecedor, âmbito e prazo).
   */
  const descriptorExterno = consentimentoExterno.descriptor
  const grantPersistenteActivo = descriptorExterno !== null && contaId !== null
    && decidirConsentimentoDeEnvio({ descriptor: descriptorExterno, grant: consentimentoExterno.grant }, "persistente", contaId, agora).ok
  const consentimentoProcessoEfectivo = !consentimentoBloqueado && (alvoAutorizado !== null || grantPersistenteActivo)
  const chaveConsentimento = alvoDePedido(alvoConsentimento) ?? "maquina"
  const autorizacaoUmaVez = consentimentoProcessoEfectivo && autorizacoesOneShotRef.current.has(chaveConsentimento)
  /**
   * Um temporizador de cada vez, até à expiração MAIS próxima entre as que AINDA
   * ESTÃO VIVAS, e re-armado a cada tick.
   *
   * Porque é que as duas partes são necessárias: com `Math.min` sobre a lista
   * inteira e deps só `[autorizacoes]`, autorizar A em t0 e B em t10 deixava o
   * disparo em t30 a actualizar `agora` — mas `autorizacoes` não tinha mudado, o
   * efeito não corria outra vez, e B ficava com a caixa marcada como válida muito
   * depois dos seus 40 minutos. `agora` nas dependências é o que faz o ciclo
   * continuar até à última autorização viva; quando não fica nenhuma viva, não se
   * arma nada (sem `setTimeout(0)` em lista de espera, sem polling).
   */
  useEffect(() => {
    const agoraActual = Date.now()
    const futuras = autorizacoes
      .map((a) => a.concedidoEm + AMBITO_CONSENTIMENTO.duracaoMs)
      .filter((limite) => limite > agoraActual)
    if (futuras.length === 0) return
    const proxima = Math.min(...futuras)
    const espera = Math.max(1, proxima - agoraActual)
    const t = setTimeout(() => setAgora(Date.now()), espera)
    return () => clearTimeout(t)
  }, [autorizacoes, agora])
  /**
   * O grant de 30 dias não pode continuar a parecer activo na renderização
   * quando expira. É um segundo temporizador, separado do das autorizações
   * locais: um grant não é uma autorização de alvo e não deve re-armar aquela
   * fila. Sem polling; o teto do `setTimeout` é re-armado pelo próximo render.
   */
  useEffect(() => {
    const expira = consentimentoExterno.grant ? Date.parse(consentimentoExterno.grant.expiresAt) : NaN
    if (!Number.isFinite(expira)) return
    const restante = expira - Date.now()
    if (restante <= 0) return
    const t = setTimeout(() => setAgora(Date.now()), Math.min(restante, 2_147_000_000))
    return () => clearTimeout(t)
  }, [consentimentoExterno.grant?.expiresAt, agora])
  /**
   * Espeelho do estado para a decisão de envio: o `processMessage` pode estar
   * fechado sobre uma versão antiga do array, e autorizar com dados velhos no
   * sentido permissivo é o erro que não se pode cometer. Falha sempre fechada:
   * relógio vivo + última lista efectivamente renderizada.
   */
  const autorizacoesRef = useRef<AutorizacaoAlvo[]>(autorizacoes)
  autorizacoesRef.current = autorizacoes
  const consentimentoVivoAgora = useCallback(() => {
    // Revogação iniciada/falhada: nenhuma autorização antiga volta a valer por
    // uma renderização ou um GET entretanto. Só uma acção explícita A/B limpa isto.
    if (consentimentoBloqueadoRef.current) return false
    const local = autorizacaoValida(autorizacoesRef.current, alvoConsentimento, Date.now())
      // A validade do alvo no instante do envio (relógio vivo, não o da
      // montagem) e, na mesma decisão, a identidade do fornecedor em que foi
      // dada: uma troca de provider falha fechada antes de qualquer envio.
      && autorizacoesRef.current.some((a) =>
        consentValeParaAlvo(a.alvo, alvoConsentimento) && (a.fornecedor ?? null) === (providerKey ?? null)
      )
    if (local) return true
    // Oferta B: um grant vivo autoriza pedidos explícitos futuros sem repetir a
    // escolha e sem se prender ao PID. O servidor volta a validar o id no envio.
    const externo = consentimentoExternoRef.current
    // A conta já foi filtrada pelo GET (só devolve o grant da sessão) e é
    // revalidada no envio; aqui a prova síncrona é o grant, não um cache local.
    return externo.descriptor !== null && externo.grant !== null
      && decidirConsentimentoDeEnvio(
        { descriptor: externo.descriptor, grant: externo.grant },
        "persistente",
        externo.grant.userId,
        Date.now(),
      ).ok
  }, [alvoConsentimento, providerKey, contaId])
  const scrollRef = useRef<HTMLDivElement>(null)
  // Segue o fundo só enquanto o utilizador lá estiver (o streaming não o puxa).
  const stickToBottomRef = useRef(true)
  const abortRef = useRef<AbortController | null>(null)
  const questionGenerationRef = useRef(0)
  /** Último `explainRequest.id` já auto-enviado (evita reenviar em cada re-render). */
  const ultimoExplicacaoAutoRef = useRef<number | null>(null)
  /**
   * Identidade da INTENÇÃO de «Explicar»: alvo (PID + instância) + texto. Dois
   * cliques no mesmo botão chegam com ids diferentes e são a MESMA intenção: não
   * podem cancelar a resposta que já está a caminho. Outro alvo/instância, mesmo
   * com o mesmo texto, é outra intenção. Limpa-se quando chega uma resposta, ao
   * parar e ao abrir conversa nova.
   */
  const intencaoExplicarRef = useRef<string | null>(null)
  /**
   * Última explicação LOCAL já mostrada, pela assinatura do alvo+pergunta e pelo
   * próprio texto. Dois cliques seguidos com as mesmas medições são o mesmo
   * diagnóstico: uma resposta. Quando chegam medições novas o texto muda e a
   * explicação volta a aparecer; quando chega uma resposta da IA a marca cai,
   * porque aí já houve outra resposta e o botão volta a poder ser usado.
   */
  const ultimaExplicacaoLocalRef = useRef<string | null>(null)
  /** O mesmo pedido, legível pelo reset sem o pôr nas dependências do useCallback. */
  const explainRequestRef = useRef(explainRequest)
  explainRequestRef.current = explainRequest
  /** Cartão de consentimento: só para o trazer à vista quando nasce um pendente. */
  const consentCardRef = useRef<HTMLDivElement | null>(null)
  /**
   * Explicação pedida que ficou À ESPERA de autorização para o alvo concreto.
   * Sem isto, marcar a caixa depois de receber a resposta «sem autorização» era
   * inerte e a pessoa tinha de repetir a pergunta — que é exactamente o que o
   * pedido de autorização promete não fazer.
   */
  const [explicacaoPendente, setExplicacaoPendente] = useState<PendenteExplicacao | null>(null)
  /**
   * OPÇÃO DE IA, separada do diagnóstico local (TP-MATRIX-LOCAL-FIRST-20261023).
   * O clique «Explicar» responde sempre localmente; isto guarda a MESMA pergunta
   * e o MESMO alvo para quem quiser, depois, pedir uma segunda opinião ao
   * fornecedor. Sem este estado, «pedir autorização» voltava a ser condição para
   * ver a explicação — o defeito que este lote fecha.
   */
  const [ofertaIa, setOfertaIa] = useState<PendenteExplicacao | null>(null)
  /**
   * O estado do pedido em curso, em palavras, na barra que a pessoa lê antes de
   * qualquer resposta. Derivado do que se passou, nunca de `mode`: «Fornecedor
   * verificado» no cabecalho e configuracao, e foi lido como «esta resposta veio da
   * IA» — exatamente a confusao reportada no gate humano.
   */
  const estadoVisivel: MatrixRequestState | null =
    explicacaoPendente !== null ? "necessita-autorizacao"
      : phase === "thinking" || phase === "streaming" ? estadoDoTransporte(false, phase === "streaming")
        : phase === "rate_limited" ? "erro-recuperavel"
          : phase === "error" ? "indisponivel"
            : null
  /**
   * Último `id` cujo pedido pendente já teve DESFECHO — autorização dada (reenvio
   * UMA vez) ou recusa explícita. A mesma variável serve os dois porque o que se
   * evita é o mesmo: um segundo clique, ou um re-render, resolver o mesmo pedido.
   */
  const explicacaoResolvidaRef = useRef<number | null>(null)
  /**
   * Pedido em curso, com a sua identidade. Cada resposta que chega compara-se a
   * aqui: foi este pedido que ainda esta activo, ou entretanto se mudou de
   * processo ou de conversa? Sem este ref, `questionId` apanhava uma troca de
   * processo mas nao uma troca de alvo, e a resposta do A aparecia sob o B.
   */
  const pedidoActivoRef = useRef<IdentidadePedido | null>(null)
  /** O bloco de privacidade abre-se sozinho quando falta autorização; fecha-se sozinha. */
  const [autorizacaoAberta, setAutorizacaoAberta] = useState(false)
  /**
   * O efeito de «Explicar na MATRIX» corre antes de `processMessage` existir nesta
   * passagem do código; guardar a função mais recente num ref é o que permite
   * acionar o fluxo normal sem duplicar a implementação nem mover 200 linhas.
   */
  const processMessageRef = useRef<((texto: string, isRetry?: boolean, forcar?: boolean, forcarLocal?: boolean, modoDoPedido?: MatrixChatMode) => Promise<void>) | null>(null)
  const localUntilRef = useRef(0)
  const [streamed, setStreamed] = useState("")
  const streamedRef = useRef("")
  /**
   * Espelho síncrono das mensagens. `processMessage` pode ser chamado pelo
   * efeito de «Explicar» no mesmo commit em que a conversa abre; ler o estado
   * desta renderização perdia a saudação ou mensagens acabadas de escrever.
   */
  const messagesRef = useRef<Message[]>([])

  const substituirMensagens = useCallback((next: Message[]) => {
    messagesRef.current = next
    setMessages(next)
  }, [])

  const anexarMensagem = useCallback((message: Message) => {
    /**
     * Instrumentacao DEV, allowlist fechada e so no anexar uma resposta: o log
     * leva identidade opaca do pedido e o estado ja decidido, e nao tem por onde
     * sair com o texto da pergunta, nomes de processo, caminhos, metricas ou
     * chaves. `traceDePedido` corta o que nao couber no formato.
     */
    if (import.meta.env?.DEV === true && message.role === "assistant" && message.state) {
      const p = pedidoActivoRef.current
      console.debug(traceDePedido({
        requestId: p?.requestId ?? "-",
        conversationId: p?.conversationId ?? "-",
        targetId: p?.targetId ?? "-",
        consentState: message.state === "necessita-autorizacao" ? "negado" : p ? "autorizado" : "nao-precisa",
        providerState: message.state,
        origin: message.origin === "ai" ? "provider" : "local",
      }))
    }
    // Uma resposta chegou: a intenção de «Explicar» deixou de estar em voo e um
    // novo clique no mesmo botão volta a ser um pedido legítimo.
    if (message.role === "assistant") intencaoExplicarRef.current = null
    if (message.role === "assistant" && message.origin === "ai") ultimaExplicacaoLocalRef.current = null
    setMessages((prev) => {
      const next = acrescentarMensagem(prev, message)
      messagesRef.current = next
      return next
    })
  }, [])

  const suggestions = useMemo(() => SUGGESTIONS[currentPage] || DEFAULT_SUGGESTIONS, [currentPage])

  const setUpOpenState = useCallback((v: boolean) => {
    if (!v) {
      questionGenerationRef.current += 1
      cancelLocalSecurityRequest(abortRef.current)
      setPhase("idle")
      // Fechar NAO revoga: o ambito declarado e «esta conversa, este alvo».
      // Revogar aqui faria a pessoa perder uma autorizacao que ainda dava por valida.
      // Fechar o painel derruba o pedido pendente: reabrir não pode enviar uma
      // pergunta que a pessoa abandonou, nem com autorização que já não existe.
      setExplicacaoPendente(null)
      setAutorizacaoAberta(false)
      // O painel lateral não tem avatar onde voltar: fechar (X ou Escape)
      // devolve a Matrix ao modo flutuante, com a conversa intacta.
      if (launcherMode === "panel") {
        setLauncherModeState("floating")
        try {
          localStorage.setItem(MATRIX_MODE_KEY, "floating")
        } catch {
          /* sem armazenamento: vale para esta sessão */
        }
      }
    }
    if (v) substituirMensagens(garantirSaudacao(messagesRef.current))
    isOpenRef.current = v
    setIsOpenState(v)
  }, [launcherMode, substituirMensagens])

  useEffect(() => {
    if (!isOpen) return
    return subscribeMatrixEscape(document, () => setUpOpenState(false))
  }, [isOpen, setUpOpenState])

  // O painel lateral é uma superfície, não um popup: escolhido o modo, a
  // conversa abre. Sem isto, quem escolhesse «Abrir painel lateral» com o chat
  // fechado via um painel vazio.
  useEffect(() => {
    if (launcherMode === "panel" && !isOpenRef.current) setUpOpenState(true)
  }, [launcherMode, setUpOpenState])

  /**
   * Troca da escolha Local/Online. Aborta o que está em voo porque a resposta
   * pertence ao modo anterior; NÃO toca em consentimento — um grant válido, um
   * pedido pendente de autorização e o bloqueio de uma revogação falhada são do
   * servidor/trabalho anterior, não desta preferência. Só a UI de consentimento
   * deixa de estar à vista ao escolher Local, porque nada vai ser enviado.
   */
  const mudarModoConversa = (novo: MatrixChatMode) => {
    if (novo === modoConversa) return
    setModoConversa(novo)
    intencaoExplicarRef.current = null
    questionGenerationRef.current += 1
    cancelLocalSecurityRequest(abortRef.current)
    abortRef.current?.abort()
    abortRef.current = null
    pedidoActivoRef.current = null
    setStreamed("")
    streamedRef.current = ""
    setPhase("idle")
    if (novo === "local") {
      setOfertaIa(null)
      setExplicacaoPendente(null)
      setAutorizacaoAberta(false)
    }
  }

  /**
   * Única porta para o fluxo de envio. O teste `matrix-origin-routing` conta as
   * chamadas reais a `processMessage` e não aceita uma segunda: clique «Explicar»,
   * reenvio depois de autorizar e recusa explícita entram todos por aqui, com a
   * mesma `forcar` e o mesmo texto — duas portas são duas oportunidades de divergir.
   */
  const enviarPeloFluxoNormal = (texto: string, forcarLocal = false) =>
    processMessageRef.current?.(texto, false, true, forcarLocal, modoConversa)

  /**
   * RECUSA EXPLÍCITA — a acção que faltava.
   *
   * O pedido de autorização nasce com a caixa por marcar (`checked={false}`), e o
   * único caminho de recusa vivia no `onChange` quando `!checked`: a partir de
   * «desmarcado» esse evento nunca se dispara, por isso quem quisesse continuar
   * sem partilhar ficava com o pedido pendente PARA SEMPRE, sem resposta nenhuma.
   * Isto contradiz o aceite («negar → fallback com motivo»).
   *
   * A recusa consome o pendente uma vez (mesma guarda do reenvio) e entra pela
   * porta única a pedir o MESMO fluxo com a decisão local forçada: não depende da
   * closure de `consentimentoProcessoEfectivo` desta renderização, que é
   * precisamente o valor que uma acção do utilizador ainda não conseguiu actualizar.
   */
  const recusarExplicacaoPendente = () => {
    if (!explicacaoPendente) return
    if (explicacaoResolvidaRef.current === explicacaoPendente.id) return
    explicacaoResolvidaRef.current = explicacaoPendente.id
    const textoRecusado = explicacaoPendente.texto
    // Recusar tambem tira a autorizacao daquele alvo: sem isto, quem tinha
    // autorizado e depois escolhia «continuar localmente» ficava com a caixa
    // marcada enquanto a resposta dizia o contrario.
    setAutorizacoes((prev) => revogarAlvo(prev, explicacaoPendente.alvo))
    setExplicacaoPendente(null)
    setAutorizacaoAberta(false)
    if (import.meta.env?.DEV === true) {
      console.debug(traceDePedido({
        requestId: `decline-${explicacaoPendente.id}`,
        conversationId,
        targetId: String(explicacaoPendente.alvo.pid ?? "maquina"),
        consentState: "negado",
        providerState: "necessita-autorizacao",
        origin: "local",
      }))
    }
    enviarPeloFluxoNormal(textoRecusado, true)
  }

  // «Explicar na MATRIX» era um preenchimento de caixa: a pessoa via a pergunta
  // escrita e tinha de carregar em Enviar ela própria. Aqui passa a acionar o
  // MESMO fluxo de uma mensagem normal (`processMessage`), uma única vez por
  // pedido — mas só quando não falta autorização para o alvo concreto.
  //
  // Antes, este efeito enviava sempre: sem autorização, `motivoDoEncaminhamentoLocal`
  // devolvia `sem-consentimento` e a pessoa recebia uma resposta local etiqueta
  // «Diagnóstico local» sem nunca ter sido questionada — parecia avaria, porque o
  // painel dizia «Fornecedor verificado», e a resposta seguinte da mesma pergunta
  // dependia de uma caixa que ela própria não tinha visto.
  useEffect(() => {
    if (!explainRequest) return
    const alvo = alvoDeExplicacao(explainRequest)
    if (!alvo) return
    const texto = promptDeExplicacaoDeProcesso(explainRequest.pid)
    const identidadePerdida = identidadeDeExplicacaoPerdida(explainRequest, explainIdentity)
    // A reserva do id vem ANTES de qualquer efeito destrutivo. Assim, mudar
    // floating/docked (ou marcar a caixa) reexecuta este efeito com o mesmo pedido
    // sem cancelar a resposta em curso, sem invalidar a geração e sem reenviar.
    if (!deveAutoEnviarExplicacao(ultimoExplicacaoAutoRef.current, explainRequest)) return
    ultimoExplicacaoAutoRef.current = explainRequest.id

    // Dedup por INTENÇÃO, antes de qualquer efeito destrutivo. Um segundo clique
    // no mesmo alvo/pergunta chega com outro id; sem esta guarda, o
    // `questionGenerationRef++` e o abort logo abaixo cancelavam a primeira
    // resposta e o envio seguinte era recusado — ficava zero respostas.
    const assinatura = `${alvoDePedido(alvo) ?? "sem-alvo"}::${texto}`
    if (intencaoExplicarRef.current === assinatura) return
    intencaoExplicarRef.current = assinatura

    // DIAGNÓSTICO LOCAL PRIMEIRO: o clique responde JÁ, com o que foi medido,
    // sem fornecedor, sem consentimento externo e sem esperar por um cartão.
    // A opção de IA é um segundo passo explícito (`ofertaIa`) — nunca a condição
    // para ver a explicação. Uma falha de IA não pode apagar isto: a mensagem
    // local já está na conversa e o envio seguinte acrescenta outra.
    //
    // O pedido anterior em voo fica sem dono (mudança de alvo):
    // `descartarResposta` descarta contra `null`, nada do alvo antigo cai sobre
    // este, e a bolha de stream é limpa.
    const selecionadoNoContexto = processContext?.selectedProcess ?? null
    const medido = selecionadoNoContexto !== null && selecionadoNoContexto.pid === explainRequest.pid
      ? selecionadoNoContexto
      : processDiagnostic?.topProcesses.find(p => p.pid === explainRequest.pid && (p.startedAt || null) === (explainRequest.startedAt ?? null)) ?? null
    const conteudoLocal = identidadePerdida
      ? buildIdentityLostReply(explainRequest.pid, explainIdentity === "sumido" ? "sumido" : "reutilizado")
      : buildProcessLocalReply(processDiagnostic, explainRequest.pid, medido)
    const chaveLocal = `${assinatura}::${conteudoLocal}`
    // Duas explicações seguidas com os MESMOS dados são o mesmo diagnóstico:
    // não se duplica a mensagem nem se invalida uma resposta de IA em voo.
    if (ultimaExplicacaoLocalRef.current === chaveLocal) return
    questionGenerationRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    pedidoActivoRef.current = null
    setStreamed("")
    streamedRef.current = ""
    setPhase("idle")
    setUpOpenState(true)
    anexarMensagem({
      role: "assistant",
      content: conteudoLocal,
      privateProcessData: true,
      privateTarget: alvo,
      origin: "local",
      state: "local",
    })
    ultimaExplicacaoLocalRef.current = chaveLocal
    // A oferta de IA só aparece quando há CONTEXTO medido para enviar e a
    // instância pedida ainda existe; prometer um envio que o gate recusaria era
    // outra contradição entre o botão e o que sai da máquina.
    setOfertaIa(processContext && !identidadePerdida
      ? { id: explainRequest.id, pid: explainRequest.pid ?? null, startedAt: explainRequest.startedAt ?? null, texto, alvo }
      : null)
    setExplicacaoPendente(null)
    setAutorizacaoAberta(false)
    return
  }, [explainRequest, setUpOpenState, processContext, processDiagnostic, anexarMensagem, explainIdentity])

  // Autorizar retoma o pedido que ficou pendente — uma única vez, e só se a
  // autorização vale para o alvo em que a pessoa clicou «Explicar». As condições
  // vivem em `deveReenviarExplicacaoAposAutorizacao` para serem prováveis sem
  // React; aqui só se liga a decisão ao envio real.
  useEffect(() => {
    if (!explicacaoPendente) return
    if (!deveReenviarExplicacaoAposAutorizacao(explicacaoPendente, {
      consentimentoEfectivo: consentimentoVivoAgora(),
      alvoAutorizado: alvoActual,
      identidadePerdida: identidadeDeExplicacaoPerdida(explainRequest, explainIdentity),
      jaConsumido: explicacaoResolvidaRef.current,
    })) return
    explicacaoResolvidaRef.current = explicacaoPendente.id
    setExplicacaoPendente(null)
    setAutorizacaoAberta(false)
    questionGenerationRef.current += 1
    cancelLocalSecurityRequest(abortRef.current)
    setPhase("idle")
    setInput(explicacaoPendente.texto)
    enviarPeloFluxoNormal(explicacaoPendente.texto)
  }, [explicacaoPendente, consentimentoProcessoEfectivo, alvoActual, explainRequest, explainIdentity])

  // Um pedido pendente tem de estar À VISTA: aparecer no fim de uma lista longa
  // deixava a pessoa com «A precisar da tua autorização» na barra e nada para
  // clicar. `nearest` não puxa a vista se o cartão já estiver visível.
  useEffect(() => {
    if (!explicacaoPendente) return
    consentCardRef.current?.scrollIntoView?.({ block: "nearest" })
  }, [explicacaoPendente])

  useEffect(() => () => {
    questionGenerationRef.current += 1
    cancelLocalSecurityRequest(abortRef.current)
  }, [])

  // Abertura: a saudação é inserida de forma SÍNCRONA por `setUpOpenState`.
  // A informação do fornecedor vem do descriptor LOCAL de consentimento, não de
  // uma sonda ao fornecedor. Abrir o painel ou responder localmente tem de
  // continuar a funcionar com zero chamadas externas; só o opt-in de IA decide
  // disponibilidade e envia ao fornecedor. Se a API local não responder, o
  // rótulo fica genérico e a resposta local não depende dele.
  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    setConsentCarregando(true)
    setConsentErro(null)
    lerConsentimento(API_BASE, authHeaders()).then((estado) => {
      if (cancelled || !isOpenRef.current) return
      const anterior = consentimentoExternoRef.current.descriptor
      // Um GET que ainda devolve o grant antigo depois de uma revogação falhada
      // não pode reabrir o envio: o bloqueio local só cai com uma escolha A/B
      // explícita. O descriptor pode ser actualizado, o grant nunca.
      if (consentimentoBloqueadoRef.current) {
        aplicarConsentimentoExterno({
          descriptor: estado?.descriptor ?? anterior,
          grant: null,
        })
        setConsentErro("O serviço local não confirmou a revogação. O envio de medições está bloqueado até voltares a autorizar.")
        setConsentCarregando(false)
        return
      }
      // Provider/endpoint/âmbito mudou no servidor: a autorização local deixa de
      // valer e a pessoa tem de escolher outra vez. Isto é o mesmo GET local; não
      // há sonda ao fornecedor.
      if (anterior && (!estado || anterior.providerKey !== estado.descriptor.providerKey
        || !mesmosCamposDeConsentimento(anterior.fields, estado.descriptor.fields))) {
        setAutorizacoes([])
        autorizacoesOneShotRef.current.clear()
        autorizacaoUnicaRef.current = null
      }
      aplicarConsentimentoExterno(estado
        ? { descriptor: estado.descriptor, grant: estado.grant }
        : { descriptor: null, grant: null })
      setConsentCarregando(false)
    })
    return () => {
      cancelled = true
    }
  }, [isOpen, aplicarConsentimentoExterno])

  useEffect(() => {
    if (!stickToBottomRef.current) return
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, phase, streamed])

  // A posição do scroll é do utilizador: só voltamos a colar ao fundo quando
  // ele próprio já está perto dele.
  const trackScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stickToBottomRef.current = isNearBottom({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    })
  }

  const sendToServer = useCallback(
    async (
      history: Message[],
      signal: AbortSignal,
      stream: boolean,
      onFirstDelta?: () => void,
      /**
       * A decisão de consentimento é UMA por envio, tomada com relógio vivo em
       * `processMessage`, e chega aqui em vez de ser re-lida: duas leituras do
       * relógio a decidir caminhos diferentes (rota de um lado, payload do outro)
       * era mais uma definição do mesmo facto.
       */
      consentimento: boolean = consentimentoVivoAgora(),
      /** O pedido ainda é o pedido em curso? Sem isto, um stream velho pintava-se
       *  na tela por cima do alvo novo, mesmo sem anexar resposta. */
      vigente: () => boolean = () => true,
      /** Alvo autorizado para ESTE envio; `null` mantém todo o privado em casa. */
      alvoDoEnvio: AlvoProcesso | null = null,
      /** Oferta escolhida para ESTE envio; `null` é o caminho legado sem descriptor. */
      modoDoEnvio: MatrixConsentMode | null = null,
      /**
       * A pergunta aponta ao alvo medido? Só então as medições desse alvo entram
       * no payload. Sem isto, uma pergunta geral sobre processos herdava o
       * contexto do processo selecionado — contexto por acidente.
       */
      anexarContexto: boolean = true,
      /** Autorizacao unica do servidor para ESTE envio (oferta A, R2). */
      autorizacaoUnica: MatrixOneShotAuthorization | null = null,
    ): Promise<{ ok: boolean; content?: string; code?: string; message?: string }> => {
      // O aviso de revogação pode chegar depois de `processMessage` ter lido o
      // consentimento. Esta leitura síncrona fecha a janela e é a última barreira
      // antes de qualquer pedido ao fornecedor.
      // Só um pedido que leva medições pode ser bloqueado por consentimento: o
      // chat geral não carrega telemetria e continua utilizável sem autorização.
      if (bloqueioDeConsentimentoAplica(consentimentoBloqueadoRef.current, anexarContexto)) {
        return { ok: false, code: "process_consent_grant_invalid", message: "A revogação do consentimento está por confirmar. Nada foi enviado ao fornecedor; volta a autorizar." }
      }
      // Só um pedido que leva medições do alvo pode usar o consentimento: um
      // chat geral nunca fica coberto por um grant, nem envia o grant, mesmo que
      // exista. `anexarContexto` é a decisão deste pedido, não do painel.
      const consentimentoDoPedido = consentimento && anexarContexto
      /**
       * GET de consentimento ANTES do envio: o grant é do servidor e pode ter
       * expirado/revogado/trocado de fornecedor desde a renderização. O servidor
       * continua a ser a autoridade final; esta leitura só evita enviar um
       * `consentGrantId` que já não vale e NUNCA cai para one-shot.
       */
      let externo = consentimentoExternoRef.current
      let camposEnvio: MatrixConsentChatFields = {}
      /** Conta autenticada no momento em que este pedido nasceu. */
      const contaNoInicioDoPedido = contaIdRef.current
      if (consentimentoDoPedido && externo.descriptor) {
        const validado = await lerConsentimento(API_BASE, authHeaders())
        if (!validado) {
          // Sem leitura não se assume que o grant continua válido. O envio pára
          // e a resposta fica local; não há cache de aceitação.
          return { ok: false, code: "consent_api_unreachable", message: "Não foi possível confirmar o consentimento na API local. Nada foi enviado ao fornecedor." }
        }
        // O GET foi um `await`: revogação, troca de conta ou pedido substituído
        // podem ter acontecido enquanto ele corria. Primeira reavaliação, antes
        // de construir o payload privado.
        const depoisDoGet = revalidarAntesDoEnvio({
          anexarContexto: consentimentoDoPedido,
          bloqueado: consentimentoBloqueadoRef.current,
          abortado: signal.aborted,
          vigente: vigente(),
          contaActual: contaIdRef.current,
          contaDoPedido: contaNoInicioDoPedido,
        })
        if (!depoisDoGet.enviar) return { ok: false, code: depoisDoGet.code, message: depoisDoGet.message }
        // O fornecedor também pode ter mudado durante o GET: comparar com o
        // descriptor VIVO, não com a cópia lida antes do await.
        const externoAgora = consentimentoExternoRef.current
        if (!externoAgora.descriptor || validado.descriptor.providerKey !== externoAgora.descriptor.providerKey) {
          aplicarConsentimentoExterno({ descriptor: validado.descriptor, grant: null })
          return { ok: false, code: "process_consent_provider_mismatch", message: mensagemDeConsentimento("process_consent_provider_mismatch") }
        }
        if (!mesmosCamposDeConsentimento(validado.descriptor.fields, externoAgora.descriptor.fields)) {
          aplicarConsentimentoExterno({ descriptor: validado.descriptor, grant: null })
          return { ok: false, code: "process_consent_scope_changed", message: mensagemDeConsentimento("process_consent_scope_changed") }
        }
        // O dono esperado é a conta AUTENTICADA desta sessão (metadata do
        // cliente), nunca o `grant.userId` — validar o documento contra si
        // próprio aceitaria um grant de outra conta. Sem conta, falha fechado;
        // o servidor continua a ser a autoridade final.
        const decisao = decidirConsentimentoDeEnvio(validado, modoDoEnvio ?? "persistente", contaIdRef.current, Date.now())
        if (!decisao.ok) {
          aplicarConsentimentoExterno({ descriptor: validado.descriptor, grant: null })
          return { ok: false, code: decisao.code, message: decisao.message }
        }
        externo = { descriptor: validado.descriptor, grant: validado.grant }
        aplicarConsentimentoExterno(externo)
        if (modoDoEnvio === "uma-vez") {
          // Oferta A: so o token emitido pelo servidor autoriza. Sem token, sem
          // alvo canonico ou com token de outro alvo/prazo, nada sai.
          const alvoUnico = alvoUnicoCanonico(alvoDoEnvio)
          if (
            !autorizacaoUnica
            || !alvoUnico
            || !autorizacaoUnicaValida(autorizacaoUnica, alvoUnico, validado.descriptor.providerKey)
          ) {
            aplicarConsentimentoExterno({ descriptor: validado.descriptor, grant: null })
            return { ok: false, code: "process_consent_authorization_invalid", message: mensagemDeConsentimento("process_consent_authorization_invalid") }
          }
          camposEnvio = camposDeAutorizacaoUnicaNoChat(autorizacaoUnica)
        } else {
          camposEnvio = decisao.campos
        }
      }
      // Chat geral NÃO leva consentProviderKey nem grant: esses campos existem
      // para pedidos de processo autorizados. Anexá-los a uma pergunta geral
      // ligava-a a um grant que podia estar revogado e transformava um 403 de
      // consentimento em falha do fornecedor — e o chat geral deixava de funcionar
      // sem telemetria. Sem descriptor/campos mantém-se o caminho legado.
      //
      // UMA cablagem para consentimento+medições: `processPayload` decide o que
      // pode viajar e nunca deixa duas autoridades concorrentes no mesmo corpo.
      const payloadProcesso = processPayload(
        anexarContexto ? processContext : null,
        consentimentoDoPedido,
        externo?.descriptor ? camposEnvio : undefined,
      )
      const payload = {
        messages: processChatHistory(history, consentimentoDoPedido, consentimentoDoPedido ? alvoDoEnvio : null),
        context: minimizeContextForAi(matrixTelemetryContext(context, consentimentoDoPedido), consentimentoDoPedido),
        page: PAGE_LABELS[currentPage],
        stream,
        ...payloadProcesso,
        ...camposEnvio,
      }
      // Última barreira, já com o payload construído: nada privado sai depois de
      // um `await` sem a mesma verificação de abort/vigência/bloqueio/conta.
      const antesDoFetch = revalidarAntesDoEnvio({
        anexarContexto: consentimentoDoPedido,
        bloqueado: consentimentoBloqueadoRef.current,
        abortado: signal.aborted,
        vigente: vigente(),
        contaActual: contaIdRef.current,
        contaDoPedido: contaNoInicioDoPedido,
      })
      if (!antesDoFetch.enviar) return { ok: false, code: antesDoFetch.code, message: antesDoFetch.message }
      if (consentimentoDoPedido && modoDoEnvio === "uma-vez") {
        // Guarda depois do await/construcao: o token continua vivo, do MESMO
        // alvo e fornecedor; um abort/revogacao/troca fecha antes do fetch.
        const alvoAgora = alvoUnicoCanonico(alvoDoEnvio)
        if (
          !autorizacaoUnica
          || !alvoAgora
          || !autorizacaoUnicaValida(autorizacaoUnica, alvoAgora, externo.descriptor?.providerKey)
        ) {
          return { ok: false, code: "process_consent_authorization_invalid", message: mensagemDeConsentimento("process_consent_authorization_invalid") }
        }
      }
      if (consentimentoDoPedido && externo.descriptor) {
        const descriptorAgora = consentimentoExternoRef.current.descriptor
        if (!descriptorAgora) {
          aplicarConsentimentoExterno({ descriptor: externo.descriptor, grant: null })
          return { ok: false, code: "process_consent_grant_invalid", message: mensagemDeConsentimento("process_consent_grant_invalid") }
        }
        if (descriptorAgora.providerKey !== externo.descriptor.providerKey) {
          aplicarConsentimentoExterno({ descriptor: descriptorAgora, grant: null })
          return { ok: false, code: "process_consent_provider_mismatch", message: mensagemDeConsentimento("process_consent_provider_mismatch") }
        }
      }
      if (stream) {
        // Guarda de tempo limite no cliente: aborta se nenhum dado chegar.
        const watchdog = new AbortController()
        const onUserAbort = () => watchdog.abort()
        if (signal.aborted) watchdog.abort()
        else signal.addEventListener("abort", onUserAbort, { once: true })
        const timedOut = { current: false }
        const timer = setTimeout(() => {
          timedOut.current = true
          watchdog.abort()
        }, STREAM_TIMEOUT_MS)
        const settle = () => {
          clearTimeout(timer)
          signal.removeEventListener("abort", onUserAbort)
        }
        try {
          const res = await fetch(`${API_BASE}/api/ai/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders() },
            body: JSON.stringify(payload),
            signal: watchdog.signal,
          })
          if (!res.ok) {
            let code: string | undefined
            let message = "Erro do serviço de IA."
            try {
              const j = await res.json()
              code = j.code ?? codigoDeStatusHttp(res.status)
              message = j.message || message
            } catch {
              code = codigoDeStatusHttp(res.status)
            }
            settle()
            return { ok: false, code, message }
          }
          const reader = res.body?.getReader()
          if (!reader) {
            settle()
            return { ok: false, message: "Streaming indisponível no cliente." }
          }
          const decoder = new TextDecoder()
          let buffer = ""
          let content = ""
          let completed = false
          streamedRef.current = ""
          let started = false
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const events = buffer.split("\n\n")
            buffer = events.pop() || ""
            for (const evt of events) {
              const line = evt.trim()
              if (!line.startsWith("data:")) continue
              try {
                const obj = JSON.parse(line.replace(/^data:\s*/, ""))
                if (obj.delta) {
                  // Pedimento substituído: nem bolha de stream, nem texto na tela.
                  // Anexar já é descartado mais abaixo; pintar era a parte que
                  // mostrava a resposta de A por cima do pedido de B.
                  if (!vigente()) {
                    settle()
                    return { ok: false, message: "Pedido substituído." }
                  }
                  if (!started) {
                    started = true
                    onFirstDelta?.()
                  }
                  content += obj.delta
                  streamedRef.current += obj.delta
                  setStreamed(streamedRef.current)
                } else if (obj.error) {
                  settle()
                  return { ok: false, code: obj.error, message: obj.message }
                } else if (obj.done) {
                  completed = true
                }
              } catch { /* ignore */ }
            }
          }
          settle()
          if (timedOut.current) return { ok: false, code: "timeout", message: "Tempo limite excedido. Tenta de novo." }
          if (!completed || !content.trim()) return {ok: false, message: "A resposta da IA não foi concluída."}
          return { ok: true, content }
        } catch (err) {
          settle()
          if (signal.aborted) throw err
          if (timedOut.current) return { ok: false, code: "timeout", message: "Tempo limite excedido. Tenta de novo." }
          throw err
        }
      }
      const res = await fetch(`${API_BASE}/api/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(payload),
        signal,
      })
      if (!res.ok) {
        let code: string | undefined
        let message = "Erro do serviço de IA."
        try {
          const j = await res.json()
          code = j.code ?? codigoDeStatusHttp(res.status)
          message = j.message || message
        } catch {
          code = codigoDeStatusHttp(res.status)
        }
        return { ok: false, code, message }
      }
      const j = await res.json()
      return typeof j.response === "string" && j.response.trim()
        ? { ok: true, content: j.response }
        : {ok: false, message: "A resposta da IA não foi concluída."}
    },
    [context, currentPage, processContext, consentimentoVivoAgora, aplicarConsentimentoExterno],
  )

  const processMessage = useCallback(
    async (text: string, isRetry = false, forcar = false, forcarLocal = false, modoDoPedido: MatrixChatMode = "online") => {
      const trimmed = text.trim()
      if (!trimmed || (!forcar && (phase === "thinking" || phase === "streaming"))) return

      // Enviar é intenção explícita de ver a resposta: volta a colar ao fundo.
      stickToBottomRef.current = true
      cancelLocalSecurityRequest(abortRef.current)
      const questionId = ++questionGenerationRef.current
      const processQuestion = isProcessQuestion(trimmed)
      // O controlador nasce ANTES da identidade e fica capturado pela decisão:
      // ler `abortRef.current` mais tarde é ler o controlador de OUTRO pedido, que
      // é precisamente o que acontece depois de `resetConversation` ou de um novo
      // envio. Cada resposta responde pelo SEU signal.
      const controller = new AbortController()
      abortRef.current = controller
      /**
       * Identidade deste pedido: alvo opaco (pid + instante), conversa e geracao. A
       * decisao de descartar passa a ser `descartarResposta`, uma so vez, em vez de
       * um `!==` repetido a cada await — era ai que uma resposta antiga podia cair
       * na conversa errada.
       */
      const identidade: IdentidadePedido = {
        requestId: "r" + questionId,
        conversationId,
        targetId: alvoDePedido(alvoActual) ?? "sem-alvo",
        geracao: questionId,
      }
      pedidoActivoRef.current = identidade
      // `actual` lê o ref sem substituto: `?? identidade` aceitava a resposta de um
      // pedido cujo dono já tinha sido apagado (alvo trocado, conversa nova).
      const deveDescartarResposta = () => descartarResposta({
        pedido: identidade,
        actual: pedidoActivoRef.current,
        signalAbortado: controller.signal.aborted,
      })
      /**
       * Só anexa contexto medido quando a pergunta aponta ao alvo (PID, nome ou
       * «este processo») ou quando o «Explicar» foi explícito. `isProcessQuestion`
       * sozinho não prova pertença: uma pergunta geral sobre processos herdava o
       * contexto do processo selecionado e, com um grant vivo, enviava-o.
       */
      const perguntaDaExplicacao = explainRequest !== null
        && trimmed === promptDeExplicacaoDeProcesso(explainRequest.pid)
      const anexarContexto = perguntaDaExplicacao
        || perguntaApontaParaAlvo(trimmed, alvoActual, processContext?.selectedProcess?.name ?? null)
      /**
       * Autorização verificada AGORA, com relógio vivo, uma só vez por envio. A
       * renderização pode mostrar o estado de há minutos; decidir por esse valor
       * deixava contexto fora depois dos 30 minutos prometidos.
       */
      const consentimentoProcesso = forcarLocal ? false : consentimentoVivoAgora()
      /** Oferta A/B: só uma autorização viva sabe qual foi escolhida — e só um
       *  pedido que leva contexto desse alvo pode consumi-la. */
      const modoDoEnvio: MatrixConsentMode | null = consentimentoProcesso && anexarContexto
        ? (autorizacoesOneShotRef.current.has(chaveConsentimento) ? "uma-vez" : "persistente")
        : null
      /** Alvo do histórico: o processo em causa ou «esta máquina» quando não há processo. */
      const alvoDoHistorico: AlvoProcesso = alvoActual ?? { pid: null, startedAt: null }
      // A marca de privacidade segue a decisão do CONTEXTO, não a palavra
      // «processo»: uma pergunta geral sobre processos viaja sem medições e sem
      // ser apagada do histórico pelo filtro (o fornecedor tem de a receber).
      const perguntaPrivada = processQuestion && anexarContexto
      const userMessage: Message = { role: "user", content: trimmed, privateProcessData: perguntaPrivada, privateTarget: perguntaPrivada ? alvoDoHistorico : undefined }
      // Base no espelho, não na closure: quando «Explicar» abre e envia no mesmo
      // commit, a conversa já tem a saudação e nenhuma mensagem é substituída.
      // Repetir a última pergunta (botão «Tentar novamente») não a escreve outra
      // vez: a conversa mostrava a mesma pergunta duas vezes.
      const ultimaPergunta = [...messagesRef.current].reverse().find((m) => m.role === "user")
      const jaPerguntada = isRetry && ultimaPergunta?.content === trimmed
      const nextMessages = jaPerguntada ? messagesRef.current : acrescentarMensagem(messagesRef.current, userMessage)
      substituirMensagens(nextMessages)
      setInput("")
      // Uma pergunta nova substitui a oferta de IA do «Explicar» anterior: a
      // oferta era sobre outra pergunta e outro alvo, não uma acção pendente.
      setOfertaIa(null)
      setStreamed("")
      streamedRef.current = ""

      // Limite de histórico — envia apenas as últimas N mensagens.
      const payloadHistory = nextMessages.slice(-MAX_HISTORY)

      setPhase("thinking")
      const identityLost = identidadeDeExplicacaoPerdida(explainRequest, explainIdentity)
      const localReply = identityLost
        ? {content: buildIdentityLostReply(explainRequest?.pid, explainIdentity === "sumido" ? "sumido" : "reutilizado"), isDanger: false, isOffTopic: false}
        : processQuestion
        ? {content: buildProcessLocalReply(processDiagnostic, processContext?.selectedProcess?.pid ?? explainRequest?.pid, processContext?.selectedProcess), isDanger: false, isOffTopic: false}
        : offlineReply(trimmed, currentPage, modoDoPedido)

      // UMA decisão para todas as perguntas: responde primeiro o que já está na
      // máquina, e só vai ao fornecedor o que não tem motivo de intercepção. Antes
      // isto estavam cinco `if`s soltos e a resposta não dizia de onde vinha — que
      // era exactamente o defeito: um diagnóstico local parecia uma resposta de IA.
      const rota = {
        texto: trimmed,
        // O gate de consentimento só se aplica quando há MESMO contexto do alvo a
        // enviar. Discutir «processos» em geral é chat geral e não requer telemetria;
        // a marca de privacidade da mensagem usa a mesma decisão (`perguntaPrivada`).
        perguntaProcesso: processQuestion && anexarContexto,
        perguntaSegurancaLocal: isLocalSecurityQuestion(trimmed),
        identidadePerdida: identityLost,
        perigo: localReply.isDanger === true,
        foraDoTema: localReply.isOffTopic === true,
        // `forcarLocal` só APERTA o gate: a recusa explícita decide local sem
        // depender da closure de `processConsent` desta renderização. Nunca o
        // contrário — não há caminho por aqui que autorize envio sem autorização.
        consentimentoProcesso,
        temContextoProcesso: processContext !== null,
        // Opt-in explícito (a porta única usa `forcar`) com autorização válida
        // vence o estado/cooldown anterior: `mode` começa em local porque já não
        // há sonda automática ao fornecedor, e uma falha antiga não pode impedir
        // uma escolha nova e autorizada. Sem opt-in explícito, o cooldown vale.
        modoLocal: mode === "local" && Date.now() < localUntilRef.current
          && !(forcar && consentimentoProcesso),
        // Escolha visível: em «Local» este turno não contacta o fornecedor, mesmo
        // com um grant válido. O consentimento não é consumido nem revogado.
        modoConversaLocal: modoDoPedido === "local",
      }
      const motivo = motivoDoEncaminhamentoLocal(rota)
      /**
       * Todas estas respostas são construídas aqui: a origem é sempre `"local"`.
       * O `route` diz PORQUÊ — e é essa palavra que falta quando «local» podia
       * significar «não autorizaste» ou «o fornecedor não respondeu».
       */
      const responderLocal = (content: string, privada: boolean, semMarcaPrivada = false, estado: MatrixRequestState = estadoDoMotivoLocal(motivo)) => {
        setPhase("idle")
        anexarMensagem(
          semMarcaPrivada
            ? { role: "assistant", content, origin: "local" as const, state: estado }
            : { role: "assistant", content, privateProcessData: privada, privateTarget: privada ? alvoDoHistorico : undefined, origin: "local" as const, state: estado },
        )
      }

      // As medições do processo ficam locais até consentimento explícito, mas NÃO
      // degradam o estado global da IA (que continua online para perguntas gerais).
      if (motivo === "sem-consentimento" || motivo === "identidade-perdida") {
        return responderLocal(localReply.content, true)
      }
      // Pedido perigoso ou fora do tema: responde-se localmente (nunca ao provider).
      if (motivo === "perigo") return responderLocal(localReply.content, processQuestion)
      if (motivo === "fora-do-tema") return responderLocal(localReply.content, false, true)

      // POSTHUMAN13: perguntas de estado do PC ("Meu PC está
      // seguro?") respondem-se LOCALMENTE, ANTES do fornecedor,
      // a partir do snapshot real recente do serviço lido pela
      // bridge existente. Estas perguntas nunca tocam o provider
      // quando há snapshot (zero externo, inclusive em erro/staleness). Um snapshot
      // que chega tarde (cancelar/janela fechada) é descartado: sem late append.
      let respostaLocalDisponivel = false
      if (motivo === "seguranca-local") {
        const answer = await answerLocalSecurityQuestion(
          trimmed,
          window.electronAPI ?? null,
          { signal: controller.signal },
        )
        if (shouldDiscardLateAnswer({
          signalAborted: controller.signal.aborted,
          questionId,
          currentQuestionId: questionGenerationRef.current,
        })) return
        if (deveDescartarResposta()) return
        respostaLocalDisponivel = answer !== null
        if (answer) return responderLocal(answer.reply, true)
      }

      // Sem snapshot recente não há diagnóstico local, e «sem diagnóstico» não é
      // resposta: a decisão passa a ser a de qualquer outra pergunta, com os
      // restantes guardas reavaliados sobre a mesma matriz (cooldown, perigo,
      // fora do tema, consentimento). Usar aqui `destinoDaMensagem(rota)` fixava
      // `seguranca-local` e nunca deixava a pergunta chegar ao fornecedor.
      const aposTentativaLocal = decisaoAposTentativaLocal(rota, respostaLocalDisponivel)
      if (aposTentativaLocal.destino === "local") {
        return responderLocal(localReply.content, processQuestion, false, estadoDoMotivoLocal(aposTentativaLocal.motivo))
      }

      let attempts = 0
      const maxAttempts = modoDoEnvio === "uma-vez" ? 0 : isRetry ? Math.min(2, MAX_RETRIES) : MAX_RETRIES
      const autorizacaoDesteEnvio = modoDoEnvio === "uma-vez" ? autorizacaoUnicaRef.current : null
      // Consumo ANTES do primeiro envio: um retry não pode reutilizar a oferta A.
      if (modoDoEnvio === "uma-vez") {
        autorizacoesOneShotRef.current.delete(chaveConsentimento)
        autorizacaoUnicaRef.current = null
        setAutorizacoes(prev => revogarAlvo(prev, alvoConsentimento))
      }

      while (attempts <= maxAttempts) {
        if (controller.signal.aborted) break
        try {
          const result = await sendToServer(payloadHistory, controller.signal, true, () => {
            if (!deveDescartarResposta()) setPhase("streaming")
          }, consentimentoProcesso, () => !deveDescartarResposta(), consentimentoProcesso ? alvoDoHistorico : null, modoDoEnvio, anexarContexto, autorizacaoDesteEnvio)
          if (deveDescartarResposta()) return
          if (controller.signal.aborted) {
            setPhase("idle")
            return
          }
          if (result.ok && typeof result.content !== "undefined") {
            const content = result.content
            setMode("online")
            setProviderState("Provider respondeu nesta sessão")
            setPhase("idle")
            // A origem vem deste resultado, não do `mode`: só conta «IA» o que o
            // fornecedor devolveu concluído. Um `ok` sem conteúdo é local.
            anexarMensagem({
              role: "assistant",
              content,
              privateProcessData: anexarContexto && (processQuestion || consentimentoProcesso),
              privateTarget: (anexarContexto && (processQuestion || consentimentoProcesso)) ? alvoDoHistorico : undefined,
              origin: originDaResposta({ pediuProvider: true, ok: result.ok, content }),
              state: estadoDoResultado({ motivo: null, pediuProvider: true, ok: result.ok, content }),
            })
            return
          }
          if (result.code === "rate_limited") {
            setPhase("rate_limited")
            anexarMensagem({
              role: "assistant",
              content: "Cheguei ao limite de pedidos por enquanto. Aguarda uns segundos e tenta de novo — estou aqui.",
              origin: originDaResposta({ pediuProvider: true, ok: false, code: result.code }),
              state: estadoDoResultado({ motivo: null, pediuProvider: true, ok: false, code: result.code }),
            })
            return
          }
          if (result.code === "no_provider" || result.code === "auth" || result.code === "model_unavailable" || result.code === "provider_unavailable") {
            // Provider indisponível → fallback local (com cooldown).
            setPhase("idle")
            anexarMensagem({
              role: "assistant",
              content: result.code === "provider_unavailable"
                ? "A IA está indisponível neste momento: a falha é do lado do fornecedor. Podes tentar novamente dentro de instantes."
                : result.message || "O serviço de IA está temporariamente indisponível. Podes tentar novamente.",
              privateProcessData: processQuestion,
              privateTarget: processQuestion ? alvoDoHistorico : undefined,
              origin: originDaResposta({ pediuProvider: true, ok: false, code: result.code }),
              state: estadoDoResultado({ motivo: null, pediuProvider: true, ok: false, code: result.code }),
            })
            return
          }
          if (
            result.code === "credential_blocked" ||
            result.code === "provider_rejected" ||
            result.code === "invalid_request" ||
            result.code === "process_consent_missing" ||
            result.code === "process_context_invalid" ||
            result.code === "consent_api_unreachable" ||
            codigoDeConsentimentoRecusado(result.code)
          ) {
            // Recusa estável do NOSSO serviço, ANTES do fornecedor. Repetir o
            // mesmo texto dá o mesmo 400 — chamar-lhe «erro temporário» era a
            // leitura errada que o gate humano encontrou (2026-10-23). O estado
            // próprio diz que nada saiu da máquina, e a mensagem do serviço
            // distingue falta de autorização de pedido mal formado.
            //
            // Grant inválido/expirado/revogado NÃO desce para one-shot: a
            // autoridade local é retirada e a pessoa autoriza de novo.
            if (codigoDeConsentimentoRecusado(result.code)) {
              setAutorizacoes([])
              aplicarConsentimentoExterno({ descriptor: consentimentoExternoRef.current.descriptor, grant: null })
              setConsentErro(mensagemDeConsentimento(result.code))
            }
            setPhase("idle")
            anexarMensagem({
              role: "assistant",
              content: result.code === "provider_rejected"
                ? mensagemDeRecusaDoFornecedor(result.message)
                : result.message || (codigoDeConsentimentoRecusado(result.code)
                  ? mensagemDeConsentimento(result.code)
                  : "O pedido foi recusado pelo serviço de IA. Nada foi enviado ao fornecedor."),
              privateProcessData: processQuestion,
              privateTarget: processQuestion ? alvoDoHistorico : undefined,
              origin: "local" as const,
              state: result.code === "provider_rejected" ? "recusado-pelo-fornecedor" as const : "pedido-recusado" as const,
            })
            return
          }
          // Erro transitório → retry limitado.
          setPhase("thinking")
        } catch (err) {
          if (deveDescartarResposta()) return
          if (err instanceof Error && err.name === "AbortError") {
            setPhase("idle")
            return
          }
          // network error → retry
          setPhase("thinking")
        }
        attempts++
      }

      // Esgotou retries → fallback local, com o estado que oferece nova tentativa.
      if (deveDescartarResposta()) return
      setPhase("error")
      // `network` é o código do que falhou AQUI: expirações e ligação cortada,
      // não um fornecedor que não existe. O texto diz «tenta novamente»; o estado
      // tem de dizer o mesmo, senão «IA indisponível» tornava-se outra vez o
      // caixote de tudo que o gate humano lia como «offline».
      anexarMensagem({
        role: "assistant",
        content: "Não foi possível contactar o fornecedor de IA neste momento. Tenta novamente.",
        privateProcessData: processQuestion,
        privateTarget: processQuestion ? alvoDoHistorico : undefined,
        origin: originDaResposta({ pediuProvider: true, ok: false, code: "network" }),
        state: estadoDoResultado({ motivo: null, pediuProvider: true, ok: false, code: "network" }),
      })
    },
    [messages, phase, currentPage, sendToServer, mode, consentimentoVivoAgora, conversationId, processContext, processDiagnostic, explainRequest, explainIdentity, alvoActual, anexarMensagem, substituirMensagens, aplicarConsentimentoExterno],
  )

  // O efeito de «Explicar na MATRIX» precisa da versão mais recente desta função;
  // é um ref, não uma segunda implementação.
  processMessageRef.current = processMessage

  const handleSend = () => {
    processMessage(input, false, false, false, modoConversa)
  }

  const handleSuggestion = (label: string) => {
    processMessage(label, false, false, false, modoConversa)
  }

  const handleStop = () => {
    intencaoExplicarRef.current = null
    questionGenerationRef.current += 1
    cancelLocalSecurityRequest(abortRef.current)
    // Parar é recusar o que está no ar: sem abort e sem tirar o dono, a resposta
    // continuava a chegar e era aceite depois de a pessoa ter dito «chega».
    abortRef.current?.abort()
    abortRef.current = null
    pedidoActivoRef.current = null
    setStreamed("")
    streamedRef.current = ""
    setPhase("idle")
  }

  /**
   * Reinicia SÓ a conversa: mensagens, streaming, rascunho e consentimento de
   * contexto. Modo do launcher, posição, histórico das outras conversas e
   * configurações não são tocados. O incremento da geração descarta respostas
   * que cheguem atrasadas da conversa anterior.
   */
  const resetConversation = useCallback(() => {
    intencaoExplicarRef.current = null
    questionGenerationRef.current += 1
    cancelLocalSecurityRequest(abortRef.current)
    // Conversa nova é conversa DIFERENTE: um id novo é o que faz uma resposta a
    // meio da conversa anterior cair no eixo da conversa, e não só da geração.
    setConversationId(novaIdDeConversa())
    abortRef.current?.abort()
    abortRef.current = null
    pedidoActivoRef.current = null
    stickToBottomRef.current = true
    setPhase("idle")
    setStreamed("")
    streamedRef.current = ""
    setInput("")
    setAutorizacoes([])
    autorizacoesOneShotRef.current.clear()
    autorizacaoUnicaRef.current = null
    // Estado de falha NAO sobrevive a uma conversa nova: foi reportado no gate
    // humano como «erro do fornecedor na conversa antiga, Oi na nova a funcionar».
    localUntilRef.current = 0
    explicacaoResolvidaRef.current = null
    // A conversa nova NÃO reexecuta um «Explicar» antigo: o pedido actual fica
    // consumido. Anular isto aqui fazia o efeito voltar a enviar a pergunta para
    // dentro da conversa limpa — a «nova conversa diferente» do gate humano.
    ultimoExplicacaoAutoRef.current = explainRequestRef.current?.id ?? null
    setExplicacaoPendente(null)
    setOfertaIa(null)
    ultimaExplicacaoLocalRef.current = null
    setAutorizacaoAberta(false)
    setConsentErro(null)
    substituirMensagens(initialMatrixMessages())
  }, [substituirMensagens])

  /**
   * TROCA DE CONTA / LOGOUT: não pode haver histórico privado da conta A a ser
   * enviado sob uma autorização da conta B, mesmo com o mesmo PID e instante.
   * A limpeza usa o MESMO reset de conversa: aborta o pedido em voo, invalida a
   * geração, descarta pendentes/ofertas e apaga o histórico visível (incluindo
   * as mensagens privadas). Sem polling; o efeito só corre quando a identidade
   * da conta muda.
   */
  useEffect(() => {
    if (contaAnteriorRef.current === contaId) return
    contaAnteriorRef.current = contaId
    resetConversation()
    // O grant é da conta+instalação: trocar de conta não pode reutilizar o
    // descriptor/grant da anterior enquanto a API não responder de novo. O
    // bloqueio de uma revogação falhada também é da conta anterior.
    aplicarConsentimentoExterno({ descriptor: null, grant: null })
    consentimentoBloqueadoRef.current = false
    setConsentimentoBloqueado(false)
    setConsentErro(null)
  }, [contaId, resetConversation, aplicarConsentimentoExterno])

  const handleRetry = () => {
    // Depois de uma falha há uma mensagem da assistente no fim; repetir tem de
    // voltar à última PERGUNTA, senão o botão não fazia nada.
    const lastUser = [...messages].reverse().find((m) => m.role === "user")
    if (lastUser) processMessage(lastUser.content, true, false, false, modoConversa)
  }

  const canCancel = phase === "thinking" || phase === "streaming"
  const showThinking = phase === "thinking" || phase === "streaming"
  const enviando = phase === "thinking" || phase === "streaming"

  /**
   * Autorizar o alvo EM CAUSA (processo ou máquina). A oferta A (`uma-vez`) não
   * cria grant e é consumida no envio; a oferta B (`persistente`) é o único
   * caminho que faz POST. Nenhuma é escolhida por omissão: o modo é parâmetro
   * obrigatório. O pedido pendente é retomado pelo efeito que já existe.
   */
  const autorizarAlvoEmCausa = async (modo: MatrixConsentMode) => {
    if (consentCarregando) return
    setConsentErro(null)
    setConsentCarregando(true)
    try {
      let descriptor = consentimentoExternoRef.current.descriptor
      let grant = consentimentoExternoRef.current.grant
      if (grant && !(Date.parse(grant.expiresAt) > Date.now())) grant = null
      // O descriptor é sempre local e necessário nas duas ofertas; a oferta A
      // não depende de um grant, a B exige-o.
      if (!descriptor) {
        const lido = await lerConsentimento(API_BASE, authHeaders())
        if (!lido) {
          setConsentErro("A API local não devolveu o descriptor de consentimento. A resposta continua local.")
          return
        }
        descriptor = lido.descriptor
        grant = lido.grant
        aplicarConsentimentoExterno({ descriptor, grant })
      }
      if (!descriptor) {
        setConsentErro("O descriptor local desapareceu. Nada foi autorizado.")
        return
      }
      // B só evita o POST quando o grant que já existe é VÁLIDO para esta conta,
      // instalação, fornecedor, âmbito e prazo. Um grant presente mas inválido não
      // é promovido a autoridade: a escolha B pede um novo consentimento.
      const grantValido = grant !== null && contaId !== null
        && decidirConsentimentoDeEnvio({ descriptor, grant }, "persistente", contaId, Date.now()).ok
      if (modo === "persistente" && !grantValido) {
        const criado = await criarConsentimento(API_BASE, descriptor, authHeaders())
        if (!criado.ok) {
          setConsentErro(criado.message)
          return
        }
        descriptor = criado.state.descriptor
        grant = criado.state.grant
        aplicarConsentimentoExterno({ descriptor, grant })
      }
      const chave = alvoDePedido(alvoConsentimento) ?? "maquina"
      if (modo === "uma-vez") {
        // A (R2): o clique EXPLICITO pede um token ao servidor local. Sem PID +
        // startedAt canonicos o one-shot nao existe (nao se fabrica alvo).
        const alvoUnico = alvoUnicoCanonico(alvoConsentimento)
        if (!alvoUnico) {
          setConsentErro("A autorização de um envio exige um processo identificável (PID e início). Para esta conversa, usa a oferta persistente ou o diagnóstico local.")
          return
        }
        const contaInicio = contaIdRef.current
        const pedidoUnico = await pedirAutorizacaoUnica(API_BASE, descriptor, alvoUnico, authHeaders())
        if (!pedidoUnico.ok) {
          setConsentErro(pedidoUnico.message)
          return
        }
        // O await e a janela onde conta/fornecedor podem mudar: falha fechada.
        if (contaIdRef.current !== contaInicio) {
          setConsentErro("A conta mudou durante a autorização. Nada foi enviado; autoriza de novo.")
          return
        }
        if (consentimentoExternoRef.current.descriptor?.providerKey !== descriptor.providerKey) {
          setConsentErro(mensagemDeConsentimento("process_consent_provider_mismatch"))
          return
        }
        autorizacaoUnicaRef.current = pedidoUnico.authorization
        setAutorizacoes(prev => autorizarAlvo(prev, alvoConsentimento, Date.now(), descriptor.providerKey))
        autorizacoesOneShotRef.current.add(chave)
      } else {
        // B: a autoridade é o grant do servidor, não uma caixa por PID. Uma
        // autorização A antiga para este alvo deixa de ser a razão do envio; o
        // grant continua a cobrir pedidos futuros de outros PID, com histórico
        // filtrado pelo alvo de cada pedido.
        setAutorizacoes(prev => revogarAlvo(prev, alvoConsentimento))
        autorizacoesOneShotRef.current.delete(chave)
        autorizacaoUnicaRef.current = null
      }
      // A ou B são a acção explícita que levanta o bloqueio de uma revogação
      // falhada. Sem ela, o GET não reabre sozinho o envio.
      consentimentoBloqueadoRef.current = false
      setConsentimentoBloqueado(false)
      setConsentErro(null)
      setAutorizacaoAberta(false)
    } finally {
      setConsentCarregando(false)
    }
  }

  /**
   * Fecha a autoridade local sem tocar no servidor. Uma resposta em voo deixa
   * de poder usar o que já não está autorizado; o histórico privado deixa de
   * entrar no próximo payload. Chamado pela revogação e pelo evento de
   * Configurações.
   */
  const invalidarConsentimentoLocal = useCallback((bloquear = false) => {
    consentimentoBloqueadoRef.current = bloquear
    setConsentimentoBloqueado(bloquear)
    questionGenerationRef.current += 1
    intencaoExplicarRef.current = null
    cancelLocalSecurityRequest(abortRef.current)
    abortRef.current?.abort()
    abortRef.current = null
    pedidoActivoRef.current = null
    setPhase("idle")
    setStreamed("")
    streamedRef.current = ""
    setAutorizacoes([])
    autorizacoesOneShotRef.current.clear()
    autorizacaoUnicaRef.current = null
    setExplicacaoPendente(null)
    setOfertaIa(null)
    setAutorizacaoAberta(false)
    setConsentErro(null)
    aplicarConsentimentoExterno({
      descriptor: consentimentoExternoRef.current.descriptor,
      grant: null,
    })
  }, [aplicarConsentimentoExterno])

  useEffect(() => subscreverRevogacaoDeConsentimento((aviso) => {
    // Metadata de conta: um aviso de outra conta não apaga esta conversa.
    if (aviso.accountId !== null && contaId !== null && aviso.accountId !== contaId) return
    if (aviso.phase === "confirmed") {
      // O servidor confirmou a revogação: não há grant a preservar. O GET deste
      // painel volta a ler o estado; se o servidor já não devolver grant, o envio
      // fica naturalmente fechado. Só a FALHA mantém o bloqueio local explícito.
      invalidarConsentimentoLocal(false)
      setConsentErro(null)
      return
    }
    // `started` e `failed` bloqueiam já: entre o clique em Revogar e a resposta
    // do servidor não pode sair um envio com o grant que está a ser retirado.
    invalidarConsentimentoLocal(true)
    setConsentErro(aviso.phase === "failed"
      ? "O serviço local não confirmou a revogação. O envio de medições ficou bloqueado até voltares a autorizar."
      : "Revogação em curso. O envio de medições está bloqueado até a confirmação.")
  }), [contaId, invalidarConsentimentoLocal])

  /**
   * Revogar é possível sempre, mesmo sem pedido pendente. O DELETE revoga TODOS
   * os grants da conta+instalação; só um HTTP de sucesso permite dizer que a
   * autoridade fechou. Em falha, o envio local pára na mesma e a UI diz que o
   * servidor não confirmou.
   */
  const revogarAlvoEmCausa = async () => {
    if (consentCarregando) return
    setConsentCarregando(true)
    invalidarConsentimentoLocal(true)
    // A MATRIX e as Configurações fecham a autoridade já no início; o DELETE é
    // a confirmação, não a condição para parar de enviar.
    notificarRevogacaoDeConsentimento({ accountId: contaId, phase: "started", serverConfirmed: false })
    try {
      const resultado = await revogarConsentimento(API_BASE, authHeaders())
      if (!resultado.ok) {
        setConsentErro("Não foi possível confirmar a revogação no serviço local. O envio de medições ficou bloqueado até voltares a autorizar.")
        setAutorizacaoAberta(true)
        notificarRevogacaoDeConsentimento({ accountId: contaId, phase: "failed", serverConfirmed: false })
        return
      }
      setConsentErro(null)
      // As Configurações, se estiverem montadas, relêem o estado em vez de
      // continuarem a mostrar um grant que já foi revogado.
      notificarRevogacaoDeConsentimento({ accountId: contaId, phase: "confirmed", serverConfirmed: true })
    } finally {
      setConsentCarregando(false)
    }
  }

  // ── Geometria do launcher (TP-MATRIX-DRAG, port por seleção do 0de640b) ────────────────────────────────────────
  // Toda a aritmética vive em `lib/matrixLauncherPosition.ts` (pura e testada);
  // aqui só se mede, se aplica e se persiste. `{x, bottom}` são distâncias ao
  // viewport. Default: canto inferior ESQUERDO, fora da Sidebar (sidebarWidth).
  const launcherButtonRef = useRef<HTMLButtonElement | null>(null)
  const launcherRowRef = useRef<HTMLDivElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [launcherSize, setLauncherSize] = useState<Size>({ w: 56, h: 56 })
  const [launcherFootprint, setLauncherFootprint] = useState<Size>({ w: 56, h: 56 })
  const [topInset, setTopInset] = useState(0)
  const [reservedBottom, setReservedBottom] = useState(0)
  const [sidebarWidth, setSidebarWidth] = useState(0)
  const [pos, setPos] = useState<Pos | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const dragRef = useRef<{ id: number; from: Pos; to: Pos; startClient: Point } | null>(null)
  // Um arrasto termina em `pointerup` e o browser dispara `click` logo a seguir.
  // Sem este travão, mover o launcher também abria/fechava o chat.
  const suppressClickRef = useRef(false)

  const viewport = useCallback((): Size => ({
    w: typeof window === "undefined" ? 1024 : window.innerWidth,
    h: typeof window === "undefined" ? 768 : window.innerHeight,
  }), [])

  /** Reserva real: topo do bloco de conta (marcado na Sidebar) até à base, e largura real da Sidebar. */
  const measureLayoutMetrics = useCallback(() => {
    if (typeof document === "undefined") return { reserved: 0, sidebarW: 0 }
    const vp = viewport()
    const reserveEl = document.querySelector('[data-cs-reserve="matrix"]')
    const reserved = reserveEl
      ? reservedBottomFromFooter({ top: reserveEl.getBoundingClientRect().top, height: reserveEl.getBoundingClientRect().height }, vp)
      : 0
    const sidebarEl = document.querySelector('[data-cs-sidebar="main"]') ?? document.querySelector('aside[aria-label="Navegação principal"]')
    const sidebarRect = sidebarEl?.getBoundingClientRect()
    // A Sidebar do shell V2 vive em x=12 (shell.css), nao em 0: exigir
    // left <= 8 media 0 e desligava o clamp, deixando o launcher por cima do
    // rodape (VM 20261029: Terminar sessao/Recolher navegacao tapados).
    const sidebarW =
      sidebarRect && sidebarRect.width > 0 && sidebarRect.left >= 0 && sidebarRect.left < vp.w / 2
        ? Math.round(sidebarRect.right)
        : 0
    return { reserved, sidebarW }
  }, [viewport])

  const effectivePos = useCallback((): Pos => {
    const vp = viewport()
    return clampPos(pos ?? defaultPos(vp, launcherSize, reservedBottom, sidebarWidth), vp, launcherSize, reservedBottom, sidebarWidth)
  }, [pos, launcherSize, reservedBottom, sidebarWidth, viewport])

  useLayoutEffect(() => {
    const applyMeasurements = () => {
      const { reserved, sidebarW } = measureLayoutMetrics()
      setReservedBottom(reserved)
      setSidebarWidth(sidebarW)
      const btnNode = launcherButtonRef.current ?? rootRef.current
      const vp = viewport()
      const measured = btnNode
        ? { w: btnNode.offsetWidth || 56, h: btnNode.offsetHeight || 56 }
        : { w: 56, h: 56 }
      setLauncherSize(measured)
      // Pegada REAL do bloco: avatar + botão de menu. O painel abre acima do
      // bloco inteiro e alinha-se ao avatar, não à borda do menu.
      const rowNode = launcherRowRef.current
      setLauncherFootprint(
        rowNode && rowNode.offsetWidth > 0 && rowNode.offsetHeight > 0
          ? { w: rowNode.offsetWidth, h: rowNode.offsetHeight }
          : measured,
      )
      // Barra de janela (42 px via --shell-titlebar-h): o painel não pode abrir
      // por baixo dela. Mede-se a caixa pintada; sem barra, 0.
      const titleBar = document.querySelector('[data-testid="app-titlebar"]')
      const barBottom = titleBar?.getBoundingClientRect().bottom
      setTopInset(typeof barBottom === "number" && Number.isFinite(barBottom) && barBottom > 0 ? Math.round(barBottom) : 0)
      setPos((current) => {
        const stored = parseStored(safeReadPos(), vp, measured, reserved, sidebarW)
        const base = current ?? stored ?? defaultPos(vp, measured, reserved, sidebarW)
        return clampPos(base, vp, measured, reserved, sidebarW)
      })
    }
    applyMeasurements()
    window.addEventListener("resize", applyMeasurements)
    let observer: ResizeObserver | undefined
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => applyMeasurements())
      if (launcherButtonRef.current) observer.observe(launcherButtonRef.current)
      if (launcherRowRef.current) observer.observe(launcherRowRef.current)
      const sidebarNode = document.querySelector('[data-cs-sidebar="main"]')
      if (sidebarNode) observer.observe(sidebarNode) // colapso/expansão da Sidebar sem resize da janela
    }
    return () => {
      window.removeEventListener("resize", applyMeasurements)
      observer?.disconnect()
    }
    // `launcherMode` está nas dependências porque minimizar/fixar desmonta a
    // linha do launcher: sem nova medição, a pegada ficava a do modo anterior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launcherMode, measureLayoutMetrics, viewport])

  function safeReadPos(): string | null {
    try {
      return localStorage.getItem(MATRIX_POS_KEY)
    } catch {
      return null
    }
  }

  const persistPos = useCallback((next: Pos) => {
    try {
      localStorage.setItem(MATRIX_POS_KEY, serialize(next))
    } catch {
      /* sem armazenamento vale só para esta sessão — nunca rebenta o arrasto */
    }
  }, [])

  function safeReadLauncherMode(): string | null {
    try {
      return localStorage.getItem(MATRIX_MODE_KEY)
    } catch {
      return null
    }
  }

  const persistLauncherMode = useCallback((next: MatrixMode) => {
    setLauncherModeState(next)
    setMenuOpen(false)
    try {
      localStorage.setItem(MATRIX_MODE_KEY, next)
    } catch {
      /* sem armazenamento: o modo vale para esta sessão */
    }
  }, [])

  /** Mede a zona de encaixe da barra lateral (0 px quando ninguém está fixado). */
  const measureDockSlot = useCallback((): Pos | null => {
    if (typeof document === "undefined") return null
    const el = document.querySelector('[data-cs-matrix-dock]')
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const vp = viewport()
    return {
      x: Math.round(rect.left + (rect.width - launcherSize.w) / 2),
      bottom: Math.round(vp.h - rect.bottom),
    }
  }, [launcherSize.w, viewport])

  // PAINEL LATERAL: publica a largura real do painel e um sinal no <html>
  // para a área principal ceder esse espaço (`[data-cs-main]` em index.css).
  // Sem isto o painel tapava gráficos e alertas.
  useEffect(() => {
    if (typeof document === "undefined") return
    const root = document.documentElement
    if (launcherMode !== "panel") {
      root.removeAttribute("data-matrix-panel")
      root.style.removeProperty("--matrix-panel-w")
      return
    }
    const place = computeSidePanelPlacement(viewport(), sidebarWidth, topInset)
    root.setAttribute("data-matrix-panel", "open")
    root.style.setProperty("--matrix-panel-w", `${place.width + 2 * EDGE_INSET_PX}px`)
    return () => {
      root.removeAttribute("data-matrix-panel")
      root.style.removeProperty("--matrix-panel-w")
    }
  }, [launcherMode, sidebarWidth, topInset, viewport])

  // A reserva é de scroll, não uma parede que limita o arrasto do launcher.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--matrix-floating-clearance", `${floatingLauncherClearance(launcherMode, launcherFootprint)}px`);
    return () => { root.style.removeProperty("--matrix-floating-clearance"); };
  }, [launcherMode, launcherFootprint]);

  // O encaixe reserva altura na barra por um token: 0 px fora do modo fixado.
  useEffect(() => {
    if (typeof document === "undefined") return
    const root = document.documentElement
    root.style.setProperty("--matrix-dock-slot-h", launcherMode === "docked" ? `${DOCK_SLOT_PX}px` : "0px")
    return () => { root.style.removeProperty("--matrix-dock-slot-h") }
  }, [launcherMode])

  useEffect(() => {
    if (launcherMode !== "docked") { setDockSlot(null); return }
    const sync = () => setDockSlot(measureDockSlot())
    sync()
    window.addEventListener("resize", sync)
    return () => window.removeEventListener("resize", sync)
  }, [launcherMode, measureDockSlot, sidebarWidth])

  const onPointerDown = useCallback((event: RPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 && event.pointerType === "mouse") return
    // Fixada: o gesto de arrasto não se aplica — para a soltar há o menu (e um
    // arrasto a partir do encaixe começaria numa posição que não é a visível).
    if (launcherMode === "docked") return
    const start = effectivePos()
    dragRef.current = {
      id: event.pointerId,
      from: start,
      to: start,
      startClient: { x: event.clientX, y: event.clientY },
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }, [effectivePos, launcherMode])

  const onPointerMove = useCallback((event: RPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (!drag || drag.id !== event.pointerId) return
    // Durante o gesto a barra lateral NÃO é uma parede: é a zona de encaixe.
    // A largura medida continua a ser passada (a reserva do rodapé decide-se
    // pelo `x` real); `allowDockBand` é o que deixa atravessar a banda dela.
    // Quem não largar lá é re-encaixado fora dela no `pointerup`.
    const next = projectPointerDrag(
      drag.from,
      drag.startClient,
      { x: event.clientX, y: event.clientY },
      viewport(),
      launcherSize,
      reservedBottom,
      sidebarWidth,
      { allowDockBand: true },
    )
    drag.to = next
    if (movedEnoughToDrag(drag.from, next)) {
      const overDock = isDockGesture(next, launcherSize, sidebarWidth)
      dockHoverRef.current = overDock
      setDockHover(overDock)
      setIsDragging(true)
      setPos(next)
    }
  }, [launcherSize, reservedBottom, sidebarWidth, viewport])

  const onPointerUp = useCallback((event: RPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (!drag || drag.id !== event.pointerId) return
    dragRef.current = null
    setIsDragging(false)
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    const estavaSobreEncaixe = dockHoverRef.current
    dockHoverRef.current = false
    setDockHover(false)
    if (movedEnoughToDrag(drag.from, drag.to)) {
      suppressClickRef.current = true
      if (estavaSobreEncaixe) {
        // Soltar sobre a barra fixa a Matrix lá; a posição flutuante fica
        // guardada para quando o utilizador a soltar outra vez.
        persistPos(clampPos(drag.to, viewport(), launcherSize, reservedBottom, 0))
        persistLauncherMode("docked")
      } else {
        const vp = viewport()
        // Fora da zona de encaixe, o launcher volta para fora da barra.
        const final = clampPos(drag.to, vp, launcherSize, reservedBottom, sidebarWidth)
        setPos(final)
        persistPos(final)
      }
    }
  }, [launcherSize, persistLauncherMode, persistPos, reservedBottom, sidebarWidth, viewport])

  const onLauncherKeyDown = useCallback((event: RKeyboardEvent<HTMLButtonElement>) => {
    if (launcherMode === "docked") return
    const vp = viewport()
    const base = effectivePos()
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-KEYBOARD_STEP_PX, 0], ArrowRight: [KEYBOARD_STEP_PX, 0],
      ArrowUp: [0, KEYBOARD_STEP_PX], ArrowDown: [0, -KEYBOARD_STEP_PX],
    }
    if (delta[event.key]) {
      event.preventDefault()
      const [dx, db] = delta[event.key]
      const next = clampPos({ x: base.x + dx, bottom: base.bottom + db }, vp, launcherSize, reservedBottom, sidebarWidth)
      setPos(next)
      persistPos(next)
      return
    }
    if (event.key === "Home" || event.key === "0") {
      event.preventDefault()
      setPos(defaultPos(vp, launcherSize, reservedBottom, sidebarWidth))
      try {
        localStorage.removeItem(MATRIX_POS_KEY)
      } catch {
        /* ignore */
      }
    }
  }, [effectivePos, launcherMode, launcherSize, persistPos, reservedBottom, sidebarWidth, viewport])

  const resetPos = useCallback(() => {
    setPos(defaultPos(viewport(), launcherSize, reservedBottom, sidebarWidth))
    try {
      localStorage.removeItem(MATRIX_POS_KEY)
    } catch {
      /* sem armazenamento: o reset vale para esta sessão */
    }
  }, [launcherSize, reservedBottom, viewport, sidebarWidth])

  // MINIMIZADO: um botão pequeno, focável e com nome, no canto da área útil.
  // Não desenha chat nenhum — o estado da conversa fica intacto.
  if (launcherMode === "minimized") {
    const mini = computeMinimizedPos(viewport(), launcherSize, sidebarWidth)
    return (
      <button
        type="button"
        onClick={() => persistLauncherMode("floating")}
        style={{ left: mini.x, bottom: mini.bottom }}
        aria-label="Restaurar a Matrix"
        title="Matrix minimizada. Clica para restaurar."
        className="fixed z-[100] h-10 w-10 rounded-full cybersafe-focus flex items-center justify-center border border-primary/40 bg-card/90 shadow-lg text-primary transition-colors hover:bg-primary/10"
        data-matrix-mode="minimized"
      >
        <MatrixAvatar mood="mini" size="sm" rounded className="h-8 w-8" />
      </button>
    )
  }

  const appliedPos = effectivePos()

  // Origem do bloco: a posição flutuante, a zona de encaixe da Sidebar ou, no
  // painel lateral, a coluna à direita da área principal. O chat calcula-se a
  // partir da MESMA origem.
  const panelPlacement = launcherMode === "panel"
    ? computeSidePanelPlacement(viewport(), sidebarWidth, topInset)
    : null
  const origin = panelPlacement
    ? { x: panelPlacement.left, bottom: panelPlacement.bottom }
    : launcherMode === "docked" && dockSlot
      ? dockSlot
      : appliedPos
  const dockedPlacement = launcherMode === "docked"
    ? computeDockedChatPlacement(viewport(), sidebarWidth, reservedBottom)
    : null
  const chatPlacement = panelPlacement ?? dockedPlacement ?? computeChatPanelPlacement(origin, viewport(), launcherSize, sidebarWidth, reservedBottom, {
    topInset,
    footprint: launcherFootprint,
    anchorOffsetX: Math.max(0, launcherFootprint.w - launcherSize.w),
  })

  // Launcher: avatar + rótulo "Matrix AI", recolhe depois.
  // Posição: `origin` (default inferior esquerdo, fora da Sidebar, XY persistido).
  return (
    <div
      ref={rootRef}
      className="fixed z-[100] flex flex-col items-start gap-3"
      style={{ left: origin.x, bottom: origin.bottom }}
      data-matrix-pos-x={origin.x}
      data-matrix-pos-bottom={origin.bottom}
      data-matrix-reserved-bottom={reservedBottom}
      data-matrix-sidebar-w={sidebarWidth}
      data-matrix-top-inset={topInset}
      data-matrix-footprint-w={launcherFootprint.w}
      data-matrix-footprint-h={launcherFootprint.h}
      data-matrix-mode={launcherMode}
    >
      {/* Alvo de encaixe: aparece só durante o arrasto sobre a barra lateral.
          É uma pista visual, nunca um alvo de clique (pointer-events-none). */}
      {dockHover && sidebarWidth > 0 && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[99] rounded-xl border-2 border-dashed border-primary bg-primary/10"
          style={{ left: 8, width: Math.max(48, sidebarWidth - 16), bottom: reservedBottom + 8, height: DOCK_SLOT_PX }}
        />
      )}
      {/* Chat Window */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.9 }}
            className="absolute border border-primary/30 rounded-2xl bg-card/80 backdrop-blur-xl shadow-2xl flex flex-col overflow-hidden cyber-border"
            style={{
              left: chatPlacement.left - origin.x,
              bottom: chatPlacement.bottom - origin.bottom,
              width: chatPlacement.width,
              height: chatPlacement.height,
            }}
            data-matrix-chat-open={chatPlacement.openDirection}
            data-matrix-chat-left={chatPlacement.left}
            data-matrix-chat-bottom={chatPlacement.bottom}
            data-matrix-chat-width={chatPlacement.width}
            data-matrix-chat-height={chatPlacement.height}
          >
            {/* Header */}
            <div className="shrink-0 p-4 border-b border-primary/20 bg-primary/5 flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-3">
                <MatrixAvatar mood="avatar" size="sm" rounded />
                <div className="min-w-0">
                  <h3 className="text-xs font-bold font-mono text-primary uppercase tracking-widest">Matrix</h3>
                  <p className="truncate text-[9px] text-muted-foreground font-mono uppercase tracking-tighter">
                    Assistente de IA do CyberSafe ·{" "}
                    <span className={mode === "online" ? "text-cyber-green" : "text-cyber-yellow"}>
                      {matrixConfigLabelHonesto(mode)}
                    </span>
                  </p>
                </div>
              </div>
              {/* Escolha VISÍVEL do modo: intenção do utilizador, não a origem de
                  uma resposta. Cada botão anuncia o estado com aria-pressed e a
                  descrição diz o que a escolha faz (e não faz). */}
              <div
                role="group"
                aria-label="Modo da conversa"
                data-matrix-chat-mode-switch
                data-matrix-chat-mode-active={modoConversa}
                className="flex shrink-0 rounded-lg border border-border bg-background/30 p-0.5"
              >
                {(["local", "online"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    data-matrix-chat-mode={m}
                    aria-pressed={modoConversa === m}
                    aria-label={`Modo ${matrixChatModeLabel(m)}`}
                    title={matrixChatModeDescription(m)}
                    onClick={() => mudarModoConversa(m)}
                    className={cn(
                      "rounded px-2 py-0.5 text-[9px] font-mono uppercase tracking-wider transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
                      modoConversa === m
                        ? "bg-primary/15 text-primary"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {matrixChatModeLabel(m)}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => setConfigModalAberta(true)}
                  className="p-1 hover:bg-secondary rounded transition-colors"
                  aria-label="Configurar fornecedor de IA"
                  title="Configurar IA (Groq / OpenAI)"
                >
                  <KeyRound className="w-4 h-4 text-muted-foreground" />
                </button>
                <button
                  type="button"
                  onClick={resetConversation}
                  className="p-1 hover:bg-secondary rounded transition-colors"
                  aria-label="Nova conversa"
                  title="Nova conversa"
                >
                  <Plus className="w-4 h-4 text-muted-foreground" />
                </button>
                {launcherMode === "panel" && (
                  <>
                    <button
                      type="button"
                      onClick={() => persistLauncherMode("floating")}
                      className="p-1 hover:bg-secondary rounded transition-colors"
                      aria-label="Voltar a flutuar"
                      title="Voltar a flutuar"
                    >
                      <Move className="w-4 h-4 text-muted-foreground" />
                    </button>
                    <button
                      type="button"
                      onClick={() => persistLauncherMode("minimized")}
                      className="p-1 hover:bg-secondary rounded transition-colors"
                      aria-label="Minimizar a Matrix"
                      title="Minimizar a Matrix"
                    >
                      <Minimize2 className="w-4 h-4 text-muted-foreground" />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => setUpOpenState(false)}
                  className="p-1 hover:bg-secondary rounded transition-colors"
                  aria-label="Fechar assistente"
                >
                  <X className="w-4 h-4 text-muted-foreground" />
                </button>
              </div>
            </div>

            {/*
              Uma so barra de estado, sempre de uma linha. Antes havia quatro faixas
              `shrink-0` empilhadas acima da lista (offline, processo, pedido de
              autorizacao e privacidade expandida) e cada uma tirava altura ao unico
              sitio com scroll: abrir a privacidade comprimia as mensagens e
              saltava a posi de leitura — foi o que o gate humano viu. O que
              precisa de espaco passa a viver DENTRO do scroll, e a barra fica
              compacta por definicao.
            */}
            <div
              data-matrix-status-bar
              role="status"
              className="shrink-0 px-4 py-1 border-b border-border text-[10px] font-mono uppercase tracking-wider text-muted-foreground flex items-center justify-between gap-2"
            >
              <span className="truncate">
                {rotuloDoProcessoEmCausa({
                  pendente: explicacaoPendente,
                  pedido: explainRequest,
                  alvo: alvoActual,
                  nome: processContext?.selectedProcess?.name ?? null,
                })}
              </span>
              {/* O eixo do PEDIDO. A configuração vive no cabeçalho: pôr aqui
                  «Fornecedor verificado» fazia uma resposta local parecer IA. */}
              <span
                data-matrix-request-state
                className={cn("shrink-0", estadoVisivel === "generativa" ? "text-cyber-green" : estadoVisivel ? "text-cyber-yellow" : "text-muted-foreground")}
              >
                {matrixRoutingStateLabel(estadoVisivel) ?? "Sem pedido em curso"}
              </span>
            </div>

            {/* A barra de privacidade e uma linha; o pedido de autorizacao e o texto
    completo vivem DENTRO do scroll (ver data-matrix-consent-card), para que
    abrir a privacidade nunca roube altura as mensagens. */}
<div
  data-matrix-privacy-bar
  className="shrink-0 px-4 py-1 border-b border-border flex items-center justify-between gap-2 text-[10px] font-mono uppercase tracking-wider text-muted-foreground"
>
  <span className="truncate">
    Privacidade · {fornecedor ? `fornecedor ${fornecedor}` : "fornecedor externo"} · {grantPersistenteActivo && alvoAutorizado === null
      ? "autorizado para futuras explicações"
      : rotuloDeConsentimento(consentimentoProcessoEfectivo, alvoAutorizado, alvoConsentimento)}
    <span data-matrix-consent-indicator className="ml-2 normal-case tracking-normal text-foreground/80">
      {autorizacaoUmaVez
        ? "só esta explicação"
        : consentimentoExterno.grant
          ? "guardado nesta conta e computador"
          : "sem autorização guardada"}
    </span>
  </span>
  <button
    type="button"
    data-matrix-privacy-toggle
    aria-expanded={autorizacaoAberta}
    onClick={() => setAutorizacaoAberta(!autorizacaoAberta)}
    className="shrink-0 rounded border border-border px-2 py-0.5 normal-case tracking-normal hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
  >
    {autorizacaoAberta ? "Fechar autorização" : consentimentoProcessoEfectivo ? "Rever autorização" : "Autorizar"}
  </button>
</div>

            {/* Messages */}
            <div
              ref={scrollRef}
              onScroll={trackScroll}
              data-matrix-messages=""
              className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 space-y-3 [scrollbar-width:thin]"
            >
              {messages.map((msg, i) => (
                <motion.div
                  key={`${msg.role}-${i}`}
                  initial={{ opacity: 0, x: msg.role === "user" ? 10 : -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  className={cn("flex w-full", msg.role === "user" ? "justify-end" : "justify-start")}
                >
                  <div
                    data-matrix-message-role={msg.role}
                    className={cn(
                      "min-w-0 max-w-[85%] break-words [overflow-wrap:anywhere] whitespace-pre-wrap px-3 py-2 rounded-2xl text-xs font-sans leading-relaxed",
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground rounded-tr-none shadow-lg shadow-primary/20"
                        : "bg-secondary/80 border border-border backdrop-blur-md rounded-tl-none text-muted-foreground"
                    )}
                  >
                    {msg.role === "assistant" ? renderRich(msg.content) : msg.content}
                    {(() => {
                      // A origem é por mensagem: o cabeçalho do painel diz o que
                      // está configurado, não o que respondeu àquela pergunta.
                      // Quando existe estado, é ele que se mostra — «IA online» é
                      // igual nos dois eixos, e um «local» sem causa continuaria a
                      // confundir autorização com indisponibilidade.
                      const rotulo = msg.role === "assistant"
                        ? matrixRoutingStateLabel(msg.state) ?? matrixOriginLabel(msg.origin)
                        : null
                      if (!rotulo) return null
                      return (
                        <span
                          data-matrix-request-state={msg.state}
                          className="mt-2 block text-[9px] font-mono uppercase tracking-widest text-muted-foreground/70"
                        >
                          {rotulo}
                        </span>
                      )
                    })()}
                  </div>
                </motion.div>
              ))}

{/*
  Pedido de autorizacao e texto completo: vivem no fluxo das mensagens, por isso
  abre sem comprimir o que ja foi lido e a posi de leitura nao salta. A identidade
  do alvo esta escrita aqui, nao so no PID do cabecalho: autorizar o processo A nao
  pode parecer, a quem olha, autorizacao para o processo B.
*/}
{/*
  OPÇÃO DE IA, DEPOIS do diagnóstico local. Não abre o cartão nem pede nada
  sozinha: quem quiser a segunda opinião carrega aqui, e só então aparece o
  consentimento compacto (âmbito, campos, fornecedor).
*/}
{ofertaIa && !explicacaoPendente && modoConversa === "online" && mesmoAlvo(ofertaIa.alvo, alvoActual) && (
  <div data-matrix-ask-ai className="flex justify-start">
    <button
      type="button"
      onClick={() => {
        setExplicacaoPendente(ofertaIa)
        setOfertaIa(null)
        setAutorizacaoAberta(true)
      }}
      className="rounded-full border border-border bg-secondary/60 px-3 py-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
    >
      Perguntar à MATRIX com IA
    </button>
  </div>
)}
{(explicacaoPendente || autorizacaoAberta) && (
  <div
    ref={consentCardRef}
    data-matrix-consent-card
    role="group"
    aria-label={`Autorização para enviar medições ${explicacaoPendente?.pid != null ? "do PID " + explicacaoPendente.pid : "desta máquina"}`}
    className="flex justify-start"
  >
    {/* Compacto por omissão: a lista completa fica em «Ver detalhes». Um bloco
        enorme dentro do scroll escondia as mensagens que a pessoa estava a ler. */}
    <div className="w-full max-w-[95%] rounded-lg border border-primary/30 bg-primary/5 p-2.5 text-xs space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        <p className="font-mono uppercase tracking-wider text-[10px] text-primary">
          {explicacaoPendente
            ? "Aguarda autorização"
            : consentimentoProcessoEfectivo
              ? "Autorização activa"
              : "Sem autorização"}
        </p>
        <p data-matrix-consent-target className="font-mono text-[10px] text-muted-foreground">
          {rotuloDoProcessoEmCausa({
            pendente: explicacaoPendente,
            pedido: explainRequest,
            alvo: alvoActual,
            nome: processContext?.selectedProcess?.name ?? null,
          })}
          {" · "}
          {fornecedor ? `fornecedor ${fornecedor}` : "fornecedor externo"}
        </p>
      </div>
      <p className="text-[11px] leading-snug">
        Envia só medições desta máquina ou deste processo: CPU %, RAM, nomes de
        processos, Working Set e tendências. Nesta conversa, a autorização deste
        alvo vale {Math.round(AMBITO_CONSENTIMENTO.duracaoMs / 60000)} minutos.
      </p>
      <p data-matrix-consent-grant className="text-[10px] leading-snug text-muted-foreground">
        {autorizacaoUmaVez
          ? "Esta autorização vale só para a próxima explicação; não é guardada nesta conta e computador."
          : consentimentoExterno.grant
            ? `Consentimento guardado nesta conta e computador até ${new Date(consentimentoExterno.grant.expiresAt).toLocaleDateString("pt-PT")} (${consentimentoExterno.descriptor?.validityDays ?? 30} dias), para futuras explicações de processos nesta instalação.`
            : consentimentoExterno.descriptor
              ? `Ao autorizar, podes escolher: só esta explicação, ou guardar nesta conta e computador por ${consentimentoExterno.descriptor.validityDays} dias para futuras explicações de processos nesta instalação.`
              : "O descriptor local ainda não está disponível; sem ele nada é enviado ao fornecedor."}
      </p>
      {consentErro && (
        <p data-matrix-consent-error role="status" className="text-[10px] leading-snug text-cyber-yellow">
          {consentErro}
        </p>
      )}
      <details data-matrix-consent-details className="text-[10px] leading-snug text-muted-foreground">
        <summary className="cursor-pointer select-none">Ver detalhes</summary>
        <div className="mt-1 space-y-1">
          <p>Finalidade: explicação de processos.</p>
          <p>Envia ao fornecedor de IA apenas: {CAMPOS_AUTORIZADOS.join(", ")}.</p>
          <p>Nunca envia: {CAMPOS_NUNCAS_AUTORIZADOS.join(", ")}.</p>
          <p>
            {grantPersistenteActivo && !autorizacaoUmaVez
              ? `Guardada nesta conta e computador para futuras explicações de processos nesta instalação até ${consentimentoExterno.grant ? new Date(consentimentoExterno.grant.expiresAt).toLocaleDateString("pt-PT") : ""}. O histórico privado continua limitado ao alvo de cada pedido.`
              : `Vale por esta conversa, para este processo e esta instância, até ${Math.round(AMBITO_CONSENTIMENTO.duracaoMs / 60000)} minutos.`}
            {" "}A autorização pode ser retirada a qualquer momento, aqui, na barra de privacidade ou em Configurações.
          </p>
        </div>
      </details>
      <label className="flex gap-2 items-start">
        <input
          type="checkbox"
          data-matrix-consent-checkbox
          checked={consentimentoProcessoEfectivo}
          readOnly
          aria-label="Estado da autorização para este alvo"
        />
        <span>{consentimentoProcessoEfectivo
          ? (autorizacaoUmaVez
            ? "Autorização activa só para esta explicação"
            : grantPersistenteActivo && alvoAutorizado === null
              ? "Autorização persistente activa para futuras explicações"
              : "Autorização persistente activa para este alvo")
          : "Sem autorização para este alvo; escolhe uma das opções abaixo."}
        </span>
      </label>
      {!consentimentoProcessoEfectivo && !explicacaoPendente && (
        <p className="text-[10px] leading-snug text-muted-foreground">
          Nenhuma opção está pré-selecionada. A oferta A vale para um único envio; a oferta B guarda o consentimento nesta conta e computador.
        </p>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        {!consentimentoProcessoEfectivo && (
          <>
            <button
              type="button"
              data-matrix-consent-authorize
              disabled={enviando}
              onClick={() => { void autorizarAlvoEmCausa("uma-vez"); }}
              className="rounded border border-primary/40 px-2 py-1 hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
            >
              Só esta explicação
            </button>
            <button
              type="button"
              data-matrix-consent-authorize-persistent
              disabled={enviando}
              onClick={() => { void autorizarAlvoEmCausa("persistente"); }}
              className="rounded border border-primary/40 px-2 py-1 hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
            >
              Guardar para futuras explicações
            </button>
          </>
        )}
        {consentimentoProcessoEfectivo && (
          <button
            type="button"
            data-matrix-consent-revoke
            onClick={revogarAlvoEmCausa}
            className="rounded border border-border px-2 py-1 text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          >
            Revogar autorização
          </button>
        )}
        {explicacaoPendente && (
          <button
            type="button"
            data-matrix-consent-decline
            onClick={() => recusarExplicacaoPendente()}
            className="rounded border border-border px-2 py-1 text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          >
            Continuar localmente, sem partilhar
          </button>
        )}
      </div>
    </div>
  </div>
)}
              {showThinking && (
                <div className="flex items-center gap-2 p-2 bg-secondary/30 border border-border rounded-full w-fit">
                  <motion.span
                    animate={{ rotate: 360 }}
                    transition={{ repeat: Infinity, duration: 1.2, ease: "linear" }}
                    className="inline-block"
                  >
                    <Sparkles className="w-3 h-3 text-primary" />
                  </motion.span>
                  <span className="text-[9px] font-mono uppercase text-muted-foreground tracking-widest">
                    {phase === "streaming" ? "A Matrix está a escrever..." : "A Matrix está a pensar..."}
                  </span>
                </div>
              )}
              {phase === "streaming" && streamed && (
                <div className="flex w-full justify-start">
                  <div
                    data-matrix-message-role="assistant"
                    data-matrix-streaming-block=""
                    className="min-w-0 max-w-[85%] break-words [overflow-wrap:anywhere] whitespace-pre-wrap px-3 py-2 rounded-2xl text-xs font-sans leading-relaxed bg-secondary/80 border border-border backdrop-blur-md rounded-tl-none text-muted-foreground"
                  >
                    {renderRich(streamed)}
                  </div>
                </div>
              )}

              {/* Sugestões iniciais DENTRO da área de mensagens: são o passo
                  seguinte da saudação, não uma faixa à parte. Ao enviar a
                  primeira mensagem desaparecem sem mexer no campo de escrita. */}
              {phase === "idle" && isConversationStart(messages) && (
                <div data-matrix-starters className="flex flex-wrap gap-2 pl-1">
                  {suggestions.map((s) => (
                    <button
                      key={s.label}
                      type="button"
                      onClick={() => handleSuggestion(s.label)}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-secondary/50 border border-border/50 text-[11px] font-mono text-muted-foreground rounded-full hover:bg-primary/10 hover:text-primary hover:border-primary/30 transition-colors"
                    >
                      <MessageSquare className="w-3 h-3" />
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Input Area */}
            <div className="shrink-0 p-4 bg-primary/5 border-t border-primary/20">
              <div className="relative">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSend()}
                  placeholder="Pergunta sobre segurança digital..."
                  className="w-full bg-background/50 border border-primary/30 rounded-xl pl-4 pr-16 py-2.5 text-xs font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 transition-all"
                />
                {canCancel ? (
                  <button
                    onClick={handleStop}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 bg-destructive/20 text-destructive rounded-lg hover:scale-105 transition-transform"
                    aria-label="Cancelar"
                  >
                    <StopCircle className="w-3.5 h-3.5" />
                  </button>
                ) : (
                  <button
                    onClick={handleSend}
                    disabled={!input.trim() || canCancel}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 bg-primary text-primary-foreground rounded-lg hover:scale-105 transition-transform disabled:opacity-50 disabled:scale-100"
                    aria-label="Enviar"
                  >
                    <Send className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              {(phase === "error" || phase === "rate_limited") && (
                <button onClick={handleRetry} className="mt-2 flex items-center gap-1.5 text-[11px] font-mono text-cyber-yellow hover:text-primary">
                  <RefreshCw className="w-3 h-3" /> Tentar novamente
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Launcher: rótulo "Matrix AI" (transiente, ACIMA) + avatar encostado à direita.
          `items-end`, e não `items-center`: com o rótulo visível a coluna alarga-se
          para a largura do rótulo e uma coluna centrada deslocaria o FAB para a
          esquerda, entrando e saindo da pegada de repouso. Alinhado à direita, o FAB
          fica sempre no limite da área útil — com ou sem rótulo, e sempre fora da
          banda dos toasts. */}
      {/* Sem legenda permanente: o único texto fixo era a bolha «Matrix AI /
          Pergunta-me algo», que ficava por cima de gráficos e cartões. O nome
          acessível do botão continua a dizer o mesmo a quem usa leitor de ecrã.
          Na barra recolhida a coluna passa a vertical para o menu caber. */}
      <MatrixConfigModal
        isOpen={configModalAberta}
        onClose={() => setConfigModalAberta(false)}
        currentProvider={credentialStatus.provider}
        hasConfiguredKey={credentialStatus.hasKey}
        providerState={providerState}
        onVerify={async () => {
          const generation = credentialGeneration.current;
          setProviderState("Ligação em verificação");
          const result = await verifyMatrixProvider(API_BASE, authHeaders(), AbortSignal.timeout(6000));
          if (generation !== credentialGeneration.current) return;
          setMode(result.operational ? "online" : "local");
          setProviderState(result.label);
        }}
        onSaveKey={async (key: string, prov: string) => {
          credentialGeneration.current++;
          const api = window.electronAPI;
          if (api?.aiCredentials?.save) {
            const res = await api.aiCredentials.save(key, prov);
            if (res.ok) {
              abortRef.current?.abort();
              setMode("local"); setModoConversa("local");
              setAutorizacoes([]); aplicarConsentimentoExterno({ descriptor: null, grant: null });
              setCredentialStatus({ hasKey: true, provider: res.provider ?? prov, state: res.state ?? "configured" });
              setProviderState(res.applied ? "Provider configurado — ligação não verificada" : "Chave guardada — API ainda não confirmou a configuração");
            }
            return res;
          }
          return { ok: false, error: "Bridge de credenciais seguras não disponível." };
        }}
        onClearKey={async () => {
          credentialGeneration.current++;
          const api = window.electronAPI;
          if (api?.aiCredentials?.clear) {
            const res = await api.aiCredentials.clear();
            if (res.ok) {
              abortRef.current?.abort();
              setMode("local"); setModoConversa("local");
              setAutorizacoes([]); aplicarConsentimentoExterno({ descriptor: null, grant: null });
              setCredentialStatus({ hasKey: false, provider: "groq", state: res.state ?? "configured" });
              setProviderState(res.applied ? "Chave removida — modo local" : "Chave removida — API ainda não confirmou a remoção");
            }
            return res;
          }
          return { ok: false };
        }}
      />
      {launcherMode !== "panel" && (
      <div
        ref={launcherRowRef}
        className={cn(
          "flex gap-1.5",
          launcherMode === "docked"
            ? sidebarWidth > 0 && sidebarWidth < 140
              ? "flex-col items-center"
              : "flex-row items-center"
            : "flex-col items-end",
        )}
      >
        <motion.button
          ref={launcherButtonRef}
          whileHover={isDragging ? undefined : { scale: 1.05 }}
          whileTap={isDragging ? undefined : { scale: 0.95 }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onLauncherKeyDown}
          onClick={() => {
            // Um arrasto não é um clique: não abre nem fecha o chat.
            if (suppressClickRef.current) {
              suppressClickRef.current = false
              return
            }
            setUpOpenState(!isOpen)
          }}
          title="Olá! Sou a Matrix. Posso ajudar-te com segurança digital e com o CyberSafe."
          className={cn(
            "relative w-14 h-14 rounded-full flex items-center justify-center shadow-2xl transition-all duration-500 overflow-hidden group",
            isOpen ? "bg-card cyber-border rotate-90" : "bg-primary shadow-primary/40"
          )}
          aria-label="Abrir assistente Matrix AI"
        >
          {isOpen ? (
            <X className="w-6 h-6 text-primary" />
          ) : (
            <>
              <MatrixAvatar mood="avatar" size="sm" rounded className="w-full h-full" />
              <div className="absolute -bottom-1 -right-1 w-6 h-6 bg-cyber-green rounded-full border-2 border-card flex items-center justify-center shadow-lg cyber-glow">
                <Sparkles className="w-3 h-3 text-white" />
              </div>
              <div className="absolute inset-0 rounded-full border-2 border-primary/50 animate-ping opacity-30 pointer-events-none" />
            </>
          )}
        </motion.button>
        {/* Menu: a alternativa ao arrasto, sempre alcançável por teclado. Os
            itens mudam com o estado — nunca se oferece «Fixar» a quem já está
            fixado, nem «Soltar» a quem já está na página. */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((aberto) => !aberto)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Opções da Matrix"
            className="flex items-center gap-1 rounded-lg border border-border bg-card/90 px-2 py-1 text-[10px] font-mono text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          >
            <MoreHorizontal className="w-3.5 h-3.5" />
            {launcherMode === "docked" ? "Fixada" : "Opções"}
          </button>
          {menuOpen && (
            <div
              role="menu"
              aria-label="Opções da Matrix"
              className="absolute bottom-full left-0 z-[110] mb-2 w-56 overflow-hidden rounded-xl border border-primary/30 bg-card/95 shadow-2xl backdrop-blur-xl"
            >
              {launcherMode === "docked" ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => persistLauncherMode("floating")}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-mono text-foreground transition-colors hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <PinOff className="w-3.5 h-3.5 text-primary" />
                  Soltar na página
                </button>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => persistLauncherMode("docked")}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-mono text-foreground transition-colors hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <PanelLeft className="w-3.5 h-3.5 text-primary" />
                  Fixar na sidebar
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  persistLauncherMode("panel")
                  setUpOpenState(true)
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-mono text-foreground transition-colors hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
              >
                <PanelRight className="w-3.5 h-3.5 text-primary" />
                Abrir painel lateral
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => persistLauncherMode("minimized")}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-mono text-foreground transition-colors hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
              >
                <Minimize2 className="w-3.5 h-3.5 text-primary" />
                Minimizar
              </button>
              {launcherMode === "floating" && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { resetPos(); setMenuOpen(false) }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-mono text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <Move className="w-3.5 h-3.5" />
                  Repor posição
                </button>
              )}
            </div>
          )}
        </div>

      </div>
      )}
    </div>
  )
}
