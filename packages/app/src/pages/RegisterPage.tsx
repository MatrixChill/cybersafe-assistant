import { useRef, useState } from "react";
import { isValidEmailFormat } from "@cybersafe/shared-types";
import { useAuth, type CampoDeErro } from "../contexts/AuthContext";
import type { AccountType } from "../lib/featureControl";
import {
  Shield, Mail, Lock, Eye, EyeOff, Loader2, ArrowRight,
  User, Building2, Users, Check, Info, CircleAlert,
} from "lucide-react";

interface RegisterPageProps {
  onSwitchToLogin: () => void;
}

export interface DadosDeRegisto {
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
  accountType: AccountType | null;
  companyName: string;
}

/** Ordem fixa: é a ordem em que os campos aparecem no formulário, e por isso a
    ordem em que o foco deve cair. Não é ordem de severidade inventada. */
const ORDEM_CAMPOS: CampoDeErro[] = ["name", "email", "password", "company", "type", "geral"];

/**
 * Validação do registo, pura e exportada para se poder testar sem DOM nem rede.
 * O sitio certo seria um módulo próprio, mas criar ficheiro novo está fora do
 * scope desta lane.
 *
 * Duas regras que não são gosto:
 *  - **todos** os campos inválidos de uma vez, não o primeiro: uma pessoa com o
 *    email e a palavra-passe ambos errados não pode ter de submeter duas vezes
 *    para descobrir a segunda;
 *  - as condições são as **da API** (campos obrigatórios, email com
 *    `isValidEmailFormat` — o helper partilhado da @cybersafe/shared-types,
 *    o mesmo que a API usa desde 16/10/2026 —, palavra-passe com 6, empresa
 *    com nome), para o ecrã não recusar o que o servidor aceitaria, nem
 *    aceitar o que ele havia de recusar.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function validarRegisto(dados: DadosDeRegisto): Partial<Record<CampoDeErro, string>> {
  const erros: Partial<Record<CampoDeErro, string>> = {};

  if (!dados.name.trim()) {
    erros.name = "Indica o nome que queres ver na conta.";
  }

  const email = dados.email.trim();
  if (!email) {
    erros.email = "O email é obrigatório: é com ele que inicias sessão.";
  } else if (!isValidEmailFormat(email)) {
    erros.email = "O formato do email não é válido.";
  }

  if (!dados.password) {
    erros.password = "A palavra-passe é obrigatória.";
  } else if (dados.password.length < 6) {
    erros.password = "A palavra-passe tem de ter pelo menos 6 caracteres.";
  }

  if (dados.confirmPassword !== dados.password) {
    erros.password = erros.password
      ? `${erros.password} As duas palavras-passe não coincidem.`
      : "As duas palavras-passe não coincidem.";
  }

  if (!dados.accountType) {
    erros.type = "Escolhe o tipo de conta.";
  } else if (dados.accountType === "business" && !dados.companyName.trim()) {
    erros.company = "O nome da empresa é obrigatório numa conta de empresa.";
  }

  return erros;
}

/** O primeiro campo inválido, na ordem do formulário. É daqui que vem o foco. */
// eslint-disable-next-line react-refresh/only-export-components
export function primeiroCampoInvalido(erros: Partial<Record<CampoDeErro, string>>): CampoDeErro | null {
  return ORDEM_CAMPOS.find((campo) => Boolean(erros[campo])) ?? null;
}

