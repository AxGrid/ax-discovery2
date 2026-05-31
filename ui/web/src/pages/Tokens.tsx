import { useEffect, useState } from "react";
import { Check, Copy, Eye, EyeOff, KeyRound, Plus, Shield, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, type ClientToken, type TokensResponse } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  Badge, Button, Card, CardContent,
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
  Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui";

// Tokens page lists the static service tokens (DISCOVERY_*_TOKENS env
// vars on the server). The endpoint filters by role: Read sees read,
// Write sees read+write, Admin sees all three. Anonymous users can't
// see anything — even with anonymous-read on the API, we 401 them
// because handing a copy-pasteable bearer to an unauthenticated visitor
// is not what the env vars are for.
//
// Tokens are masked by default with a per-row reveal toggle, plus a
// copy button that always copies the real value. We never log the raw
// value anywhere.

type Tier = "read" | "write" | "admin";

export default function Tokens() {
  const { me } = useAuth();
  const [data, setData] = useState<TokensResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.tokens()
      .then(setData)
      .catch(e => setErr(e?.message || "failed to load tokens"));
  }, []);

  if (err) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <PageHeader />
        <Card><CardContent className="pt-6 text-sm text-danger">{err}</CardContent></Card>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <PageHeader />
        <Card><CardContent className="pt-6 text-sm text-fg-muted">Loading…</CardContent></Card>
      </div>
    );
  }

  const tiers: Tier[] = ["read", "write", "admin"];

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <PageHeader />

      <Card>
        <CardContent className="pt-6 text-sm text-fg-muted space-y-2">
          <p>
            Use any of these as <code className="font-mono">Authorization: Bearer &lt;token&gt;</code>
            {" "}for service-to-service calls. They bypass corp-ui auth and identify as <span className="font-medium">system</span>.
          </p>
          <p>
            Your role <Badge variant="outline" size="sm" className="font-mono">{me?.role}</Badge> determines which tiers you can see —
            a higher-tier token always inherits lower-tier permissions, so
            for read-only scripts use a read token, not an admin one.
          </p>
        </CardContent>
      </Card>

      <ClientTokensCard />

      {tiers.map(tier => (
        <TokenSection key={tier} tier={tier} tokens={data[tier]} />
      ))}
    </div>
  );
}

