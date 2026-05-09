import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, Me } from "./api";

type Ctx = {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthCtx = createContext<Ctx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    try {
      const m = await api.me();
      setMe(m);
    } catch {
      setMe(null);
    }
  }

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, []);

  async function login(username: string, password: string) {
    await api.login(username, password);
    await refresh();
  }

  async function logout() {
    try {
      await api.logout();
    } finally {
      setMe(null);
    }
  }

  return (
    <AuthCtx.Provider value={{ me, loading, refresh, login, logout }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  const c = useContext(AuthCtx);
  if (!c) throw new Error("useAuth must be inside AuthProvider");
  return c;
}
