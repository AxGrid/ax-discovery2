import { useEffect, useState } from "react";
import { Check, Copy, Eye, EyeOff, KeyRound, Shield } from "lucide-react";
import { toast } from "sonner";
import { api, type TokensResponse } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Badge, Button, Card, CardContent } from "@/components/ui";

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

      {tiers.map(tier => (
        <TokenSection key={tier} tier={tier} tokens={data[tier]} />
      ))}
    </div>
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
