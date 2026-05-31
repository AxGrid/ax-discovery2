import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Database, FileText, Globe, Hash, Plug, Plus, Search, Server, Tag as TagIcon, X,
  type LucideIcon,
} from "lucide-react";
import { api, Instance, Service, TypedValue, watch } from "@/lib/api";
import {
  Badge, Button, Card, CardContent,
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
  Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch,
} from "@/components/ui";
import { toast } from "sonner";

type Counts = Record<string, { up: number; total: number }>;

export default function Services() {
  const [services, setServices] = useState<Service[]>([]);
  const [counts, setCounts] = useState<Counts>({});
  const [loading, setLoading] = useState(true);

  const [creating, setCreating] = useState(false);

  const [search, setSearch] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTag = searchParams.get("tag") ?? "";

  function setActiveTag(t: string) {
    if (!t) { searchParams.delete("tag"); setSearchParams(searchParams, { replace: true }); }
    else { searchParams.set("tag", t); setSearchParams(searchParams, { replace: true }); }
  }

  async function refresh() {
    try {
      const svcs = await api.listServices();
      setServices(svcs);
      const c: Counts = {};
      await Promise.all(svcs.map(async s => {
        try {
          const insts: Instance[] = await api.listInstances(s.name);
          c[s.name] = { total: insts.length, up: insts.filter(i => i.status === "up").length };
        } catch {
          c[s.name] = { total: 0, up: 0 };
        }
      }));
      setCounts(c);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const stop = watch(() => refresh());
    return stop;
  }, []);

  const allTags = useMemo(() => {
    const m = new Map<string, number>();
    services.forEach(s => (s.tags ?? []).forEach(t => m.set(t, (m.get(t) ?? 0) + 1)));
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [services]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return services.filter(s => {
      if (activeTag && !(s.tags ?? []).includes(activeTag)) return false;
      if (!q) return true;
      if (s.name.toLowerCase().includes(q)) return true;
      if ((s.description ?? "").toLowerCase().includes(q)) return true;
      if ((s.tags ?? []).some(t => t.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [services, search, activeTag]);

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Services</h1>
          <p className="text-sm text-fg-muted mt-1">
            {services.length} registered{activeTag ? ` · filtered by tag “${activeTag}”` : ""}
          </p>
        </div>
        <Button leftIcon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
          New service
        </Button>
      </div>

      {/* search + tag filter */}
      <div className="mb-5 space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-fg-subtle pointer-events-none" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search services, tags, descriptions"
            className="pl-9"
          />
        </div>
        {allTags.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1.5 text-xs text-fg-subtle pr-1">
              <TagIcon className="size-3.5" /> Tags
            </span>
            {allTags.map(([t, n]) => (
              <button
                key={t}
                onClick={() => setActiveTag(activeTag === t ? "" : t)}
                className={[
                  "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs font-medium",
                  "border transition-colors",
                  activeTag === t
                    ? "bg-accent text-accent-fg border-transparent"
                    : "bg-surface border-border text-fg-muted hover:text-fg hover:border-border-strong",
                ].join(" ")}
              >
                <Hash className="size-3" />
                <span>{t}</span>
                <span className={activeTag === t ? "opacity-80" : "text-fg-subtle"}>{n}</span>
              </button>
            ))}
            {activeTag && (
              <Button variant="ghost" size="sm" onClick={() => setActiveTag("")} leftIcon={<X className="size-3.5" />}>
                Clear
              </Button>
            )}
          </div>
        )}
      </div>

      <NewServiceDialog open={creating} onOpenChange={setCreating} onCreated={refresh} />

      {loading ? (
        <div className="text-fg-muted">Loading…</div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="text-center text-fg-muted py-12">
            {services.length === 0 ? (
              <>No services yet. Click <strong>New service</strong> to add one,
                or register one via the API / client library.</>
            ) : (
              <>No services match the current filter.</>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(s => (
            <ServiceCard
              key={s.name}
              service={s}
              counts={counts[s.name]}
              activeTag={activeTag}
              onTagClick={t => setActiveTag(activeTag === t ? "" : t)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ServiceCard({
  service, counts, activeTag, onTagClick,
}: {
  service: Service;
  counts?: { up: number; total: number };
  activeTag: string;
  onTagClick: (t: string) => void;
}) {
  const dotColor =
    !counts || counts.total === 0
      ? "bg-fg-subtle"
      : counts.up === counts.total
        ? "bg-success"
        : counts.up === 0
          ? "bg-danger"
          : "bg-warning";

  return (
    <Link
      to={`/services/${encodeURIComponent(service.name)}`}
      className={[
        "group relative block rounded-[var(--radius-lg)] border border-border bg-surface",
        "p-4 transition-all overflow-hidden",
        "hover:border-accent/50 hover:bg-bg-elevated hover:-translate-y-0.5 hover:shadow-md",
        "focus-visible:outline-none focus-visible:[box-shadow:0_0_0_2px_var(--bg),0_0_0_4px_var(--ring)]",
      ].join(" ")}
    >
      {/* Accent stripe along the left edge based on status */}
      <span className={[
        "absolute inset-y-0 left-0 w-1",
        !counts || counts.total === 0
          ? "bg-border"
          : counts.up === counts.total
            ? "bg-success"
            : counts.up === 0
              ? "bg-danger"
              : "bg-warning",
      ].join(" ")} aria-hidden />

      <div className="flex items-start justify-between gap-3 pl-1">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`size-2 rounded-full shrink-0 ${dotColor}`} aria-hidden />
            <h3 className="font-semibold tracking-tight truncate">{service.name}</h3>
          </div>
          {service.description && (
            <p className="text-sm text-fg-muted line-clamp-2 mt-1">{service.description}</p>
          )}
        </div>
        <VisibilityBadge v={service.visibility} />
      </div>

      <div className="mt-4 flex items-end justify-between gap-3 pl-1">
        <CountSummary c={counts} />
        {service.tags && service.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 justify-end max-w-[60%]">
            {service.tags.slice(0, 4).map(t => (
              <span
                key={t}
                onClick={e => { e.preventDefault(); e.stopPropagation(); onTagClick(t); }}
                className={[
                  "inline-flex items-center gap-0.5 h-5 px-1.5 rounded-full text-[10px] font-medium",
                  "border transition-colors cursor-pointer",
                  activeTag === t
                    ? "bg-accent text-accent-fg border-transparent"
                    : "bg-bg-elevated border-border text-fg-muted hover:text-fg",
                ].join(" ")}
              >
                <Hash className="size-2.5" />
                {t}
              </span>
            ))}
            {service.tags.length > 4 && (
              <span className="inline-flex items-center h-5 px-1.5 rounded-full text-[10px] text-fg-subtle">
                +{service.tags.length - 4}
              </span>
            )}
          </div>
        )}
      </div>
    </Link>
  );
}

export function VisibilityBadge({ v }: { v?: string }) {
  if (v === "private") return <Badge variant="warning" size="sm">private</Badge>;
  return <Badge variant="neutral" size="sm">public</Badge>;
}

function CountSummary({ c }: { c?: { up: number; total: number } }) {
  if (!c || c.total === 0) {
    return <span className="text-xs text-fg-subtle">no instances</span>;
  }
  const allUp = c.up === c.total;
  const allDown = c.up === 0;
  const cls = allUp ? "text-success" : allDown ? "text-danger" : "text-warning";
  return (
    <div className="text-xs leading-tight">
      <div className={`font-semibold tabular-nums ${cls}`}>
        {c.up}<span className="text-fg-subtle">/</span>{c.total}
      </div>
      <div className="text-fg-subtle uppercase tracking-wide">instances up</div>
    </div>
  );
}

// --- New service dialog with presets ---

type Preset = {
  id: string;
  label: string;
  icon: LucideIcon;
  port: number;
  iface: string;
  proto: string;
  tags: string[];
  desc: string;
  creds: "userpass" | "password" | "none";
  endpoint: boolean;
};

const PRESETS: Preset[] = [
  { id: "blank", label: "Blank", icon: FileText, port: 0, iface: "", proto: "", tags: [], desc: "", creds: "none", endpoint: false },
  { id: "mysql", label: "MySQL", icon: Database, port: 3306, iface: "DB", proto: "tcp", tags: ["database", "mysql"], desc: "MySQL database", creds: "userpass", endpoint: true },
  { id: "postgres", label: "PostgreSQL", icon: Database, port: 5432, iface: "DB", proto: "tcp", tags: ["database", "postgres"], desc: "PostgreSQL database", creds: "userpass", endpoint: true },
  { id: "redis", label: "Redis", icon: Database, port: 6379, iface: "CACHE", proto: "tcp", tags: ["cache", "redis"], desc: "Redis cache", creds: "password", endpoint: true },
  { id: "mongodb", label: "MongoDB", icon: Database, port: 27017, iface: "DB", proto: "tcp", tags: ["database", "mongodb"], desc: "MongoDB database", creds: "userpass", endpoint: true },
  { id: "rabbitmq", label: "RabbitMQ", icon: Server, port: 5672, iface: "AMQP", proto: "tcp", tags: ["queue", "rabbitmq"], desc: "RabbitMQ broker", creds: "userpass", endpoint: true },
  { id: "http", label: "HTTP service", icon: Globe, port: 8080, iface: "WEB", proto: "http", tags: ["http"], desc: "", creds: "none", endpoint: true },
];

function NewServiceDialog({ open, onOpenChange, onCreated }: {
  open: boolean; onOpenChange: (b: boolean) => void; onCreated: () => void;
}) {
  const [presetId, setPresetId] = useState("blank");
  const preset = PRESETS.find(p => p.id === presetId) ?? PRESETS[0];
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [tags, setTags] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [tunnel, setTunnel] = useState(false);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);

  function pick(p: Preset) {
    setPresetId(p.id);
    setName(p.id === "blank" ? "" : p.id);
    setDesc(p.desc);
    setTags(p.tags.join(", "));
    setPort(p.port ? String(p.port) : "");
    setHost(""); setUser(""); setPassword(""); setTunnel(false);
  }
  function reset() {
    setPresetId("blank"); setName(""); setDesc(""); setTags(""); setVisibility("public");
    setHost(""); setPort(""); setTunnel(false); setUser(""); setPassword("");
  }

  async function create() {
    const nm = name.trim();
    if (!nm) { toast.error("Name required"); return; }
    setSaving(true);
    try {
      const tagList = tags.split(",").map(t => t.trim()).filter(Boolean);
      await api.putService(nm, {
        description: desc.trim() || undefined,
        tags: tagList.length ? tagList : undefined,
        visibility,
      });
      // Optional endpoint → register an instance for the host:port.
      if (preset.endpoint && host.trim()) {
        await api.putInstance(nm, crypto.randomUUID(), {
          address: host.trim(),
          interfaces: [{ name: preset.iface || "WEB", protocol: preset.proto || "tcp", port: Number(port) || preset.port }],
          weight: 1,
          status: "up",
          ttlSeconds: 0, // external endpoint — never TTL-expire
          checkMode: tunnel ? "none" : "tcp", // can't probe a tunnelled local port
          metadata: tunnel ? { tunnel: "true" } : undefined,
        });
      }
      // Optional credentials → service config (Config tab).
      if (preset.creds !== "none") {
        const vars: Record<string, TypedValue> = {};
        if (preset.creds === "userpass" && user.trim()) vars["user"] = { type: "string", value: user.trim() };
        if (password) vars["password"] = { type: "string", value: password };
        if (Object.keys(vars).length) {
          await api.configApply({ kind: "service", service: nm }, vars, "preset credentials");
        }
      }
      toast.success(`Service "${nm}" created`);
      onCreated();
      onOpenChange(false);
      reset();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={o => { onOpenChange(o); if (!o) reset(); }}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>New service</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Preset</Label>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {PRESETS.map(p => {
                const Icon = p.icon;
                const sel = p.id === presetId;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => pick(p)}
                    className={[
                      "inline-flex items-center gap-1.5 h-8 px-2.5 rounded-[var(--radius-md)] text-xs font-medium border transition-colors",
                      sel ? "bg-accent text-accent-fg border-transparent"
                        : "bg-surface border-border text-fg-muted hover:text-fg hover:border-border-strong",
                    ].join(" ")}
                  >
                    <Icon className="size-3.5" />{p.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <Label htmlFor="svc-name">Name</Label>
            <Input id="svc-name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. billing" autoFocus />
          </div>
          <div>
            <Label htmlFor="svc-desc">Description</Label>
            <Input id="svc-desc" value={desc} onChange={e => setDesc(e.target.value)} placeholder="optional" />
          </div>
          <div>
            <Label htmlFor="svc-tags">Tags</Label>
            <Input id="svc-tags" value={tags} onChange={e => setTags(e.target.value)} placeholder="comma-separated" />
          </div>

          {preset.endpoint && (
            <div className="rounded-[var(--radius-md)] border border-border p-3 space-y-3">
              <div className="text-xs font-medium text-fg-muted flex items-center gap-1.5">
                <Plug className="size-3.5" /> Endpoint — registers an instance
              </div>
              <div className="grid grid-cols-[1fr_96px] gap-2">
                <div>
                  <Label htmlFor="svc-host">Host</Label>
                  <Input id="svc-host" value={host} onChange={e => setHost(e.target.value)} placeholder="10.0.0.5 / db.internal" />
                </div>
                <div>
                  <Label htmlFor="svc-port">Port</Label>
                  <Input id="svc-port" type="number" value={port} onChange={e => setPort(e.target.value)} />
                </div>
              </div>
              <label className="flex items-center justify-between gap-2 cursor-pointer">
                <span className="text-sm">Reachable only via tunnel (local port)</span>
                <Switch checked={tunnel} onCheckedChange={setTunnel} />
              </label>
              <p className="text-xs text-fg-subtle">
                Leave host empty to create the service without an instance. With tunnel on, discovery won't TCP-probe the port.
              </p>
            </div>
          )}

          {preset.creds !== "none" && (
            <div className="rounded-[var(--radius-md)] border border-border p-3 space-y-2">
              <div className="text-xs font-medium text-fg-muted">Credentials — stored as service config</div>
              {preset.creds === "userpass" && (
                <div>
                  <Label htmlFor="svc-user">User</Label>
                  <Input id="svc-user" value={user} onChange={e => setUser(e.target.value)} placeholder="optional" autoComplete="off" />
                </div>
              )}
              <div>
                <Label htmlFor="svc-pass">Password</Label>
                <Input id="svc-pass" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="optional" autoComplete="new-password" />
              </div>
              <p className="text-xs text-fg-subtle">
                Saved to the service's config as <code>user</code> / <code>password</code> (editable later in the Config tab).
              </p>
            </div>
          )}

          <div>
            <Label>Visibility</Label>
            <Select value={visibility} onValueChange={v => setVisibility(v as "public" | "private")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="public">public — anyone can edit</SelectItem>
                <SelectItem value="private">private — only owner / admin / granted</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={create} loading={saving}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