// ClientTokensCard manages runtime-minted client tokens. It self-hides for
// callers without write/admin (the list endpoint 403s them). Newly created
// tokens are shown in full (the secret is stored server-side and re-displayable).
function ClientTokensCard() {
  const { me } = useAuth();
  const [tokens, setTokens] = useState<ClientToken[] | null>(null);
  const [allowed, setAllowed] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const myRole = me?.isAdmin ? "admin" : (me?.role ?? "read");
  const roleOptions = myRole === "admin" ? ["read", "write", "admin"] : myRole === "write" ? ["read", "write"] : ["read"];
  const [role, setRole] = useState("read");

  async function refresh() {
    try { setTokens(await api.listClientTokens()); setAllowed(true); }
    catch (e: any) { if (String(e.message).match(/write|forbidden|403/i)) setAllowed(false); }
  }
  useEffect(() => { refresh(); }, []);

  if (!allowed) return null;

  async function create() {
    if (!name.trim()) { toast.error("Name required"); return; }
    try {
      const tok = await api.createClientToken(name.trim(), role);
      toast.success(`Token "${tok.name}" created`);
      setName(""); setCreating(false);
      await refresh();
    } catch (e: any) { toast.error(e.message); }
  }
  async function revoke(t: ClientToken) {
    try { await api.revokeClientToken(t.id); toast.success("Token revoked"); await refresh(); }
    catch (e: any) { toast.error(e.message); }
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center gap-2 mb-3">
          <KeyRound className="size-4 text-accent" />
          <div className="font-medium">Client tokens</div>
          <div className="text-xs text-fg-muted ml-auto">Created at runtime · revocable</div>
          <Button size="sm" leftIcon={<Plus className="size-3.5" />} onClick={() => { setRole(roleOptions[roleOptions.length - 1]); setCreating(true); }}>New token</Button>
        </div>
        {tokens === null ? (
          <div className="text-sm text-fg-muted">Loading…</div>
        ) : tokens.length === 0 ? (
          <div className="text-sm text-fg-muted">No client tokens yet. Create one for a service or CI job.</div>
        ) : (
          <ul className="space-y-2">
            {tokens.map(t => (
              <li key={t.id} className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] bg-surface">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm truncate">{t.name}</span>
                    <Badge variant={t.role === "admin" ? "danger" : t.role === "write" ? "warning" : "info"} size="sm">{t.role}</Badge>
                  </div>
                  <code className="font-mono text-xs text-fg-muted break-all">{t.token}</code>
                </div>
                <div className="ml-auto flex items-center gap-1 shrink-0">
                  <CopyBtn value={t.token} />
                  <Button variant="ghost" size="icon" onClick={() => revoke(t)} title="Revoke" aria-label="Revoke"><Trash2 className="size-4" /></Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>New client token</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="ct-name">Name</Label>
              <Input id="ct-name" value={name} onChange={e => setName(e.target.value)} placeholder="ci-runner / billing-svc" autoFocus />
            </div>
            <div>
              <Label>Role</Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {roleOptions.map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-xs text-fg-subtle mt-1">You can't grant a role above your own ({myRole}).</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            <Button onClick={create}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function CopyBtn({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button variant="ghost" size="icon" title="Copy" aria-label="Copy token"
      onClick={async () => {
        try { await navigator.clipboard.writeText(value); setCopied(true); toast.success("Token copied"); setTimeout(() => setCopied(false), 1500); }
        catch { toast.error("Clipboard blocked"); }
      }}>
      {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
    </Button>
  );
}

function PageHeader() {
  return (
    <div className="flex items-center gap-3">
      <KeyRound className="size-6 text-accent" />
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Service tokens</h1>
        <div className="text-sm text-fg-muted">Static bearer tokens for service-to-service traffic.</div>
      </div>
    </div>
  );
}

function TokenSection({ tier, tokens }: { tier: Tier; tokens: string[] | undefined }) {
  // If tokens === undefined, the role doesn't include this tier — don't render the card.
  if (tokens === undefined) return null;

  const meta = TIER_META[tier];

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center gap-2 mb-3">
          <meta.icon className={`size-4 ${meta.color}`} />
          <div className="font-medium">{meta.title}</div>
          <Badge variant={meta.variant} size="sm">{tier}</Badge>
          <div className="text-xs text-fg-muted ml-auto">{meta.help}</div>
        </div>
        {tokens.length === 0 ? (
          <div className="text-sm text-fg-muted">
            None configured. Set <code className="font-mono">DISCOVERY_{tier.toUpperCase()}_TOKENS</code> in <code className="font-mono">.env</code> on the server.
          </div>
        ) : (
          <ul className="space-y-2">
            {tokens.map((t, i) => <TokenRow key={`${tier}-${i}`} token={t} />)}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

const TIER_META: Record<Tier, {
  title: string;
  help: string;
  icon: typeof Shield;
  color: string;
  variant: "info" | "warning" | "danger";
}> = {
  read:  { title: "Read",  help: "List services / discover / watch",            icon: Eye,     color: "text-info",    variant: "info"    },
  write: { title: "Write", help: "+ create/update/delete services & instances", icon: KeyRound, color: "text-warning", variant: "warning" },
  admin: { title: "Admin", help: "+ user/audit/cluster ops",                    icon: Shield,   color: "text-danger",  variant: "danger"  },
};

function TokenRow({ token }: { token: string }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  async function doCopy() {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      toast.success("Token copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Clipboard blocked — reveal and copy manually");
    }
  }

  return (
    <li className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] bg-surface">
      <code className="font-mono text-sm flex-1 min-w-0 break-all">
        {revealed ? token : maskToken(token)}
      </code>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setRevealed(v => !v)}
        title={revealed ? "Hide" : "Reveal"}
        aria-label={revealed ? "Hide token" : "Reveal token"}
      >
        {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={doCopy}
        title="Copy"
        aria-label="Copy token"
      >
        {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
      </Button>
    </li>
  );
}

// maskToken shows first 4 + last 4 chars with bullets between, so the
// rough shape is visible but the value isn't. Short tokens (< 12 chars)
// are fully bulleted to avoid leaking too much.
function maskToken(t: string): string {
  if (t.length < 12) return "•".repeat(Math.max(t.length, 4));
  return `${t.slice(0, 4)}${"•".repeat(8)}${t.slice(-4)}`;
}
