import { validateSavedSession } from "../lib/authSessionValidation";
import { restoreAuthSession, saveAuthSession, clearAuthSession, getAuthToken, authTokenExpiresAt } from "../lib/authSession";
import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import type { AccountType, PlanType, Role } from "../lib/featureControl";

export interface Company {
  name: string;
  size?: string;
  sector?: string;
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  type: AccountType;
  plan: PlanType;
  role: Role;
  company?: Company;
  createdAt: string;
}

/**
 * O registo público não escolhe plano: `plan` saiu daqui porque a API já ignora
 * o campo (`packages/api/src/index.ts:322-325` — `userPlan = "free"`) e a UI ao
 * mandá-lo fingia uma escolha que não existe. `PlanType` continua a existir,
 * com todo o respeito, para as contas a quem a autoridade já atribuiu `pro` ou
 * `premium`; só não se compra nada no ecrã de entrada.
 */
interface RegisterData {
  name: string;
  email: string;
  password: string;
  type: AccountType;
  company?: Company;
}

interface LoginData {
  remember?: boolean;
  email: string;
  password: string;
}

/** Campo a assinalar quando a API recusa o pedido — é o que permite ao ecrã pôr
    a mensagem junto do sítio certo em vez de um texto solto no topo. */
export type CampoDeErro = "name" | "email" | "password" | "company" | "type" | "geral";

export interface ResultadoDeAutenticacao {
  success: boolean;
  error?: string;
  campo?: CampoDeErro;
}

