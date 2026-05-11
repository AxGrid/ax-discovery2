import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, Me, setBearerToken } from "./api";
import { applyCorpTheme, isIframe, loadCorpSDK } from "./corp";

type Mode = "standalone" | "iframe";

type Ctx = {
  me: Me | null;
  loading: boolean;
  mode: Mode;
  refresh: () => Promise<void>;
  login: (identifier: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthCtx = createContext<Ctx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  // We assume standalone until the iframe handshake completes; UI only
  // diverges in tiny ways (no Login page when in iframe), so guessing
  // wrong for one render cycle is harmless.
  const [mode, setMode] = useState<Mode>("standalone");

  async function refresh() {
    try {
      const m = await api.me();
      setMe(m);
    } catch {
      setMe(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (isIframe()) {
        try {
          const r = await loadCorpSDK();
          if (cancelled) return;
          setBearerToken(r.token);
          applyCorpTheme(r.theme);
          // Wire token refresh so long-lived tabs survive token rotation
          // without the user having to reload.
          window.CorpSDK?.onTokenRefresh?.((t) => setBearerToken(t));
          window.CorpSDK?.onTheme?.(applyCorpTheme);
          setMode("iframe");
        } catch {
          // Fall back to standalone — maybe the user opened the iframe
          // URL directly in a new tab, in which case the cookie session
          // (if any) still works.
        }
      }
      await refresh();
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  async function login(identifier: string, password: string) {
    await api.login(identifier, password);
    await refresh();
  }

  async function logout() {
    try {
      await api.logout();
    } finally {
      // Drop both cookie-session-derived identity AND iframe token. The
      // iframe parent is the canonical sign-out trigger; clicking Sign
      // out inside the iframe just clears our local state.
      setMe(null);
      setBearerToken(null);
    }
  }

  return (
    <AuthCtx.Provider value={{ me, loading, mode, refresh, login, logout }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  const c = useContext(AuthCtx);
  if (!c) throw new Error("useAuth must be inside AuthProvider");
  return c;
}
