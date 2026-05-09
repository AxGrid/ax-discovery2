import { useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";

export default function Login() {
  const { me, login } = useAuth();
  const loc = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (me?.authenticated) {
    const redirect = (loc.state as { from?: string })?.from || "/";
    return <Navigate to={redirect} replace />;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true); setError(null);
    try {
      await login(username, password);
    } catch (err: any) {
      setError(err.message || "Login failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-zinc-950 p-6">
      <div className="absolute top-4 right-4"><ThemeToggle /></div>
      <form onSubmit={submit} className="card w-full max-w-sm">
        <div className="flex flex-col items-center gap-3 mb-6">
          <Logo size={48} />
          <div className="text-center">
            <div className="text-xl font-semibold tracking-tight">discovery</div>
            <div className="text-sm text-zinc-500 mt-1">Sign in to continue</div>
          </div>
        </div>
        {error && (
          <div className="text-sm text-red-600 dark:text-red-400 mb-3 text-center">{error}</div>
        )}
        <div className="space-y-3">
          <div>
            <label className="label">Username</label>
            <input className="input" value={username}
              onChange={e => setUsername(e.target.value)}
              autoComplete="username" autoFocus required />
          </div>
          <div>
            <label className="label">Password</label>
            <input type="password" className="input" value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password" required />
          </div>
        </div>
        <button type="submit" className="btn-primary w-full mt-5" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </button>
        <div className="mt-4 text-xs text-zinc-500 text-center">
          Default admin in <code className="kbd">.env</code>:
          {" "}<code className="kbd">DISCOVERY_DEFAULT_ADMIN_USER</code> /
          {" "}<code className="kbd">DISCOVERY_DEFAULT_ADMIN_PASSWORD</code>
        </div>
      </form>
    </div>
  );
}