interface AuthContextType {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (data: LoginData) => Promise<ResultadoDeAutenticacao>;
  register: (data: RegisterData) => Promise<ResultadoDeAutenticacao>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

// S3: a API local só escuta em loopback IPv4; 127.0.0.1 evita o mismatch com
// "localhost" (que pode resolver para ::1 sem listener).
// P0-ISOLAR-ELECTRON-DEV: em DEV a base vem do perfil isolado, injectado pelo
// preload (`__CYBERSAFE_API_BASE__`), exatamente como o `AIAssistant` já faz. O
// default continua a ser a porta do artefacto, por isso o comportamento
// empacotado não muda. Sem este override, um dev autenticava contra a API da
// instalação.
const API_BASE =
  (typeof window !== "undefined" ? (window as unknown as { __CYBERSAFE_API_BASE__?: string }).__CYBERSAFE_API_BASE__ : undefined) ||
  "http://127.0.0.1:4000";


/**
 * Tradução de um estado HTTP para texto de pessoa, com o campo responsável.
 *
 * Porque é uma função pura e exportada: (1) o ecrã não decide mensagens ao
 * sabor do `catch`; (2) a conversa fica testável sem rede. E porque o `corpo.error`
 * **nunca** é lido: o 500 da API leva `error: String(error)`
 * (`packages/api/src/index.ts:372`) — isso é stack e caminho de servidor, e
 * colocá-lo num `<p>` de um ecrã de login seria o eco que este produto não pode
 * ter. O `message` da API serve só para **escolher o campo**; a frase é nossa e
 * em pt-PT (a API escreve «senha»).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function mensagemDeFalhaDeAutenticacao(
  status: number,
  corpo: { message?: unknown } | null | undefined,
): { error: string; campo: CampoDeErro } {
  const mensagem = typeof corpo?.message === "string" ? corpo.message : "";

  if (status === 409) {
    return { error: "Já existe uma conta com este email. Inicia sessão ou usa outro email.", campo: "email" };
  }
  if (status === 401) {
    return { error: "Email e palavra-passe não correspondem a nenhuma conta.", campo: "password" };
  }
  if (status === 403) {
    return { error: "Esta conta não tem permissão para o que foi pedido.", campo: "geral" };
  }
  if (status === 400) {
    if (/email/i.test(mensagem)) {
      return { error: "O formato do email não é válido.", campo: "email" };
    }
    if (/senha|password/i.test(mensagem)) {
      return { error: "A palavra-passe tem de ter pelo menos 6 caracteres.", campo: "password" };
    }
    if (/empresa/i.test(mensagem)) {
      return { error: "O nome da empresa é obrigatório numa conta de empresa.", campo: "company" };
    }
    if (/tipo/i.test(mensagem)) {
      return { error: "O tipo de conta não é reconhecido.", campo: "type" };
    }
    if (/obrigat/i.test(mensagem)) {
      return { error: "Faltam dados obrigatórios para criar a conta.", campo: "name" };
    }
    return { error: "O pedido foi recusado pelo servidor de contas.", campo: "geral" };
  }
  if (status === 503) {
    return { error: "O servidor de contas recusou o pedido (503). Tenta novamente mais tarde.", campo: "geral" };
  }
  // 500 e restantes: diz o estado, não inventa causa, não ecoa nada do corpo.
  return {
    error: `O servidor de contas não completou o pedido (estado ${status}). Não foi confirmado que a conta tenha sido criada.`,
    campo: "geral",
  };
}

/** Sem resposta nenhuma: a ligação falhou, não o pedido. Dizer apenas «erro de
    conexão» sem dizer o que aconteceu deixa a pessoa a tentar outra vez sem saber
    se já existe conta criada. */
// eslint-disable-next-line react-refresh/only-export-components
export const FALHA_DE_LIGACAO = {
  error: "A API de contas não respondeu — não é possível saber se o pedido chegou. Verifica se o serviço está em execução.",
  campo: "geral" as CampoDeErro,
};

/**
 * O corpo do `POST /auth/register`, construído numa função pura para se poder
 * provar o que sai da máquina sem haver rede.
 *
 * Não leva `plan`: o registo público não escolhe plano — a API ignora o campo
 * (`api/src/index.ts:322-325`, nasce sempre `free`) e também ignora `role`
 * (`:358`). Enviar `plan` seria deixar no contrato do ecrã uma escolha que não
 * existe, e é exatamente assim que um formulário acaba a vender planos.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function corpoDeRegisto(data: RegisterData): Record<string, unknown> {
  return {
    name: data.name,
    email: data.email,
    password: data.password,
    type: data.type,
    company: data.type === "business" ? data.company : undefined,
  };
}

// S2 (2026-10-09): não existe conta embutida, auto-login nem promoção
// automática a admin. A identidade vem sempre de /auth/login ou /auth/register
// e a autorização de features usa sempre user.role (featureControl).

// Payloads antigos (sem role) ou com role inválido degradam para "user".
function normalizeUser(raw: Omit<AuthUser, "role"> & { role?: Role }): AuthUser {
  return { ...raw, role: raw.role === "admin" ? "admin" : "user" };
}

// ── Provider ──
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const authGeneration = useRef(0);
  const restoreAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    restoreAbort.current = controller;
    const generation = authGeneration.current;
    void (async () => {
      try {
        const token = await restoreAuthSession();
        if (!token) return;
        const res = await validateSavedSession(API_BASE, token, controller.signal);
        if (!active || generation !== authGeneration.current) return;
        if ([401, 403, 404].includes(res.status)) { await clearAuthSession(); return; }
        if (!res.ok) return; // Keep encrypted session on transport/server failure; no identity fabricated.
        const data = await res.json();
        if (active && generation === authGeneration.current && data?.user?.id) setUser(normalizeUser(data.user));
      } catch { /* No response establishes no identity. Retry is a later launch/login. */ }
      finally { if (active && generation === authGeneration.current) setIsLoading(false); }
    })();
    return () => { active = false; controller.abort(); };
  }, []);

  const login = useCallback(async (data: LoginData) => {
    restoreAbort.current?.abort();
    setIsLoading(false);
    const generation = ++authGeneration.current;
    setUser(null);
    try { await clearAuthSession(); } catch { return { success: false, error: "Não foi possível limpar a sessão anterior.", campo: "geral" as CampoDeErro }; }
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: data.email, password: data.password }),
      });
    } catch {
      return { success: false, ...FALHA_DE_LIGACAO };
    }

    // Um servidor a responder HTML (proxy, crash page) não é um corpo de erro:
    // ler `json()` rebentaria aqui e o ecrã ficava sem nenhuma explicação.
    const corpo = await res.json().catch(() => null);
    if (!res.ok) {
      return { success: false, ...mensagemDeFalhaDeAutenticacao(res.status, corpo) };
    }

    if (!corpo?.user?.id || typeof corpo.token !== "string" || !corpo.token) return { success: false, error: "O servidor não devolveu uma sessão válida.", campo: "geral" as CampoDeErro };
    if (generation !== authGeneration.current) return { success: false };
    try { await saveAuthSession(corpo.token, data.remember === true); }
    catch { return { success: false, error: "Não foi possível guardar a sessão com segurança.", campo: "geral" as CampoDeErro }; }
    if (generation !== authGeneration.current) return { success: false };
    setUser(normalizeUser(corpo.user));
    setIsLoading(false);
    return { success: true };
  }, []);

  const register = useCallback(async (data: RegisterData) => {
    restoreAbort.current?.abort();
    setIsLoading(false);
    const generation = ++authGeneration.current;
    setUser(null);
    try { await clearAuthSession(); } catch { return { success: false, error: "Não foi possível limpar a sessão anterior.", campo: "geral" as CampoDeErro }; }
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corpoDeRegisto(data)),
      });
    } catch {
      return { success: false, ...FALHA_DE_LIGACAO };
    }

    const corpo = await res.json().catch(() => null);
    if (!res.ok) {
      return { success: false, ...mensagemDeFalhaDeAutenticacao(res.status, corpo) };
    }

    if (!corpo?.user?.id || typeof corpo.token !== "string" || !corpo.token) return { success: false, error: "O servidor não devolveu uma sessão válida.", campo: "geral" as CampoDeErro };
    if (generation !== authGeneration.current) return { success: false };
    try { await saveAuthSession(corpo.token, false); }
    catch { return { success: false, error: "Não foi possível guardar a sessão com segurança.", campo: "geral" as CampoDeErro }; }
    if (generation !== authGeneration.current) return { success: false };
    setUser(normalizeUser(corpo.user));
    setIsLoading(false);
    return { success: true };
  }, []);

  // R6-L12: o logout local (limpar o token) não revoga um JWT — um token
  // capturado continua válido até expirar. Além de limpar a sessão na UI, avisa
  // o servidor (POST /auth/logout) para revogar o token. É best-effort e
  // fire-and-forget: a assinatura mantém-se síncrona (o utilizador sai já, sem
  // esperar pela rede) e, se a API estiver em baixo, o logout local não falha.
  const logout = useCallback(() => {
    restoreAbort.current?.abort();
    setIsLoading(false);
    ++authGeneration.current;
    const token = getAuthToken();
    void clearAuthSession().catch(() => { /* Logout marker prevents local restoration. */ });
    setUser(null);
    if (token) {
      void fetch(`${API_BASE}/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {
        // Servidor indisponível: a sessão local já foi encerrada; a revogação
        // fica por confirmar (nunca fabricamos sucesso).
      });
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    const expiresAt = authTokenExpiresAt();
    if (expiresAt === null) return;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) { logout(); return; }
    const timer = setTimeout(logout, Math.min(remaining, 2147483647));
    return () => clearTimeout(timer);
  }, [user, logout]);

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        isLoading,
        login,
        register,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// ── Hook ──
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
