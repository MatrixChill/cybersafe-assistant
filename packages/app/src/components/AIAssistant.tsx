import { useState, useEffect, useRef } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { X, Send, Wand2, Sparkles, Shield, Lock, Bug, Mail } from "lucide-react"
import { cn } from "@/lib/utils"
import { MatrixAvatar } from "./MatrixAvatar"

interface Message {
  role: "user" | "assistant"
  content: string
}

const QUICK_SUGGESTIONS = [
  { label: "Estado", icon: Shield },
  { label: "Phishing", icon: Mail },
  { label: "Senhas", icon: Lock },
  { label: "Malware", icon: Bug },
]

// Knowledge base offline (fallback quando a API de IA está indisponível).
const OFFLINE_KB: { keywords: string[]; answer: string }[] = [
  {
    keywords: ["phishing", "email falso", "email suspeito", "link falso"],
    answer: "**Phishing** é uma técnica onde atacantes enviam emails ou mensagens falsas para roubar dados pessoais. Para se proteger:\n\n- **Nunca clique** em links de emails pedindo dados sensíveis\n- Verifique sempre o remetente real (não apenas o nome exibido)\n- Acesse sites diretamente pelo navegador, não por links de emails\n- Desconfie de urgência excessiva ou ameaças no email\n\nSe suspeitas de phishing, use o **Simulador** do CyberSafe para praticar a identificação!"
  },
  {
    keywords: ["senha", "password", "forte", "fraca", "segura"],
    answer: "**Senhas fortes** são a primeira linha de defesa. Recomendações:\n\n- **12+ caracteres** com letras, números e símbolos\n- Evite palavras do dicionário, datas ou nomes conhecidos\n- Use uma **frase-passe** (ex: `Cafe#Frio2024!`)\n- Ative **2FA (autenticação em 2 passos)** sempre que possível\n- Use um **gestor de senhas** (Bitwarden, 1Password)\n\nTeste suas senhas no jogo **Fortaleza de Senhas** do CyberSafe!"
  },
  {
    keywords: ["malware", "virus", "trojan", "ransomware", "worm"],
    answer: "**Malware** é software malicioso. Tipos comuns:\n\n- **Trojan**: finge ser legítimo para enganar\n- **Ransomware**: criptografa seus arquivos e exige resgate\n- **Spyware**: espi suas atividades\n- **Worm**: propaga-se sozinho pela rede\n\n**Proteção:** Mantenha antivírus atualizado, não baixe software de fontes desconhecidas, e use o **File Scanner** do CyberSafe para analisar arquivos suspeitos."
  },
  {
    keywords: ["vpn", "privacidade", "rede privada"],
    answer: "**VPN (Virtual Private Network)** criptografa sua conexão e oculta seu IP. Benefícios:\n\n- Protege em **redes públicas** (WiFi de cafés, aeroportos)\n- Impede que seu provedor de internet monitore seu tráfego\n- Permite acesso a conteúdo restrito por região\n\n**Limitações:** VPN não protege contra phishing, malware ou más práticas online. É apenas uma camada extra de segurança."
  },
  {
    keywords: ["2fa", "autenticação", "dois fatores", "mfa"],
    answer: "**2FA (Autenticação em 2 Passos)** adiciona uma segunda camada além da senha:\n\n- **App authenticator** (Google Authenticator, Authy) — mais seguro\n- **SMS** — melhor que nada, mas suscetível a SIM swap\n- **Hardware key** (YubiKey) — máxima segurança\n\n**Ative 2FA em:** email, redes sociais, banco, e qualquer conta importante!"
  },
  {
    keywords: ["cybersafe", "como usar", "funcionalidade", "ajuda"],
    answer: "**CyberSafe Assistant** é um sistema completo de cibersegurança. Funcionalidades:\n\n- **Dashboard**: visão geral do sistema e alertas\n- **PC Center**: análise detalhada de hardware\n- **Ameaças**: histórico de eventos detectados\n- **File Scanner**: análise de arquivos com heurísticas\n- **Task Manager**: monitorar processos\n- **Monitor**: conexões de rede e proteção\n- **Simulador**: exercícios práticos de phishing\n- **Relatórios**: resumo consolidado de segurança\n\nExplore todas as páginas pelo menu lateral!"
  },
  {
    keywords: ["wifi", "rede", "segurança", "conexão"],
    answer: "**Segurança em redes WiFi:**\n\n- Use **WPA3** ou no mínimo WPA2 (nunca WEP)\n- Evite redes públicas sem VPN\n- Desative **sharing** de arquivos e impressoras\n- Mantenha o **firewall** ativo (verifique no PC Center)\n- Monitore dispositivos conectados pelo **Monitor** do CyberSafe"
  },
  {
    keywords: ["atualização", "update", "patch", "sistema operativo"],
    answer: "**Manter o sistema atualizado** é crucial para segurança:\n\n- Ative **atualizações automáticas** do Windows\n- Atualize navegadores e plugins regularmente\n- Atualize também apps como Java, Adobe, etc.\n- Atualizações corrigem falhas que malwares exploram\n\nVerifique o status do seu sistema no **PC Center** → Windows Health!"
  },
  {
    keywords: ["firewall", "cortafuegos"],
    answer: "O **Firewall** controla o tráfego que entra e sai do seu PC:\n\n- Bloqueia conexões não autorizadas vindas da internet\n- Permite definir regras por aplicação\n- No Windows, active o **Firewall do Windows Defender**\n\nNo CyberSafe, o **Monitor** mostra as conexões ativas em tempo real. Se vir uma conexão suspeita, pode bloquear o processo associado."
  },
  {
    keywords: ["ransomware", "resgate", "criptografar"],
    answer: "**Ransomware** é um malware que **criptografa seus ficheiros** e exige resgate para os libertar.\n\n**Como se proteger:**\n\n- **Backups regulares** (regra 3-2-1: 3 cópias, 2 mídias, 1 offsite)\n- Não abra anexos suspeitos\n- Mantenha o sistema e apps atualizados\n- Active a **Proteção de Pasta** do Windows contra acessos não autorizados\n\nSe for vítima: **não pague o resgate** — não há garantia de recuperação e financia o crime."
  },
  {
    keywords: ["backup", "cópia", "copia", "cópia de segurança", "restaurar"],
    answer: "**Backup** é a sua rede de segurança digital:\n\n- Faça **backups automáticos** em disco externo ou cloud\n- Prefira os **3-2-1**: 3 cópias, 2 tipos de mídia, 1 fora de casa\n- Teste a **restauração** periodicamente (um backup que não restaura não serve)\n- Keep backups **desligados** após o processo para proteger contra ransomware\n\nUm bom backup protege contra malware, falhas de disco e erros humanos."
  },
  {
    keywords: ["adware", "popup", "pop-ups", "publicidade", "spyware"],
    answer: "**Adware/Spyware** é software que exibe publicidade intrusiva e pode rastrear a sua atividade:\n\n- Instale apenas software dos **sites oficiais**\n- Evite instalar \"acompanhantes\" durante instalações (burlançois)\n- Use um **bloqueador de anúncios** em navegadores\n- Limpe extensões desconhecidas do navegador\n\nO **File Scanner** do CyberSafe pode analisar ficheiros suspeitos antes de os abrir."
  },
  {
    keywords: ["engenharia social", "social engineering", "manipulação", "golpe"],
    answer: "**Engenharia social** é a arte de manipular pessoas para obter acesso ou informação:\n\n- **Pretexto**: criam uma história falsa para convencer\n- **Baiting**: prometem algo em troca de dados\n- **Tailgating**: seguem alguém para áreas restritas\n- **Oferta irresistível**: prémios, urgência, medo\n\n**Defesa:** desconfie de contacto não solicitado, verifique por outros canais, e nunca forneça senhas ou códigos por telefone/email."
  },
  {
    keywords: ["cookies", "rastreadores", "tracking", "privacidade navegador"],
    answer: "**Cookies e rastreamento:**\n\n- **Cookies funcionais** são necessários (login, carrinho)\n- **Cookies de rastreio** seguem o seu comportamento entre sites\n- Use modo **privado/incógnito** quando não quiser histórico\n- Instale extensões como **Privacy Badger** ou **uBlock Origin**\n- No navegador, bloqueie cookies de **terceiros**\n\nA privacidade também passa pelo **Monitor** do CyberSafe, que lhe mostra as conexões que o seu PC faz."
  },
  {
    keywords: ["keylogger", "registrador de teclas", "teclas"],
    answer: "**Keylogger** grava tudo o que digita — senhas, cartões, mensagens:\n\n- Instala-se via malware, email phishing ou software pirata\n- **Sinais:** comportamento lento, entradas de teclado estranhas\n\n**Proteção:**\n\n- Use **gestor de senhas** e autopreenchimento (evita digitar em sites falsos)\n- Ative **2FA** — mesmo com senha roubada, a conta fica protegida\n- Faça análises regulares com o **File Scanner** do CyberSafe\n- Mantenha o sistema atualizado"
  },
  {
    keywords: ["ota", "atualização over the air", "atualização de firmware"],
    answer: "**Atualizações (OTA/Over-the-Air)** são essenciais:\n\n- Corrigem **vulnerabilidades conhecidas** exploradas por atacantes\n- Sem atualizações, o PC fica exposto mesmo com antivírus\n\n**Boas práticas:**\n\n- Active **atualizações automáticas** do Windows\n- Reinicie o PC após instalar updates\n- Verifique o **histórico de atualizações** no **PC Center** → Windows Health\n\nUm sistema desatualizado é o principal vetor de infeção em 2025+."
  },
  {
    keywords: ["oi", "olá", "ola", "hello", "bom dia", "boa tarde", "boa noite", "tudo bem", "quem és", "quem e", "quem es"],
    answer: "Olá! Sou o **Matrix**, o assistente virtual do **CyberSafe**.\n\nPosso ajudar-te com **phishing, malware, senhas, privacidade, backups, ransomware** e muito mais sobre segurança digital. Pergunta o que quiseres!"
  },
]