/**
 * O id do campo e o id da mensagem de erro desse campo. Um `aria-describedby`
 * que aponta para um id que não existe no DOM não é acessibilidade: é um
 * atributo decorativo. Vive num par de funções para o markup do `<input>`, do
 * `<label for>` e do `<p id>` não poderem divergir.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function idDoCampo(campo: CampoDeErro): string | null {
  switch (campo) {
    case "name": return "register-name";
    case "email": return "register-email";
    case "password": return "register-password";
    case "company": return "register-company";
    default: return null;
  }
}

// eslint-disable-next-line react-refresh/only-export-components
export function idDoErro(campo: CampoDeErro): string | null {
  const base = idDoCampo(campo);
  return base ? `${base}-erro` : null;
}

/**
 * Os atributos de um campo com o erro atual. Sem erro, nada é afirmado — um
 * `aria-invalid="false"` permanente é ruído. A borda vermelha não é decoração:
 * é o par do texto, para quem não lê a cor poder chegar à mesma conclusão pelo
 * `aria-describedby`.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function atributosDeCampo(
  campo: CampoDeErro,
  erros: Partial<Record<CampoDeErro, string>>,
): { "aria-invalid"?: true; "aria-describedby"?: string; style?: { borderColor: string } } {
  if (!erros[campo]) return {};
  const alvo = idDoErro(campo);
  return {
    "aria-invalid": true,
    ...(alvo ? { "aria-describedby": alvo } : {}),
    // Token do sistema de design (aresta do estado crítico), não um hex solto.
    style: { borderColor: "var(--state-crit-edge)" },
  };
}

/**
 * Revalidação ao corrigir: depois do primeiro submit, cada tecla volta a
 * computar o formulário inteiro. Não é «esconder erros» nem «mostrar tudo
 * enquanto se escreve pela primeira vez» — é a mesma regra de sempre a ser
 * reavaliada, portanto um erro novo que apareça pelo meio também aparece no
 * ecrã, e um corrigido desaparece sem ter de voltar a carregar no submit.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function revalidarAoEditar(
  dados: DadosDeRegisto,
  jaSubmetido: boolean,
): Partial<Record<CampoDeErro, string>> {
  return jaSubmetido ? validarRegisto(dados) : {};
}

/** A linha de erro de um campo: ícone + texto + id, anunciada. Exportada para
 *  o teste a poder renderizar isolada (o estado do formulário não é acessível
 *  de fora). */
export function MensagemDeErro({ campo, erros }: { campo: CampoDeErro; erros: Partial<Record<CampoDeErro, string>> }) {
  const texto = erros[campo];
  const id = idDoErro(campo);
  if (!texto || !id) return null;
  return (
    <p id={id} role="alert" className="mt-1 flex items-start gap-1.5 text-sm font-medium" style={{ color: "var(--cyber-red-text)" }}>
      <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{texto}</span>
    </p>
  );
}

