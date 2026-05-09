import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Hash, Plus, Search, Tag as TagIcon, X } from "lucide-react";
import { api, Instance, Service, watch } from "@/lib/api";
import {
  Badge, Button, Card, CardContent,
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
  Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui";
import { toast } from "sonner";

type Counts = Record<string, { up: number; total: number }>;

export default function Services() {
  const [services, setServices] = useState<Service[]>([]);
  const [counts, setCounts] = useState<Counts>({});
  const [loading, setLoading] = useState(true);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newTags, setNewTags] = useState("");
  const [newVisibility, setNewVisibility] = useState<"public" | "private">("public");

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

  async function create() {
    if (!newName.trim()) return;
    const tags = newTags.split(",").map(t => t.trim()).filter(Boolean);
    try {
      await api.putService(newName.trim(), {
        description: newDesc.trim() || undefined,
        tags: tags.length ? tags : undefined,
        visibility: newVisibility,
      });
      toast.success(`Service "${newName.trim()}" created`);
      setNewName(""); setNewDesc(""); setNewTags(""); setNewVisibility("public"); setCreating(false);
      refresh();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

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

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New service</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="svc-name">Name</Label>
              <Input id="svc-name" value={newName}
                onChange={e => setNewName(e.target.value)} placeholder="e.g. billing" autoFocus />
            </div>
            <div>
              <Label htmlFor="svc-desc">Description</Label>
              <Input id="svc-desc" value={newDesc}
                onChange={e => setNewDesc(e.target.value)} placeholder="optional" />
            </div>
            <div>
              <Label htmlFor="svc-tags">Tags</Label>
              <Input id="svc-tags" value={newTags}
                onChange={e => setNewTags(e.target.value)} placeholder="comma-separated, e.g. backend, prod" />
              <p className="text-xs text-fg-subtle mt-1">Used to filter services in the list.</p>
            </div>
            <div>
              <Label>Visibility</Label>
              <Select value={newVisibility} onValueChange={v => setNewVisibility(v as "public" | "private")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="public">public — anyone can edit</SelectItem>
                  <SelectItem value="private">private — only owner / admin / granted</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            <Button onClick={create}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