function offlineReply(input: string): string | null {
  const lower = input.toLowerCase()
  for (const entry of OFFLINE_KB) {
    if (entry.keywords.some(kw => lower.includes(kw))) {
      return entry.answer
    }
  }
  return null
}

export default function AIAssistant() {
  const [isOpen, setIsOpen] = useState(false)
  const [input, setInput] = useState("")
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content: "Olá! Sou o **Matrix**, o teu assistente de segurança do CyberSafe. Pergunta-me sobre phishing, malware, senhas, privacidade ou como usar qualquer funcionalidade!",
    },
  ])
  const [isTyping, setIsTyping] = useState(false)
  const [mode, setMode] = useState<"online" | "local">("local")
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, isTyping])

  const processMessage = async (text: string) => {
    if (!text.trim()) return

    const userMsg = text.trim()
    setInput("")

    const userMessage: Message = { role: "user", content: userMsg }
    const newMessages = [...messages, userMessage]
    setMessages(newMessages)
    setIsTyping(true)

    try {
      const response = await fetch("http://localhost:4000/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMessages.map(m => ({ role: m.role, content: m.content })) })
      })
      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.message || "Erro na API de IA")
      }

      setMode("online")
      setMessages((prev) => [...prev, { role: "assistant", content: data.response }])
    } catch (error) {
      console.error(error)
      // Offline fallback: tenta responder pela base de conhecimento local.
      const offlineAnswer = offlineReply(userMsg)
      if (offlineAnswer) {
        setMessages((prev) => [...prev, { role: "assistant", content: offlineAnswer }])
      } else {
        setMessages((prev) => [...prev, { role: "assistant", content: "⚠️ Estou temporariamente **offline**. Não encontrei uma resposta local para essa pergunta. Tenta novamente mais tarde, ou consulta as dicas na aba **Dashboard**." }])
      }
      setMode("local")
    } finally {
      setIsTyping(false)
    }
  }

  const handleSend = () => {
    processMessage(input)
  }

  // Simple markdown → JSX: makes **bold** and line breaks work
  const renderMarkdown = (text: string) => {
    return text.split("\n").map((line, i) => {
      const parts = line.split(/(\*\*.*?\*\*)/g).map((part, j) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={j} className="text-foreground">{part.slice(2, -2)}</strong>
        }
        return <span key={j}>{part}</span>
      })
      return <div key={i} className={line === "" ? "h-2" : ""}>{parts}</div>
    })
  }

  return (
    <div className="fixed bottom-6 left-6 z-[100]">
      {/* Chat Window */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.9, x: -20 }}
            animate={{ opacity: 1, y: 0, scale: 1, x: 0 }}
            exit={{ opacity: 0, y: 20, scale: 0.9, x: -20 }}
            className="mb-4 w-[380px] h-[540px] border border-primary/30 rounded-2xl bg-card/80 backdrop-blur-xl shadow-2xl flex flex-col overflow-hidden cyber-border"
          >
            {/* Header */}
            <div className="p-4 border-b border-primary/20 bg-primary/5 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <MatrixAvatar mood="avatar" size="sm" rounded />
                <div>
                  <h3 className="text-xs font-bold font-mono text-primary uppercase tracking-widest">Matrix</h3>
                  <p className="text-[9px] text-muted-foreground font-mono uppercase tracking-tighter">
                    {mode === "online"
                      ? "MODO ONLINE"
                      : "MODO LOCAL"}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1 hover:bg-white/10 rounded transition-colors"
                aria-label="Close Assistant"
              >
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>

            {/* Messages */}
            <div
              ref={scrollRef}
              className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-hide bg-dot-pattern"
            >
              {messages.map((msg, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, x: msg.role === "user" ? 10 : -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  className={cn(
                    "flex max-w-[88%]",
                    msg.role === "user" ? "ml-auto" : "mr-auto"
                  )}
                >
                  <div
                    className={cn(
                      "p-3 rounded-2xl text-xs font-sans leading-relaxed",
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground rounded-tr-none shadow-lg shadow-primary/20"
                        : "bg-secondary/80 border border-white/5 backdrop-blur-md rounded-tl-none text-muted-foreground"
                    )}
                  >
                    {msg.role === "assistant" ? renderMarkdown(msg.content) : msg.content}
                  </div>
                </motion.div>
              ))}
              {isTyping && (
                <div className="flex items-center gap-2 p-2 bg-secondary/30 border border-white/5 rounded-full w-fit animate-pulse">
                  <Wand2 className="w-3 h-3 text-primary animate-spin" />
                  <span className="text-[9px] font-mono uppercase text-muted-foreground tracking-widest">Analisando...</span>
                </div>
              )}
            </div>

            {/* Quick Suggestions */}
            {messages.length <= 2 && (
              <div className="px-4 pb-2 flex gap-2 flex-wrap">
                {QUICK_SUGGESTIONS.map((s) => {
                  const Icon = s.icon
                  return (
                    <button
                      key={s.label}
                      onClick={() => processMessage(s.label)}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-secondary/50 border border-border/50 text-xs font-mono text-muted-foreground rounded-full hover:bg-primary/10 hover:text-primary hover:border-primary/30 transition-all"
                    >
                      <Icon className="w-3 h-3" />
                      {s.label}
                    </button>
                  )
                })}
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
                  placeholder="Pergunta sobre segurança..."
                  className="w-full bg-background/50 border border-primary/30 rounded-xl pl-4 pr-10 py-2.5 text-xs font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 transition-all"
                />
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || isTyping}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 bg-primary text-primary-foreground rounded-lg hover:scale-105 transition-transform disabled:opacity-50 disabled:scale-100"
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Trigger Button */}
      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "w-14 h-14 rounded-full flex items-center justify-center shadow-2xl relative transition-all duration-500 overflow-hidden",
          isOpen ? "bg-card cyber-border rotate-90" : "bg-primary shadow-primary/30"
        )}
        aria-label="Abrir assistente Matrix"
      >
        {isOpen ? (
          <X className="w-6 h-6 text-primary" />
        ) : (
          <>
            <MatrixAvatar mood="avatar" size="sm" rounded className="w-full h-full" />
            <div className="absolute -top-1 -right-1 w-5 h-5 bg-cyber-green rounded-full border-2 border-white flex items-center justify-center text-[10px] font-bold text-white shadow-lg">
              <Sparkles className="w-3 h-3" />
            </div>
            <div className="absolute inset-0 rounded-full border-2 border-primary/50 animate-ping opacity-30" />
          </>
        )}
      </motion.button>
    </div>
  )
}