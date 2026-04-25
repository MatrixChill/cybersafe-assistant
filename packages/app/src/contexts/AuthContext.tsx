import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import type { AccountType, PlanType } from "../lib/featureControl";

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
  company?: Company;
  createdAt: string;
}

interface RegisterData {
  name: string;
  email: string;
  password: string;
  type: AccountType;
  plan?: PlanType;
  company?: Company;
}

interface LoginData {
  email: string;
  password: string;
}

interface AuthContextType {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (data: LoginData) => Promise<{ success: boolean; error?: string }>;
  register: (data: RegisterData) => Promise<{ success: boolean; error?: string }>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

const API_BASE = "http://localhost:4000";
const TOKEN_KEY = "cybersafe_token";

// ── Provider ──
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Restore session on mount — or auto-login with a dev test account
  useEffect(() => {
    const token = localStorage.getItem(TOKEN_KEY);

    if (token) {
      // Try to restore existing session
      fetch(`${API_BASE}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((res) => {
          if (!res.ok) throw new Error("Invalid token");
          return res.json();
        })
        .then((data) => {
          setUser(data.user);
        })
        .catch(() => {
          localStorage.removeItem(TOKEN_KEY);
          // If token was invalid, auto-login again
          autoLogin();
        })
        .finally(() => {
          setIsLoading(false);
        });
    } else {
      autoLogin();
    }

    async function autoLogin() {
      try {
        // Try to login with test account first
        let res = await fetch(`${API_BASE}/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "admin@cybersafe.local", password: "CyberSafe2026!" }),
        });

        // If test account doesn't exist, register it
        if (!res.ok) {
          res = await fetch(`${API_BASE}/auth/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: "CyberSafe Admin",
              email: "admin@cybersafe.local",
              password: "CyberSafe2026!",
              type: "personal",
              plan: "premium",
            }),
          });
        }

        if (res.ok) {
          const json = await res.json();
          localStorage.setItem(TOKEN_KEY, json.token);
          setUser(json.user);
        }
      } catch {
        // API not ready yet, ignore
      } finally {
        setIsLoading(false);
      }
    }
  }, []);

  const login = useCallback(async (data: LoginData) => {
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      const json = await res.json();

      if (!res.ok) {
        return { success: false, error: json.message || "Erro ao fazer login." };
      }

      localStorage.setItem(TOKEN_KEY, json.token);
      setUser(json.user);
      return { success: true };
    } catch {
      return { success: false, error: "Erro de conexão com o servidor." };
    }
  }, []);

  const register = useCallback(async (data: RegisterData) => {
    try {
      const res = await fetch(`${API_BASE}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      const json = await res.json();

      if (!res.ok) {
        return { success: false, error: json.message || "Erro ao criar conta." };
      }

      localStorage.setItem(TOKEN_KEY, json.token);
      setUser(json.user);
      return { success: true };
    } catch {
      return { success: false, error: "Erro de conexão com o servidor." };
    }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setUser(null);
  }, []);

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