export default function RegisterPage({ onSwitchToLogin }: RegisterPageProps) {
  const { register } = useAuth();
  // Pessoal é o estado por defeito: uma conta de uso individual é o que este
  // produto é para quem o instala numa máquina. Antes começava em `null`, e o
  // primeiro ecrã era um formulário com o botão morto e nenhuma explicação.
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [accountType, setAccountType] = useState<AccountType>("personal");
  const [companyName, setCompanyName] = useState("");
  const [companySize, setCompanySize] = useState("");
  const [erros, setErros] = useState<Partial<Record<CampoDeErro, string>>>({});
  /**
   * Erro por campo vindo do servidor (email ocupado, palavra-passe recusada).
   * Vive separado dos erros de validação porque tem outra vida: uma tecla no
   * campo a que pertence apaga-o — a resposta antiga falava do valor antigo.
   */
  const [errosServico, setErrosServico] = useState<Partial<Record<CampoDeErro, string>>>({});
  /** Depois do primeiro submit, o formulário volta a computar-se a cada tecla. */
  const [jaSubmetido, setJaSubmetido] = useState(false);
  const [erroDeServico, setErroDeServico] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const camposRef = useRef<Partial<Record<CampoDeErro, HTMLElement | null>>>({});

  /** O que o ecrã mostra: validação em baixo, resposta do servidor por cima. */
  const errosVisiveis: Partial<Record<CampoDeErro, string>> = { ...erros, ...errosServico };

  /**
   * Escrever num campo faz duas coisas: guardar o valor e revalidar o
   * formulário *inteiro* — não só o campo tocado. Corrigir o email tira o erro
   * do email; partir a confirmação da palavra-passe mostra-o na confirmação sem
   * ter de carregar outra vez no submit. A revalidação só depois do primeiro
   * submit, porque «ainda não tentei nada» não é um formulário inválido.
   */
  function mudar(novos: Partial<DadosDeRegisto>) {
    const dados: DadosDeRegisto = {
      name, email, password, confirmPassword, accountType, companyName, ...novos,
    };
    if ("name" in novos) setName(dados.name);
    if ("email" in novos) setEmail(dados.email);
    if ("password" in novos) setPassword(dados.password);
    if ("confirmPassword" in novos) setConfirmPassword(dados.confirmPassword);
    if ("companyName" in novos) setCompanyName(dados.companyName);
    if (jaSubmetido) setErros(revalidarAoEditar(dados, true));
    // A resposta do servidor falava do valor anterior deste campo: ao escrever
    // nele, a resposta antiga deixa de ser verdade.
    const CORPO_para_CAMPO: Partial<Record<keyof DadosDeRegisto, CampoDeErro>> = {
      name: "name", email: "email", password: "password",
      confirmPassword: "password", companyName: "company",
    };
    const tocados = (Object.keys(novos) as (keyof DadosDeRegisto)[])
      .map((chave) => CORPO_para_CAMPO[chave])
      .filter((campo): campo is CampoDeErro => Boolean(campo));
    if (tocados.length > 0) {
      setErrosServico((atuais) => {
        const proximo = { ...atuais };
        for (const campo of tocados) delete proximo[campo];
        return Object.keys(proximo).length === Object.keys(atuais).length ? atuais : proximo;
      });
    }
  }

  function registarCampo(campo: CampoDeErro) {
    return (elemento: HTMLElement | null) => { camposRef.current[campo] = elemento; };
  }

  /** Escolher o tipo limpa apenas a queixa do tipo: as queixas dos outros campos
      são verdade independentemente do que se acabou de escolher. */
  function escolherTipo(tipo: AccountType) {
    setAccountType(tipo);
    setErros((atuais) => {
      if (!atuais.type) return atuais;
      const proximos = { ...atuais };
      delete proximos.type;
      return proximos;
    });
  }

  function focarPrimeiroInvalido(errosAtuais: Partial<Record<CampoDeErro, string>>) {
    const alvo = primeiroCampoInvalido(errosAtuais);
    if (!alvo) return;
    (camposRef.current[alvo] as HTMLElement | null)?.focus();
  }

  const passwordStrength = (() => {
    if (!password) return { level: 0, label: "", color: "" };
    let score = 0;
    if (password.length >= 6) score++;
    if (password.length >= 10) score++;
    if (/[A-Z]/.test(password)) score++;
    if (/[0-9]/.test(password)) score++;
    if (/[^A-Za-z0-9]/.test(password)) score++;

    if (score <= 1) return { level: 1, label: "Fraca", color: "bg-cyber-red/70" };
    if (score <= 2) return { level: 2, label: "Razoável", color: "bg-cyber-yellow/70" };
    if (score <= 3) return { level: 3, label: "Boa", color: "bg-cyber-cyan/70" };
    return { level: 4, label: "Forte", color: "bg-cyber-green/70" };
  })();

  const numeroDeErros = Object.keys(errosVisiveis).length;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErroDeServico(null);
    setJaSubmetido(true);
    // Uma resposta nova apaga a anterior: o «já existe um conta com este email»
    // refere-se ao valor do pedido anterior, não ao que está a ser escrito.
    setErrosServico({});

    const novosErros = validarRegisto({
      name, email, password, confirmPassword, accountType, companyName,
    });
    setErros(novosErros);
    if (primeiroCampoInvalido(novosErros)) {
      focarPrimeiroInvalido(novosErros);
      return;
    }

    setIsLoading(true);
    const result = await register({
      name: name.trim(),
      email: email.trim(),
      password,
      type: accountType ?? "personal",
      company: accountType === "business"
        ? { name: companyName.trim(), size: companySize || undefined }
        : undefined,
    });
    setIsLoading(false);

    if (!result.success) {
      // A falha da API vai para o campo a que pertence (email ocupado → email),
      // e o que não tem campo fica na faixa de estado. Nunca se repete a
      // palavra-passe, nem se ecoa o `error` do servidor.
      const campo = result.campo && result.campo !== "geral" ? result.campo : null;
      if (campo && result.error) {
        const noCampo = { ...erros, [campo]: result.error };
        setErrosServico({ [campo]: result.error });
        focarPrimeiroInvalido(noCampo);
      } else {
        setErroDeServico(result.error ?? "Não foi possível criar a conta.");
      }
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-bg-gradient" />
      <div className="auth-bg-orb auth-bg-orb-1" />
      <div className="auth-bg-orb auth-bg-orb-2" />
      <div className="auth-bg-orb auth-bg-orb-3" />
      <div className="auth-grid-overlay" />

      {/* Entrada em CSS, como no Painel e na Otimizar: `framer-motion` não cai
          com `prefers-reduced-motion`, e o contrato de movimento do produto é
          este (ver r6-l1-otimizar-visual). */}
      <div className="auth-card auth-card-register animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div className="auth-card-header">
          <div className="auth-logo">
            <div className="auth-logo-icon">
              <Shield className="w-8 h-8 text-primary" />
              <div className="auth-logo-pulse" />
            </div>
          </div>

          <div>
            <h1 className="auth-title">Criar conta</h1>
            <p className="auth-subtitle">
              Uma conta pessoal para esta máquina, ou uma conta de empresa.
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="auth-form" noValidate aria-busy={isLoading}>
          {/* Estado do formulário em vez de um texto solto: diz quantos campos
              faltam e o que aconteceu ao pedido, e é anunciado. */}
          <div role="status" aria-live="polite">
          {(isLoading || Boolean(erroDeServico?.trim()) || numeroDeErros > 0) && (
          <div className="auth-error">
            {isLoading && <span>A criar a conta…</span>}
            {!isLoading && erroDeServico && <span>{erroDeServico}</span>}
            {!isLoading && !erroDeServico && numeroDeErros > 0 && (
              <span>
                {numeroDeErros === 1 ? "1 campo precisa de atenção" : `${numeroDeErros} campos precisam de atenção`} —
                estão assinalados em baixo.
              </span>
            )}
          </div>

          )}
          </div>

          {/* Tipo de conta */}
          <div className="auth-field">
            <span className="auth-label" id="register-type-label">Tipo de conta</span>
            <div
                className="auth-type-grid"
                role="group"
                aria-labelledby="register-type-label"
                aria-describedby={errosVisiveis.type ? "register-type-erro" : undefined}
              >
              <button
                ref={registarCampo("type")}
                type="button"
                onClick={() => escolherTipo("personal")}
                aria-pressed={accountType === "personal"}
                className={`auth-type-card ${accountType === "personal" ? "auth-type-card-active" : ""}`}
              >
                <div className="auth-type-card-icon">
                  <User className="w-6 h-6" />
                </div>
                <div className="auth-type-card-content">
                  <span className="auth-type-card-title">Pessoal</span>
                  <span className="auth-type-card-desc">Uso individual</span>
                </div>
                {accountType === "personal" && (
                  <div className="auth-type-card-check">
                    <Check className="w-3.5 h-3.5" />
                  </div>
                )}
              </button>

              <button
                type="button"
                onClick={() => escolherTipo("business")}
                aria-pressed={accountType === "business"}
                className={`auth-type-card ${accountType === "business" ? "auth-type-card-active auth-type-card-business" : ""}`}
              >
                <div className="auth-type-card-icon">
                  <Building2 className="w-6 h-6" />
                </div>
                <div className="auth-type-card-content">
                  <span className="auth-type-card-title">Empresa</span>
                  <span className="auth-type-card-desc">Abre o Centro de Segurança de Empresa</span>
                </div>
                {accountType === "business" && (
                  <div className="auth-type-card-check">
                    <Check className="w-3.5 h-3.5" />
                  </div>
                )}
              </button>
            </div>
            {errosVisiveis.type && (
              <p id="register-type-erro" role="alert" className="mt-1 flex items-start gap-1.5 text-sm font-medium" style={{ color: "var(--cyber-red-text)" }}>
                <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>{errosVisiveis.type}</span>
              </p>
            )}
          </div>

          {/* O que o registo é, dito uma vez: não há aqui plano a escolher. */}
          <div className="auth-field">
            <div className="mt-1 flex items-start gap-2 rounded-lg border border-border bg-secondary/30 p-3">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <p className="row-note">
                Contas novas nascem sempre no plano <b className="font-semibold">Free</b> e o
                registo é gratuito: esta app não tem pagamentos, checkout nem subscrições. O
                plano de uma conta é atribuído por quem administra o produto — contas a que já
                foi atribuído <b className="font-semibold">Pro</b> ou <b className="font-semibold">Premium</b> continuam a ter
                o que têm, e entram normalmente.
              </p>
            </div>
          </div>

          {/* Nome */}
          <div className="auth-field">
            <label className="auth-label" htmlFor="register-name">Nome</label>
            <div className="auth-input-wrapper">
              <User className="auth-input-icon" />
              <input
                id="register-name"
                ref={registarCampo("name")}
                type="text"
                placeholder="O teu nome"
                value={name}
                onChange={(e) => mudar({ name: e.target.value })}
                className="auth-input"
                autoComplete="name"
                required
                {...atributosDeCampo("name", errosVisiveis)}
              />
            </div>
            <MensagemDeErro campo="name" erros={errosVisiveis} />
          </div>

          {/* Email */}
          <div className="auth-field">
            <label className="auth-label" htmlFor="register-email">Email</label>
            <div className="auth-input-wrapper">
              <Mail className="auth-input-icon" />
              <input
                id="register-email"
                ref={registarCampo("email")}
                type="email"
                placeholder="o.teu@email.com"
                value={email}
                onChange={(e) => mudar({ email: e.target.value })}
                className="auth-input"
                autoComplete="email"
                required
                {...atributosDeCampo("email", errosVisiveis)}
              />
            </div>
            <MensagemDeErro campo="email" erros={errosVisiveis} />
          </div>

          {/* Palavra-passe */}
          <div className="auth-field">
            <label className="auth-label" htmlFor="register-password">Palavra-passe</label>
            <div className="auth-input-wrapper">
              <Lock className="auth-input-icon" />
              <input
                id="register-password"
                ref={registarCampo("password")}
                type={showPassword ? "text" : "password"}
                placeholder="Mínimo 6 caracteres"
                value={password}
                onChange={(e) => mudar({ password: e.target.value })}
                className="auth-input"
                autoComplete="new-password"
                required
                {...atributosDeCampo("password", errosVisiveis)}
                aria-describedby={errosVisiveis.password ? "register-password-erro" : "register-password-dica"}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="auth-input-action"
                aria-label={showPassword ? "Esconder a palavra-passe" : "Mostrar a palavra-passe"}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            {password && !errosVisiveis.password && (
              <div className="auth-password-strength">
                <div className="auth-strength-bar">
                  {[1, 2, 3, 4].map((i) => (
                    <div key={i} className={`auth-strength-segment ${i <= passwordStrength.level ? passwordStrength.color : "bg-muted"}`} />
                  ))}
                </div>
                <span className="auth-strength-label">{passwordStrength.label}</span>
              </div>
            )}
            {errosVisiveis.password
              ? <MensagemDeErro campo="password" erros={errosVisiveis} />
              : <p id="register-password-dica" className="row-note mt-1">Pelo menos 6 caracteres.</p>}
          </div>

          {/* Confirmar palavra-passe */}
          <div className="auth-field">
            <label className="auth-label" htmlFor="register-confirm-password">Confirmar palavra-passe</label>
            <div className="auth-input-wrapper">
              <Lock className="auth-input-icon" />
              <input
                id="register-confirm-password"
                type={showPassword ? "text" : "password"}
                placeholder="Repete a palavra-passe"
                value={confirmPassword}
                onChange={(e) => mudar({ confirmPassword: e.target.value })}
                className="auth-input"
                autoComplete="new-password"
                required
                {...atributosDeCampo("password", errosVisiveis)}
              />
              {confirmPassword && password === confirmPassword && <Check className="w-4 h-4 text-cyber-green mr-3" aria-hidden />}
            </div>
          </div>

          {/* Campos de empresa */}
          {accountType === "business" && (
            <div className="auth-business-fields">
              <div className="auth-business-divider">
                <Building2 className="w-4 h-4 text-primary" aria-hidden />
                <span>Dados da empresa</span>
              </div>
              <div className="auth-field">
                <label className="auth-label" htmlFor="register-company">Nome da empresa</label>
                <div className="auth-input-wrapper">
                  <Building2 className="auth-input-icon" />
                  <input
                    id="register-company"
                    ref={registarCampo("company")}
                    type="text"
                    placeholder="Nome real da empresa"
                    value={companyName}
                    onChange={(e) => mudar({ companyName: e.target.value })}
                    className="auth-input"
                    required
                    {...atributosDeCampo("company", errosVisiveis)}
                  />
                </div>
                <MensagemDeErro campo="company" erros={errosVisiveis} />
              </div>
              <div className="auth-field">
                <label className="auth-label" htmlFor="register-company-size">Nº de colaboradores (opcional)</label>
                <div className="auth-input-wrapper">
                  <Users className="auth-input-icon" />
                  <select id="register-company-size" value={companySize} onChange={(e) => setCompanySize(e.target.value)} className="auth-input auth-select">
                    <option value="">Selecionar…</option>
                    <option value="1-10">1-10</option>
                    <option value="11-50">11-50</option>
                    <option value="51-200">51-200</option>
                    <option value="201-500">201-500</option>
                    <option value="500+">500+</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* Nunca desativado em silêncio: ou está a trabalhar e di-lo, ou está
              pronto e submete (a validação trata do resto). */}
          <button type="submit" disabled={isLoading} className="auth-submit">
            {isLoading
              ? <><Loader2 className="w-5 h-5 animate-spin" /> A criar a conta…</>
              : <>Criar conta <ArrowRight className="w-4 h-4" /></>}
          </button>
        </form>

        <div className="auth-footer">
          <span>Já tens uma conta?</span>
          <button onClick={onSwitchToLogin} className="auth-link">Iniciar sessão</button>
        </div>
        <div className="auth-card-line" />
      </div>

      <div className="auth-branding">
        <Shield className="w-3.5 h-3.5 text-primary/50" aria-hidden />
        <span>Proteção local — o estado real aparece no Painel</span>
      </div>
    </div>
  );
}
