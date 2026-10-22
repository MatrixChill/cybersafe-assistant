import { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect, type PointerEvent as RPointerEvent, type KeyboardEvent as RKeyboardEvent } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { X, Send, Sparkles, MessageSquare, StopCircle, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  answerLocalSecurityQuestion,
  cancelLocalSecurityRequest,
  shouldDiscardLateAnswer,
  isLocalSecurityQuestion,
} from "@/lib/localSecurityReply"
import { MatrixAvatar } from "./MatrixAvatar"
import { subscribeMatrixEscape } from "@/lib/matrixEscape"
import {
  MATRIX_POS_KEY,
  KEYBOARD_STEP_PX,
  clampPos,
  defaultPos,
  computeChatPanelPlacement,
  movedEnoughToDrag,
  parseStored,
  projectPointerDrag,
  reservedBottomFromFooter,
  serialize,
  type Point,
  type Pos,
  type Size,
} from "@/lib/matrixLauncherPosition"
import type { ProcessIntelligenceContext } from "@cybersafe/shared-types"
import type { ProcessDiagnostic, EstadoIdentidade } from "@/lib/processIntelligence"
import { buildProcessLocalReply, isProcessQuestion, processPayload, processChatHistory, matrixTelemetryContext } from "@/lib/processMatrix"

interface Message {
  role: "user" | "assistant"
  content: string
  privateProcessData?: boolean
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

const TOKEN_KEY = "cybersafe_token"

// S3: as rotas privadas da API exigem o token da sessão. Lido a cada pedido
// (muda no login/logout) e só do armazenamento local — nunca há credenciais
// embutidas no código do cliente.
function authHeaders(): Record<string, string> {
  try {
    const token = globalThis.localStorage?.getItem(TOKEN_KEY)
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

function offlineReply(input: string, page: Page): { content: string; isOffTopic?: boolean; isDanger?: boolean } {
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
    content: `Estou em **modo local** (a ligação ao fornecedor de IA não está disponível), então notei que não tenho uma resposta pronta para isso. Posso tentar de novo, ou foca-te na segurança — ${hint || "por exemplo, o que é phishing ou como criar palavras-passe fortes."}`,
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
    return <div key={bi} className="min-h-2">{renderInline(block)}</div>
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

function fetcher(base: string, path: "/api/ai/status" | "/api/ai/chat") {
  const full = `${base}${path}`
  return {
    status: async (): Promise<{ enabled: boolean; provider?: string; model?: string } | null> => {
      try {
        const r = await fetch(full, { headers: authHeaders(), signal: AbortSignal.timeout(4000) })
        if (!r.ok) return null
        return await r.json()
      } catch {
        return null
      }
    },
  }
}

export default function AIAssistant({ currentPage = "dashboard", context = "", processDiagnostic = null, processContext = null, explainRequest = null, explainIdentity = "semAlvo" }: AIAssistantProps) {
  const isOpenRef = useRef(false)
  const [isOpen, setIsOpenState] = useState(false)
  const [showLabel, setShowLabel] = useState(true)
  const [input, setInput] = useState("")
  const [messages, setMessages] = useState<Message[]>([])
  const [phase, setPhase] = useState<"idle" | "thinking" | "streaming" | "cancelling" | "error" | "rate_limited">("idle")
  const [mode, setMode] = useState<"online" | "local">("local")
  const [processConsent, setProcessConsent] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const questionGenerationRef = useRef(0)
  const localUntilRef = useRef(0)
  const [streamed, setStreamed] = useState("")
  const streamedRef = useRef("")

  const suggestions = useMemo(() => SUGGESTIONS[currentPage] || DEFAULT_SUGGESTIONS, [currentPage])

  const setUpOpenState = useCallback((v: boolean) => {
    if (!v) {
      questionGenerationRef.current += 1
      cancelLocalSecurityRequest(abortRef.current)
      setPhase("idle")
      setProcessConsent(false)
    }
    isOpenRef.current = v
    setIsOpenState(v)
  }, [])

  useEffect(() => {
    if (!isOpen) return
    return subscribeMatrixEscape(document, () => setUpOpenState(false))
  }, [isOpen, setUpOpenState])

  useEffect(() => {
    if (!explainRequest) return
    questionGenerationRef.current += 1
    cancelLocalSecurityRequest(abortRef.current)
    setPhase("idle")
    setUpOpenState(true)
    setInput(explainRequest.pid ? "A memória deste processo está a aumentar? É seguro fechá-lo?" : "Porque está o meu PC a usar tanta RAM ou CPU?")
  }, [explainRequest, setUpOpenState])

  useEffect(() => () => {
    questionGenerationRef.current += 1
    cancelLocalSecurityRequest(abortRef.current)
  }, [])

  // Abertura: primeira mensagem + sonda online/offline.
  useEffect(() => {
    if (isOpen && messages.length === 0) {
      let cancelled = false
      fetcher(API_BASE, "/api/ai/status").status().then((s) => {
        if (cancelled) return
        if (s?.enabled) {
          // Reachable /models is not proof that a completion succeeded.
          localUntilRef.current = 0
        } else {
          setMode("local")
          localUntilRef.current = Date.now() + 30000
        }
        setMessages([
          {
            role: "assistant",
            content:
              "Oi! Tudo bem? Em que posso ajudar?",
          },
        ])
      })
      return () => {
        cancelled = true
      }
    }
  }, [isOpen, messages.length])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, phase, streamed])

  // Auto-recolhe o rótulo do launcher após uns segundos.
  useEffect(() => {
    const t = setTimeout(() => setShowLabel(false), 6000)
    return () => clearTimeout(t)
  }, [isOpen])

  const sendToServer = useCallback(
    async (history: Message[], signal: AbortSignal, stream: boolean, onFirstDelta?: () => void): Promise<{ ok: boolean; content?: string; code?: string; message?: string }> => {
      const payload = {
        messages: processChatHistory(history, processConsent),
        context: matrixTelemetryContext(context, processConsent),
        page: PAGE_LABELS[currentPage],
        stream,
        ...processPayload(processContext, processConsent),
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
              code = j.code
              message = j.message || message
            } catch { /* ignore */ }
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
          if (timedOut.current) return { ok: false, message: "Tempo limite excedido. Tenta de novo." }
          if (!completed || !content.trim()) return {ok: false, message: "A resposta da IA não foi concluída."}
          return { ok: true, content }
        } catch (err) {
          settle()
          if (signal.aborted) throw err
          if (timedOut.current) return { ok: false, message: "Tempo limite excedido. Tenta de novo." }
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
          code = j.code
          message = j.message || message
        } catch { /* ignore */ }
        return { ok: false, code, message }
      }
      const j = await res.json()
      return typeof j.response === "string" && j.response.trim()
        ? { ok: true, content: j.response }
        : {ok: false, message: "A resposta da IA não foi concluída."}
    },
    [context, currentPage, processContext, processConsent],
  )

