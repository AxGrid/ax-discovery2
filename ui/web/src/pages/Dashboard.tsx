import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Activity, Boxes, Network, Radio, Server, Ban } from "lucide-react";
import {
  api, watch,
  type Instance, type Service, type StatsSnapshot, type ServiceStat, type StatsLookup,
} from "@/lib/api";
import { Badge, Card, CardContent } from "@/components/ui";

// Dashboard — a live, at-a-glance view of the cluster: one card per service
// with its version breakdown, health, and request rate; plus a live feed of
// discovery lookups and a "who's calling what" client map. Health/instance
// data comes from the replicated store; rps/feed/clients come from this node's
// in-memory stats collector (/v1/stats), polled on a short interval.

const POLL_MS = 2000;

interface VerAgg { version: string; up: number; total: number; blocked: number; down: number; }
interface SvcAgg {
  name: string;
  service?: Service;
  up: number; total: number; blocked: number;
  versions: VerAgg[];
  stat?: ServiceStat;
}

export default function Dashboard() {
  const [services, setServices] = useState<Service[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [stats, setStats] = useState<StatsSnapshot | null>(null);
  const [nodes, setNodes] = useState(1);
  const [loading, setLoading] = useState(true);
  const timer = useRef<number | null>(null);

  async function pollFast() {
    try {
      const [insts, st] = await Promise.all([api.listAllInstances(), api.stats()]);
      setInstances(insts);
      setStats(st);
    } catch { /* transient; keep last view */ }
  }

  async function pollSlow() {
    try {
      const [svcs, members] = await Promise.all([api.listServices(), api.members().catch(() => [])]);
      setServices(svcs);
      setNodes(Math.max(1, members.length));
    } catch { /* ignore */ } finally { setLoading(false); }
  }

  useEffect(() => {
    pollSlow();
    pollFast();
    timer.current = window.setInterval(pollFast, POLL_MS);
    const stop = watch(() => { pollFast(); pollSlow(); });
    return () => { if (timer.current) window.clearInterval(timer.current); stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const aggs = useMemo(() => aggregate(services, instances, stats), [services, instances, stats]);

  const totals = useMemo(() => {
    const up = instances.filter(i => i.status === "up" && !i.blocked).length;
    const rps = (stats?.services ?? []).reduce((a, s) => a + s.rps, 0);
    return { services: aggs.length, up, rps };
  }, [instances, stats, aggs]);

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-fg-muted mt-1">Live service health & discovery traffic</p>
        </div>
        <span className="inline-flex items-center gap-1.5 text-xs text-fg-subtle">
          <span className="size-1.5 rounded-full bg-success animate-pulse" /> live
        </span>
      </div>

      {/* compact totals strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <Kpi icon={<Boxes className="size-4" />} label="Services" value={totals.services} />
        <Kpi icon={<Server className="size-4" />} label="Instances up" value={totals.up} />
        <Kpi icon={<Network className="size-4" />} label="Cluster nodes" value={nodes} />
        <Kpi icon={<Activity className="size-4" />} label="Requests/s" value={totals.rps.toFixed(1)} />
      </div>

      <div className="mb-6">
        {loading && aggs.length === 0 ? (
          <div className="text-fg-muted">Loading…</div>
        ) : aggs.length === 0 ? (
          <Card><CardContent className="text-center text-fg-muted py-12">No services registered yet.</CardContent></Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {aggs.map(a => <SvcCard key={a.name} agg={a} />)}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <LiveFeed feed={stats?.feed ?? []} />
        <Clients snap={stats} />
      </div>
    </div>
  );
}

function aggregate(services: Service[], instances: Instance[], stats: StatsSnapshot | null): SvcAgg[] {
  const svcByName = new Map(services.map(s => [s.name, s]));
  const statByName = new Map((stats?.services ?? []).map(s => [s.service, s]));
  const byName = new Map<string, SvcAgg>();

  const ensure = (name: string): SvcAgg => {
    let a = byName.get(name);
    if (!a) {
      a = { name, service: svcByName.get(name), up: 0, total: 0, blocked: 0, versions: [], stat: statByName.get(name) };
      byName.set(name, a);
    }
    return a;
  };
  // seed from the service catalog so zero-instance services still appear
  services.forEach(s => ensure(s.name));

  const verMap = new Map<string, Map<string, VerAgg>>();
  for (const i of instances) {
    const a = ensure(i.service);
    a.total++;
    const isUp = i.status === "up" && !i.blocked;
    if (isUp) a.up++;
    if (i.blocked) a.blocked++;
    const vm = verMap.get(i.service) ?? new Map<string, VerAgg>();
    verMap.set(i.service, vm);
    const key = i.version || "—";
    const v = vm.get(key) ?? { version: key, up: 0, total: 0, blocked: 0, down: 0 };
    v.total++;
    if (isUp) v.up++;
    else if (i.blocked) v.blocked++;
    else v.down++;
    vm.set(key, v);
  }
  for (const [name, vm] of verMap) {
    ensure(name).versions = [...vm.values()].sort((x, y) => cmpVersionDesc(x.version, y.version));
  }

  return [...byName.values()].sort((a, b) => {
    const ra = a.stat?.rps ?? 0, rb = b.stat?.rps ?? 0;
    if (ra !== rb) return rb - ra;
    return a.name.localeCompare(b.name);
  });
}

// cmpVersionDesc sorts version strings highest-first, numerically when possible.
function cmpVersionDesc(a: string, b: string): number {
  const pa = a.split(".").map(n => parseInt(n, 10));
  const pb = b.split(".").map(n => parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return a < b ? 1 : a > b ? -1 : 0;
    if (x !== y) return y - x;
  }
  return 0;
}

function healthTone(up: number, total: number): "success" | "danger" | "warning" | "subtle" {
  if (total === 0) return "subtle";
  if (up === total) return "success";
  if (up === 0) return "danger";
  return "warning";
}

function SvcCard({ agg }: { agg: SvcAgg }) {
  const tone = healthTone(agg.up, agg.total);
  const stripe = { success: "bg-success", danger: "bg-danger", warning: "bg-warning", subtle: "bg-border" }[tone];
  const dot = { success: "bg-success", danger: "bg-danger", warning: "bg-warning", subtle: "bg-fg-subtle" }[tone];
  const rps = agg.stat?.rps ?? 0;

  return (
    <Link
      to={`/services/${encodeURIComponent(agg.name)}`}
      className={[
        "group relative block rounded-[var(--radius-lg)] border border-border bg-surface p-4",
        "transition-all overflow-hidden hover:border-accent/50 hover:bg-bg-elevated hover:-translate-y-0.5 hover:shadow-md",
        "focus-visible:outline-none focus-visible:[box-shadow:0_0_0_2px_var(--bg),0_0_0_4px_var(--ring)]",
      ].join(" ")}
    >
      <span className={`absolute inset-y-0 left-0 w-1 ${stripe}`} aria-hidden />
      <div className="flex items-start justify-between gap-3 pl-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`size-2 rounded-full shrink-0 ${dot}`} aria-hidden />
          <h3 className="font-semibold tracking-tight truncate">{agg.name}</h3>
        </div>
        <div className="text-right shrink-0">
          <div className="text-sm font-semibold tabular-nums text-fg">{rps.toFixed(1)}<span className="text-fg-subtle text-xs"> rps</span></div>
        </div>
      </div>

      {/* version breakdown */}
      <div className="mt-3 pl-1 space-y-1.5">
        {agg.versions.length === 0 ? (
          <div className="text-xs text-fg-subtle">no instances</div>
        ) : (
          agg.versions.slice(0, 5).map(v => <VersionRow key={v.version} v={v} max={Math.max(...agg.versions.map(x => x.total))} />)
        )}
        {agg.versions.length > 5 && (
          <div className="text-[10px] text-fg-subtle">+{agg.versions.length - 5} more versions</div>
        )}
      </div>

      <div className="mt-3 pl-1 flex items-center justify-between gap-2">
        <Sparkline data={agg.stat?.sparkline ?? []} tone={tone} />
        <div className="flex items-center gap-2 text-[11px] text-fg-subtle shrink-0">
          <span className="tabular-nums"><span className={tone === "danger" ? "text-danger font-semibold" : "text-fg font-semibold"}>{agg.up}</span>/{agg.total} up</span>
          {agg.blocked > 0 && (
            <span className="inline-flex items-center gap-0.5 text-warning"><Ban className="size-3" />{agg.blocked}</span>
          )}
        </div>
      </div>
    </Link>
  );
}

function VersionRow({ v, max }: { v: VerAgg; max: number }) {
  const pct = max > 0 ? Math.round((v.total / max) * 100) : 0;
  const tone = healthTone(v.up, v.total);
  const bar = { success: "bg-success", danger: "bg-danger", warning: "bg-warning", subtle: "bg-border" }[tone];
  return (
    <div className="flex items-center gap-2">
      <code className="text-[11px] font-mono text-fg-muted w-16 shrink-0 truncate" title={v.version}>{v.version}</code>
      <div className="flex-1 h-2 rounded-full bg-bg-elevated overflow-hidden">
        <div className={`h-full ${bar} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] tabular-nums text-fg-muted w-10 text-right shrink-0">
        {v.up}<span className="text-fg-subtle">/{v.total}</span>
      </span>
    </div>
  );
}

// Sparkline draws a tiny filled area chart of the recent per-second request
// counts. All-zero input renders a flat baseline.
function Sparkline({ data, tone }: { data: number[]; tone: "success" | "danger" | "warning" | "subtle" }) {
  const w = 120, h = 26;
  const stroke = { success: "var(--success)", danger: "var(--danger)", warning: "var(--warning)", subtle: "var(--fg-subtle)" }[tone]
    ?? "var(--brand-500)";
  if (data.length === 0) return <div className="h-[26px] flex-1" />;
  const max = Math.max(1, ...data);
  const n = data.length;
  const pts = data.map((v, i) => {
    const x = (i / (n - 1)) * w;
    const y = h - (v / max) * (h - 3) - 1.5;
    return [x, y] as const;
  });
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${w},${h} L0,${h} Z`;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="flex-1" preserveAspectRatio="none" aria-hidden>
      <path d={area} fill={stroke} opacity={0.12} />
      <path d={line} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

const KIND_VARIANT: Record<string, "info" | "brand" | "neutral"> = {
  discover: "info", pick: "brand", tag: "neutral",
};

function LiveFeed({ feed }: { feed: StatsLookup[] }) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Radio className="size-4 text-accent" />
          <h2 className="text-sm font-semibold">Live requests</h2>
          <span className="text-xs text-fg-subtle ml-auto">{feed.length} recent</span>
        </div>
        {feed.length === 0 ? (
          <div className="text-center text-fg-subtle text-sm py-10">No requests yet.</div>
        ) : (
          <div className="max-h-[26rem] overflow-y-auto divide-y divide-border">
            {feed.slice(0, 60).map((l, i) => <FeedRow key={i} l={l} />)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FeedRow({ l }: { l: StatsLookup }) {
  const t = new Date(l.time);
  const time = t.toLocaleTimeString(undefined, { hour12: false });
  return (
    <div className="flex items-center gap-2 px-4 py-1.5 text-xs hover:bg-surface-hover">
      <span className="font-mono text-fg-subtle tabular-nums shrink-0">{time}</span>
      <Badge variant={KIND_VARIANT[l.kind] ?? "neutral"} size="sm">{l.kind}</Badge>
      <span className="font-medium truncate">{l.service}</span>
      {l.version && <code className="text-[10px] font-mono text-accent shrink-0">{l.version}</code>}
      <span className="ml-auto flex items-center gap-2 shrink-0 text-fg-muted">
        {l.instance ? <span className="font-mono">→ {l.address || l.instance}</span> : <span className="tabular-nums">{l.count} hit{l.count === 1 ? "" : "s"}</span>}
        {l.client && <span className="text-fg-subtle truncate max-w-[8rem]" title={l.client}>{l.client}</span>}
      </span>
    </div>
  );
}

function Clients({ snap }: { snap: StatsSnapshot | null }) {
  const clients = snap?.clients ?? [];
  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Server className="size-4 text-accent" />
          <h2 className="text-sm font-semibold">Clients</h2>
          <span className="text-xs text-fg-subtle ml-auto">{clients.length}</span>
        </div>
        {clients.length === 0 ? (
          <div className="text-center text-fg-subtle text-sm py-10">No identified clients yet.</div>
        ) : (
          <div className="max-h-[26rem] overflow-y-auto divide-y divide-border">
            {clients.map(c => (
              <div key={c.name} className="px-4 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-sm truncate">{c.name}</span>
                  <span className="text-xs text-fg-subtle tabular-nums shrink-0">{c.total} req</span>
                </div>
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {c.services.slice(0, 6).map(s => (
                    <span key={s.service} className="inline-flex items-center gap-1 h-5 px-1.5 rounded-full text-[10px] bg-bg-elevated border border-border text-fg-muted">
                      <span className="font-medium text-fg">{s.service}</span>
                      <span className="text-fg-subtle tabular-nums">{s.count}</span>
                      {s.lastInstance && <span className="text-accent font-mono">→{s.lastInstance.slice(0, 8)}</span>}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Kpi({ icon, label, value }: { icon: React.ReactNode; label: string; value: number | string }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-border bg-surface px-4 py-3">
      <div className="flex items-center gap-1.5 text-fg-subtle text-xs">{icon}<span>{label}</span></div>
      <div className="text-2xl font-semibold tabular-nums mt-1">{value}</div>
    </div>
  );
}
