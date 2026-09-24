import { useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import type { AccountType, PlanType } from "../lib/featureControl";
import {
  Shield, Mail, Lock, Eye, EyeOff, Loader2, ArrowRight,
  User, Building2, Users, Check, Zap, Crown
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

interface RegisterPageProps {
  onSwitchToLogin: () => void;
}

export default function RegisterPage({ onSwitchToLogin }: RegisterPageProps) {
  const { register } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [accountType, setAccountType] = useState<AccountType | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<PlanType>("free");
  const [companyName, setCompanyName] = useState("");
  const [companySize, setCompanySize] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const passwordStrength = (() => {
    if (!password) return { level: 0, label: "", color: "" };
    let score = 0;
    if (password.length >= 6) score++;
    if (password.length >= 10) score++;
    if (/[A-Z]/.test(password)) score++;
    if (/[0-9]/.test(password)) score++;
    if (/[^A-Za-z0-9]/.test(password)) score++;

    if (score <= 1) return { level: 1, label: "Fraca", color: "bg-red-500" };
    if (score <= 2) return { level: 2, label: "Razoável", color: "bg-yellow-500" };
    if (score <= 3) return { level: 3, label: "Boa", color: "bg-blue-500" };
    return { level: 4, label: "Forte", color: "bg-emerald-500" };
  })();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!accountType) {
      setError("Selecione o tipo de conta.");
      return;
    }

    if (password !== confirmPassword) {
      setError("As senhas não coincidem.");
      return;
    }

    if (password.length < 6) {
      setError("A senha deve ter pelo menos 6 caracteres.");
      return;
    }

    if (accountType === "business" && !companyName.trim()) {
      setError("Nome da empresa é obrigatório para contas empresariais.");
      return;
    }

    setIsLoading(true);
    const result = await register({
      name,
      email,
      password,
      type: accountType,
      plan: selectedPlan,
      company: accountType === "business" ? {
        name: companyName,
        size: companySize || undefined,
      } : undefined,
    });

    if (!result.success) {
      setError(result.error || "Erro ao criar conta. Tente novamente.");
    }
    setIsLoading(false);
  }

  const planFeatures = {
    free: {
      personal: ["Análise de Segurança", "Monitor Básico", "Assistente IA", "Simulador Phishing"],
      business: ["Tudo do Free +", "Gestão de Dispositivos", "Relatórios Simples", "Suporte por Email"]
    },
    pro: {
      personal: ["Análise Profunda do Computador", "Monitor em Tempo Real", "IA Avançada", "Detecção Comportamental", "Auto-Quarentena", "Todos os Jogos"],
      business: ["Tudo do Pro +", "Relatórios Avançados", "Logs Detalhados", "Proteção USB/Startup"]
    },
    premium: {
      personal: ["Tudo do Pro +", "Suporte Prioritário", "Relatórios Exportáveis", "Novos Recursos antecipados"],
      business: ["Tudo do Business Pro +", "API de Gestão", "SLA Garantido", "Gerente de Conta"]
    }
  };

  const planLabels: Record<PlanType, { personal: string; business: string }> = {
    free: { personal: "Free", business: "Business Free" },
    pro: { personal: "Personal Pro", business: "Business Pro" },
    premium: { personal: "Personal Premium", business: "Business Premium" }
  };

  return (
    <div className="auth-page">
      <div className="auth-bg-gradient" />
      <div className="auth-bg-orb auth-bg-orb-1" />
      <div className="auth-bg-orb auth-bg-orb-2" />
      <div className="auth-bg-orb auth-bg-orb-3" />
      <div className="auth-grid-overlay" />

      <motion.div
        initial={{ opacity: 0, y: 30, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className="auth-card auth-card-register"
      >
        <div className="auth-card-header">
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.2, type: "spring", stiffness: 200 }}
            className="auth-logo"
          >
            <div className="auth-logo-icon">
              <Shield className="w-8 h-8 text-primary" />
              <div className="auth-logo-pulse" />
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
          >
            <h1 className="auth-title">Criar Conta</h1>
            <p className="auth-subtitle">Escolha seu plano e proteja-se</p>
          </motion.div>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          {error && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              className="auth-error"
            >
              <span>{error}</span>
            </motion.div>
          )}

          {/* Account Type */}
          <div className="auth-field">
            <label className="auth-label">Tipo de Conta</label>
            <div className="auth-type-grid">
              <motion.button
                type="button"
                onClick={() => setAccountType("personal")}
                className={`auth-type-card ${accountType === "personal" ? "auth-type-card-active" : ""}`}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
              >
                <div className="auth-type-card-icon">
                  <User className="w-6 h-6" />
                </div>
                <div className="auth-type-card-content">
                  <span className="auth-type-card-title">Pessoal</span>
                  <span className="auth-type-card-desc">Uso individual</span>
                </div>
                {accountType === "personal" && (
                  <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} className="auth-type-card-check">
                    <Check className="w-3.5 h-3.5" />
                  </motion.div>
                )}
              </motion.button>

              <motion.button
                type="button"
                onClick={() => setAccountType("business")}
                className={`auth-type-card ${accountType === "business" ? "auth-type-card-active auth-type-card-business" : ""}`}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
              >
                <div className="auth-type-card-icon">
                  <Building2 className="w-6 h-6" />
                </div>
                <div className="auth-type-card-content">
                  <span className="auth-type-card-title">Empresa</span>
                  <span className="auth-type-card-desc">Recursos corporativos</span>
                </div>
                {accountType === "business" && (
                  <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} className="auth-type-card-check">
                    <Check className="w-3.5 h-3.5" />
                  </motion.div>
                )}
              </motion.button>
            </div>
          </div>

          {/* Plan Selector */}
          {accountType && (
            <div className="auth-field">
              <label className="auth-label">Escolha seu Plano</label>
              <div className="flex flex-col gap-3">
                {(["free", "pro", "premium"] as PlanType[]).map((plan) => (
                  <motion.button
                    key={plan}
                    type="button"
                    onClick={() => setSelectedPlan(plan)}
                    className={`p-4 rounded-xl border-2 transition-all text-left flex items-center justify-between ${
                      selectedPlan === plan
                        ? "border-primary bg-primary/10"
                        : "border-border/50 hover:border-primary/50 bg-secondary/30"
                    }`}
                    whileHover={{ scale: 1.01 }}
                    whileTap={{ scale: 0.99 }}
                  >
                    <div className="flex items-center gap-3">
                      {plan === "pro" && <Zap className="w-5 h-5 text-cyber-yellow" />}
                      {plan === "premium" && <Crown className="w-5 h-5 text-primary" />}
                      <div>
                        <div className="font-mono font-semibold text-foreground">
                          {planLabels[plan][accountType]}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {plan === "free" ? "Gratuito para sempre" : plan === "pro" ? "R$19,90/mês" : "R$49,90/mês"}
                        </div>
                      </div>
                    </div>
                    {selectedPlan === plan && <Check className="w-5 h-5 text-primary" />}
                  </motion.button>
                ))}
              </div>

              <AnimatePresence>
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  className="mt-3 p-3 bg-secondary/30 rounded-lg"
                >
                  <div className="text-xs font-mono text-muted-foreground mb-2">Inclui:</div>
                  <div className="flex flex-wrap gap-2">
                    {planFeatures[selectedPlan][accountType].map((f: string) => (
                      <span key={f} className="text-xs px-2 py-1 bg-primary/10 text-primary rounded">
                        {f}
                      </span>
                    ))}
                  </div>
                </motion.div>
              </AnimatePresence>
            </div>
          )}

          {/* Name */}
          <div className="auth-field">
            <label className="auth-label" htmlFor="register-name">Nome</label>
            <div className="auth-input-wrapper">
              <User className="auth-input-icon" />
              <input
                id="register-name"
                type="text"
                placeholder="Seu nome completo"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="auth-input"
                required
                autoComplete="name"
              />
            </div>
          </div>

          {/* Email */}
          <div className="auth-field">
            <label className="auth-label" htmlFor="register-email">Email</label>
            <div className="auth-input-wrapper">
              <Mail className="auth-input-icon" />
              <input
                id="register-email"
                type="email"
                placeholder="seu@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="auth-input"
                required
                autoComplete="email"
              />
            </div>
          </div>

          {/* Password */}
          <div className="auth-field">
            <label className="auth-label" htmlFor="register-password">Senha</label>
            <div className="auth-input-wrapper">
              <Lock className="auth-input-icon" />
              <input
                id="register-password"
                type={showPassword ? "text" : "password"}
                placeholder="Mínimo 6 caracteres"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="auth-input"
                required
                autoComplete="new-password"
              />
              <button type="button" onClick={() => setShowPassword(!showPassword)} className="auth-input-action">
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            {password && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="auth-password-strength">
                <div className="auth-strength-bar">
                  {[1, 2, 3, 4].map((i) => (
                    <div key={i} className={`auth-strength-segment ${i <= passwordStrength.level ? passwordStrength.color : "bg-muted"}`} />
                  ))}
                </div>
                <span className="auth-strength-label">{passwordStrength.label}</span>
              </motion.div>
            )}
          </div>

          {/* Confirm Password */}
          <div className="auth-field">
            <label className="auth-label" htmlFor="register-confirm-password">Confirmar Senha</label>
            <div className="auth-input-wrapper">
              <Lock className="auth-input-icon" />
              <input
                id="register-confirm-password"
                type={showPassword ? "text" : "password"}
                placeholder="Repita a senha"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="auth-input"
                required
                autoComplete="new-password"
              />
              {confirmPassword && password === confirmPassword && <Check className="w-4 h-4 text-emerald-500 mr-3" />}
            </div>
          </div>

          {/* Business fields */}
          <AnimatePresence>
            {accountType === "business" && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="auth-business-fields"
              >
                <div className="auth-business-divider">
                  <Building2 className="w-4 h-4 text-primary" />
                  <span>Dados da Empresa</span>
                </div>
                <div className="auth-field">
                  <label className="auth-label" htmlFor="register-company">Nome da Empresa *</label>
                  <div className="auth-input-wrapper">
                    <Building2 className="auth-input-icon" />
                    <input id="register-company" type="text" placeholder="Ex: TechCorp Lda." value={companyName} onChange={(e) => setCompanyName(e.target.value)} className="auth-input" required />
                  </div>
                </div>
                <div className="auth-field">
                  <label className="auth-label" htmlFor="register-company-size">Nº de Funcionários</label>
                  <div className="auth-input-wrapper">
                    <Users className="auth-input-icon" />
                    <select id="register-company-size" value={companySize} onChange={(e) => setCompanySize(e.target.value)} className="auth-input auth-select">
                      <option value="">Selecionar...</option>
                      <option value="1-10">1-10</option>
                      <option value="11-50">11-50</option>
                      <option value="51-200">51-200</option>
                      <option value="201-500">201-500</option>
                      <option value="500+">500+</option>
                    </select>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <motion.button
            type="submit"
            disabled={isLoading || !accountType}
            className="auth-submit"
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.98 }}
          >
            {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <>Criar Conta <ArrowRight className="w-4 h-4" /></>}
          </motion.button>
        </form>

        <div className="auth-footer">
          <span>Já tem uma conta?</span>
          <button onClick={onSwitchToLogin} className="auth-link">Iniciar sessão</button>
        </div>
        <div className="auth-card-line" />
      </motion.div>

      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.8 }} className="auth-branding">
        <Shield className="w-3.5 h-3.5 text-primary/50" />
        <span>Protected by CyberSafe Security</span>
      </motion.div>
    </div>
  );
}
