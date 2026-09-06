import { useState, useEffect, useRef } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { Bot, X, Send, Wand2, Sparkles, Shield, Lock, Bug, Mail } from "lucide-react"
import { cn } from "@/lib/utils"

interface Message {
  role: "user" | "assistant"
  content: string
}

// Knowledge base removed

// Knowledge base hardcoded was removed. Now using real AI endpoints.

const QUICK_SUGGESTIONS = [
  { label: "Estado", icon: Shield },
  { label: "Phishing", icon: Mail },
  { label: "Senhas", icon: Lock },
  { label: "Malware", icon: Bug },
]

// Offline fallback knowledge base for when the AI API is unavailable
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
    answer: "**Malware** é software malicioso. Tipos comuns:\n\n- **Trojan**: finge ser legítimo para enganar\n- **Ransomware**: criptografa seus arquivos e exige resgate\n- **Spyware**: espi suas atividades\n- **Worm**: propaga-se sozinho pela rede\n\n**Proteção:** Mantenha antivirus atualizado, não baixe software de fontes desconhecidas, e use o **File Scanner** do CyberSafe para analisar arquivos suspeitos."
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
    answer: "**Segurança em redes WiFi:**\n\n- Use **WPA3** ou no mínimo WPA2 (nunca WEP)\n- Evite redes públicas sem VPN\n- Desconheça **sharing** de arquivos e impressoras\n- Mantenha o **firewall** ativo (verifique no PC Center)\n- Monitore dispositivos conectados pelo **Monitor** do CyberSafe"
  },
  {
    keywords: ["atualização", "update", "patch", "sistema operativo"],
    answer: "**Manter o sistema atualizado** é crucial para segurança:\n\n- Ative **atualizações automáticas** do Windows\n- Atualize navegadores e plugins regularmente\n- Atualize também apps como Java, Adobe, etc.\n- Atualizações corrigem falhas que malwares exploram\n\nVerifique o status do seu sistema no **PC Center** → Windows Health!"
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
      content: "Olá! Sou o **CyberSafe AI Assistant**. Pergunte-me sobre segurança digital — phishing, malware, senhas, VPN, ou como usar qualquer funcionalidade do CyberSafe!",
    },
  ])
  const [isTyping, setIsTyping] = useState(false)
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
      
      setMessages((prev) => [...prev, { role: "assistant", content: data.response }])
    } catch (error) {
      console.error(error)
      // Offline fallback: try to answer from the local knowledge base
      const offlineAnswer = offlineReply(userMsg)
      if (offlineAnswer) {
        setMessages((prev) => [...prev, { role: "assistant", content: offlineAnswer }])
      } else {
        setMessages((prev) => [...prev, { role: "assistant", content: "⚠️ Estou temporariamente indisponível. Tenta novamente mais tarde ou consulta as dicas na aba **Dashboard**." }])
      }
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
                <div className="w-8 h-8 rounded-full bg-primary/20 border border-primary/40 flex items-center justify-center relative">
                  <Bot className="w-5 h-5 text-primary" />
                  <div className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-cyber-green rounded-full border-2 border-card cyber-pulse" />
                </div>
                <div>
                  <h3 className="text-xs font-bold font-mono text-primary uppercase tracking-widest">CyberSafe AI</h3>
                  <p className="text-[9px] text-muted-foreground font-mono uppercase tracking-tighter">18 tópicos • Online / Offline</p>
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
                  placeholder="Pergunte sobre segurança..."
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
          "w-14 h-14 rounded-full flex items-center justify-center shadow-2xl relative transition-all duration-500",
          isOpen ? "bg-card cyber-border rotate-90" : "bg-primary shadow-primary/30"
        )}
      >
        {isOpen ? (
          <X className="w-6 h-6 text-primary" />
        ) : (
          <>
            <Bot className="w-8 h-8 text-primary-foreground" />
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