  const processMessage = useCallback(
    async (text: string, isRetry = false) => {
      const trimmed = text.trim()
      if (!trimmed || phase === "thinking" || phase === "streaming") return

      cancelLocalSecurityRequest(abortRef.current)
      const questionId = ++questionGenerationRef.current
      const processQuestion = isProcessQuestion(trimmed)
      const userMessage: Message = { role: "user", content: trimmed, privateProcessData: processQuestion }
      const nextMessages = [...messages, userMessage]
      setMessages(nextMessages)
      setInput("")
      setStreamed("")
      streamedRef.current = ""

      // Limite de histórico — envia apenas as últimas N mensagens.
      const payloadHistory = nextMessages.slice(-MAX_HISTORY)

      setPhase("thinking")
      const controller = new AbortController()
      abortRef.current = controller
      const identityLost = explainRequest?.pid !== undefined && (explainIdentity === "sumido" || explainIdentity === "reutilizado")
      const localReply = identityLost
        ? {content: explainIdentity === "sumido"
            ? `**INSTÂNCIA FORA DAS MEDIÇÕES**\n\nO processo pedido (PID ${explainRequest?.pid}) já não está nas medições atuais. Não o substituo por outro processo com o mesmo número — um PID reutilizado é outra instância. A IA generativa não foi utilizada.`
            : `**PID REUTILIZADO**\n\nA instância mostrada (PID ${explainRequest?.pid}) já não existe; o Windows reatribuiu o número a outra instância. Sem a identidade original não há diagnóstico desta amostra. A IA generativa não foi utilizada.`, isDanger: false, isOffTopic: false}
        : processQuestion
        ? {content: buildProcessLocalReply(processDiagnostic, processContext?.selectedProcess?.pid ?? explainRequest?.pid, processContext?.selectedProcess), isDanger: false, isOffTopic: false}
        : offlineReply(trimmed, currentPage)

      // Process measurements stay local unless the user explicitly consents.
      if (processQuestion && (!processConsent || !processContext)) {
        setMode("local")
        setPhase("idle")
        setMessages(prev => [...prev, {role: "assistant", content: localReply.content, privateProcessData: true}])
        return
      }

      // Se foi um pedido perigoso ou fora do tema, responde localmente (nunca ao provider).
      if (localReply.isDanger) {
        setPhase("idle")
        setMessages((prev) => [...prev, { role: "assistant", content: localReply.content, privateProcessData: processQuestion }])
        return
      }
      if (localReply.isOffTopic) {
        setPhase("idle")
        setMessages((prev) => [...prev, { role: "assistant", content: localReply.content }])
        return
      }

      // POSTHUMAN13: perguntas de estado do PC ("Meu PC está
      // seguro?") respondem-se LOCALMENTE, ANTES do fornecedor,
      // a partir do snapshot real recente do serviço lido pela
      // bridge existente. Estas perguntas nunca tocam o provider
      // (zero externo, inclusive em erro/staleness). Um snapshot
      // que chega tarde (cancelar/janela fechada) é descartado:
      // sem late append.
      if (isLocalSecurityQuestion(trimmed)) {
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
        if (answer) {
          setMode("local")
          setPhase("idle")
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: answer.reply, privateProcessData: true },
          ])
          return
        }
      }

      // Em modo local (cooldown), não martelar o provider — responde da base local.
      if (mode === "local" && Date.now() < localUntilRef.current) {
        setPhase("idle")
        setMessages((prev) => [...prev, { role: "assistant", content: localReply.content, privateProcessData: processQuestion }])
        return
      }

      let attempts = 0
      const maxAttempts = isRetry ? Math.min(2, MAX_RETRIES) : MAX_RETRIES

      while (attempts <= maxAttempts) {
        if (controller.signal.aborted) break
        try {
          const result = await sendToServer(payloadHistory, controller.signal, true, () => {
            if (questionId === questionGenerationRef.current && !controller.signal.aborted) setPhase("streaming")
          })
          if (questionId !== questionGenerationRef.current) return
          if (controller.signal.aborted) {
            setPhase("idle")
            return
          }
          if (result.ok && typeof result.content !== "undefined") {
            const content = result.content
            setMode("online")
            setPhase("idle")
            setMessages((prev) => [...prev, { role: "assistant", content, privateProcessData: processQuestion || processConsent }])
            return
          }
          if (result.code === "rate_limited") {
            setPhase("rate_limited")
            setMessages((prev) => [...prev, { role: "assistant", content: "Cheguei ao limite de pedidos por enquanto. Aguarda uns segundos e tenta de novo — estou aqui." }])
            return
          }
          if (result.code === "no_provider" || result.code === "auth" || result.code === "model_unavailable") {
            // Provider indisponível → fallback local (com cooldown).
            setMode("local")
            localUntilRef.current = Date.now() + 30000
            setPhase("idle")
            setMessages((prev) => [...prev, { role: "assistant", content: localReply.content, privateProcessData: processQuestion }])
            return
          }
          // Erro transitório → retry limitado.
          setPhase("thinking")
        } catch (err) {
          if (questionId !== questionGenerationRef.current) return
          if (err instanceof Error && err.name === "AbortError") {
            setPhase("idle")
            return
          }
          // network error → retry
          setPhase("thinking")
        }
        attempts++
      }

      // Esgotou retries → fallback local.
      if (questionId !== questionGenerationRef.current || controller.signal.aborted) return
      setMode("local")
      localUntilRef.current = Date.now() + 30000
      setPhase("idle")
      setMessages((prev) => [...prev, { role: "assistant", content: localReply.content, privateProcessData: processQuestion }])
    },
    [messages, phase, currentPage, sendToServer, mode, processConsent, processContext, processDiagnostic, explainRequest, explainIdentity],
  )

  const handleSend = () => {
    processMessage(input)
  }

  const handleSuggestion = (label: string) => {
    processMessage(label)
  }

  const handleStop = () => {
    questionGenerationRef.current += 1
    cancelLocalSecurityRequest(abortRef.current)
    setPhase("idle")
  }

  const handleRetry = () => {
    const last = messages[messages.length - 1]
    if (last?.role === "user") {
      processMessage(last.content, true)
    }
  }

  const canCancel = phase === "thinking" || phase === "streaming"
  const showThinking = phase === "thinking" || phase === "streaming"

  // ── Geometria do launcher (TP-MATRIX-DRAG, port por seleção do 0de640b) ────────────────────────────────────────
  // Toda a aritmética vive em `lib/matrixLauncherPosition.ts` (pura e testada);
  // aqui só se mede, se aplica e se persiste. `{x, bottom}` são distâncias ao
  // viewport. Default: canto inferior ESQUERDO, fora da Sidebar (sidebarWidth).
  const launcherButtonRef = useRef<HTMLButtonElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [launcherSize, setLauncherSize] = useState<Size>({ w: 56, h: 56 })
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
    const sidebarW = sidebarRect && sidebarRect.width > 0 && sidebarRect.left <= 8 ? Math.round(sidebarRect.right) : 0
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
      const sidebarNode = document.querySelector('[data-cs-sidebar="main"]')
      if (sidebarNode) observer.observe(sidebarNode) // colapso/expansão da Sidebar sem resize da janela
    }
    return () => {
      window.removeEventListener("resize", applyMeasurements)
      observer?.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measureLayoutMetrics, viewport])

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

  const onPointerDown = useCallback((event: RPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 && event.pointerType === "mouse") return
    const start = effectivePos()
    dragRef.current = {
      id: event.pointerId,
      from: start,
      to: start,
      startClient: { x: event.clientX, y: event.clientY },
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }, [effectivePos])

  const onPointerMove = useCallback((event: RPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (!drag || drag.id !== event.pointerId) return
    const next = projectPointerDrag(
      drag.from,
      drag.startClient,
      { x: event.clientX, y: event.clientY },
      viewport(),
      launcherSize,
      reservedBottom,
      sidebarWidth,
    )
    drag.to = next
    if (movedEnoughToDrag(drag.from, next)) {
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
    if (movedEnoughToDrag(drag.from, drag.to)) {
      suppressClickRef.current = true
      setPos(drag.to)
      persistPos(drag.to)
    }
  }, [persistPos])

  const onLauncherKeyDown = useCallback((event: RKeyboardEvent<HTMLButtonElement>) => {
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
  }, [effectivePos, launcherSize, persistPos, reservedBottom, sidebarWidth, viewport])

  const resetPos = useCallback(() => {
    setPos(defaultPos(viewport(), launcherSize, reservedBottom, sidebarWidth))
    try {
      localStorage.removeItem(MATRIX_POS_KEY)
    } catch {
      /* sem armazenamento: o reset vale para esta sessão */
    }
  }, [launcherSize, reservedBottom, viewport, sidebarWidth])

  const appliedPos = effectivePos()
  const chatPlacement = computeChatPanelPlacement(appliedPos, viewport(), launcherSize, sidebarWidth, reservedBottom)
  const defPos = defaultPos(viewport(), launcherSize, reservedBottom, sidebarWidth)
  const isDefaultPos = pos === null || (Math.abs(appliedPos.x - defPos.x) <= 2 && Math.abs(appliedPos.bottom - defPos.bottom) <= 2)

  // Launcher: avatar + rótulo "Matrix AI", recolhe depois.
  // Posição: `appliedPos` (default inferior esquerdo, fora da Sidebar, XY persistido).
  return (
    <div
      ref={rootRef}
      className="fixed z-[100] flex flex-col items-start gap-3"
      style={{ left: appliedPos.x, bottom: appliedPos.bottom }}
      data-matrix-pos-x={appliedPos.x}
      data-matrix-pos-bottom={appliedPos.bottom}
      data-matrix-reserved-bottom={reservedBottom}
      data-matrix-sidebar-w={sidebarWidth}
    >
      {/* Chat Window */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.9 }}
            className="absolute border border-primary/30 rounded-2xl bg-card/80 backdrop-blur-xl shadow-2xl flex flex-col overflow-hidden cyber-border"
            style={{
              left: chatPlacement.left - appliedPos.x,
              bottom: chatPlacement.bottom - appliedPos.bottom,
              width: chatPlacement.width,
              height: chatPlacement.height,
            }}
            data-matrix-chat-open={chatPlacement.openDirection}
          >
            {/* Header */}
            <div className="p-4 border-b border-primary/20 bg-primary/5 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <MatrixAvatar mood="avatar" size="sm" rounded />
                <div>
                  <h3 className="text-xs font-bold font-mono text-primary uppercase tracking-widest">Matrix</h3>
                  <p className="text-[9px] text-muted-foreground font-mono uppercase tracking-tighter">
                    Assistente de IA do CyberSafe ·{" "}
                    <span className={mode === "online" ? "text-cyber-green" : "text-cyber-yellow"}>
                      {mode === "online" ? "IA ONLINE" : "DIAGNÓSTICO BÁSICO OFFLINE"}
                    </span>
                  </p>
                </div>
              </div>
              <button
                onClick={() => setUpOpenState(false)}
                className="p-1 hover:bg-secondary rounded transition-colors"
                aria-label="Fechar assistente"
              >
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>

            {mode !== "online" && (
              <p role="status" className="px-4 py-2 text-xs text-muted-foreground border-b border-border">
                Respostas locais determinísticas, com regras e métricas disponíveis. A IA online depende da configuração segura do serviço.
              </p>
            )}

            {explainRequest?.pid !== undefined && (
              <p data-matrix-process role="status" className="px-4 py-2 border-b border-border text-xs text-muted-foreground">
                {processContext?.selectedProcess?.name ?? "Instância fora das medições"} · PID {explainRequest.pid}
                {explainRequest.startedAt ? ` · início ${explainRequest.startedAt}` : " · início não confirmado"}
              </p>
            )}

              <details data-matrix-privacy className="px-4 py-2 border-b border-border text-xs text-muted-foreground">
                <summary className="cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">Privacidade · fornecedor externo · contexto {processConsent ? "autorizado" : "não autorizado"}</summary>
                <p className="mt-2 mb-2">As mensagens enviadas à IA generativa são processadas pelo fornecedor externo configurado (por exemplo, Groq). Não inclua palavras-passe, chaves ou ficheiros pessoais.</p>
                <label className="flex gap-2 items-start">
                  <input type="checkbox" checked={processConsent} onChange={event => {
                    questionGenerationRef.current += 1
                    cancelLocalSecurityRequest(abortRef.current)
                    setPhase("idle")
                    setProcessConsent(event.target.checked)
                    if (!event.target.checked) setMode("local")
                  }} />
                  <span>Autorizar nesta conversa o envio do estado de proteção, CPU/RAM, nomes de processos, Working Set e tendências ao fornecedor de IA. Sem caminhos, comandos ou ficheiros. Sem autorização, a telemetria e o diagnóstico ficam neste computador.</span>
                </label>
              </details>

            {/* Messages */}
            <div
              ref={scrollRef}
              className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4 scrollbar-hide bg-dot-pattern"
            >
              {messages.map((msg, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, x: msg.role === "user" ? 10 : -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  className={cn("flex max-w-[92%]", msg.role === "user" ? "ml-auto" : "mr-auto")}
                >
                  <div
                    className={cn(
                      "p-3 rounded-2xl text-xs font-sans leading-relaxed",
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground rounded-tr-none shadow-lg shadow-primary/20"
                        : "bg-secondary/80 border border-border backdrop-blur-md rounded-tl-none text-muted-foreground"
                    )}
                  >
                    {msg.role === "assistant" ? renderRich(msg.content) : msg.content}
                  </div>
                </motion.div>
              ))}

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
                <div className="flex max-w-[92%] mr-auto">
                  <div className="p-3 rounded-2xl text-xs font-sans leading-relaxed bg-secondary/80 border border-border backdrop-blur-md rounded-tl-none text-muted-foreground">
                    {renderRich(streamed)}
                  </div>
                </div>
              )}
            </div>

            {/* Quick Suggestions (por página) */}
            {messages.length <= 2 && phase === "idle" && (
              <div className="px-4 pb-2 flex gap-2 flex-wrap">
                {suggestions.map((s) => (
                  <button
                    key={s.label}
                    onClick={() => handleSuggestion(s.label)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-secondary/50 border border-border/50 text-[11px] font-mono text-muted-foreground rounded-full hover:bg-primary/10 hover:text-primary hover:border-primary/30 transition-all"
                  >
                    <MessageSquare className="w-3 h-3" />
                    {s.label}
                  </button>
                ))}
              </div>
            )}

            {/* Input Area */}
            <div className="p-4 bg-primary/5 border-t border-primary/20">
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
                    disabled={!input.trim() || phase !== "idle"}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 bg-primary text-primary-foreground rounded-lg hover:scale-105 transition-transform disabled:opacity-50 disabled:scale-100"
                    aria-label="Enviar"
                  >
                    <Send className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              {phase === "error" && (
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
      <div className="flex flex-col items-end gap-1.5">
        {showLabel && !isOpen && (
          <motion.div
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8 }}
            className="px-3 py-2 rounded-xl bg-card/90 cyber-border border-primary/30 shadow-lg flex flex-col"
          >
            <span className="text-[10px] font-mono font-bold text-primary uppercase tracking-wider">Matrix AI</span>
            <span className="text-[9px] text-muted-foreground font-mono">Pergunta-me algo</span>
          </motion.div>
        )}
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
        {!isDefaultPos && (
          <button
            type="button"
            onClick={resetPos}
            aria-label="Repor posição da Matrix"
            className="text-[10px] font-mono text-muted-foreground hover:text-primary underline-offset-2 hover:underline"
          >
            Repor posição
          </button>
        )}
      </div>
    </div>
  )
}
