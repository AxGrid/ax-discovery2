import { useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { Logo } from "@/components/Logo";
import { Button, Card, CardContent, Input, Label, ThemeToggle } from "@/components/ui";

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
    <div className="min-h-screen flex items-center justify-center bg-bg p-6">
      <div className="absolute top-4 right-4"><ThemeToggle /></div>
      <Card className="w-full max-w-sm">
        <CardContent className="pt-6">
          <form onSubmit={submit}>
            <div className="flex flex-col items-center gap-3 mb-6">
              <Logo size={48} />
              <div className="text-center">
                <div className="text-xl font-semibold tracking-tight">discovery</div>
                <div className="text-sm text-fg-muted mt-1">Sign in to continue</div>
              </div>
            </div>
            {error && (
              <div className="text-sm text-danger mb-3 text-center">{error}</div>
            )}
            <div className="space-y-3">
              <div>
                <Label htmlFor="username">Username</Label>
                <Input id="username" value={username}
                  onChange={e => setUsername(e.target.value)}
                  autoComplete="username" autoFocus required />
              </div>
              <div>
                <Label htmlFor="password">Password</Label>
                <Input id="password" type="password" value={password}
                  onChange={e => setPassword(e.target.value)}
                  autoComplete="current-password" required />
              </div>
            </div>
            <Button type="submit" className="w-full mt-5" loading={submitting}>
              {submitting ? "Signing in…" : "Sign in"}
            </Button>
            <div className="mt-4 text-xs text-fg-muted text-center">
              Default admin in <code className="font-mono">.env</code>:
              {" "}<code className="font-mono">DISCOVERY_DEFAULT_ADMIN_USER</code> /
              {" "}<code className="font-mono">DISCOVERY_DEFAULT_ADMIN_PASSWORD</code>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
