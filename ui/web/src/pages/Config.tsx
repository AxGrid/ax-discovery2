import { useEffect, useMemo, useState } from "react";
import { Plus, Globe, Boxes, GitBranch, FileEdit } from "lucide-react";
import { toast } from "sonner";
import {
  api, scopeId, watch,
  type ConfigScope, type ConfigScopeSummary, type ResolvedConfig, type Service,
} from "@/lib/api";
import { tvToStr } from "@/lib/configvars";
import { ConfigScopeEditor } from "@/components/ConfigScopeEditor";
import {
  Button, Card, CardContent,
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
  Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui";

export default function Config() {
  const [scopes, setScopes] = useState<ConfigScopeSummary[]>([]);
  const [selected, setSelected] = useState<ConfigScope>({ kind: "global" });
  const [creating, setCreating] = useState(false);
  const [resolveOpen, setResolveOpen] = useState(false);

  async function refreshScopes() {
    try { setScopes(await api.configScopes()); } catch (e: any) { toast.error(e.message); }
  }

  useEffect(() => { refreshScopes(); }, []);
  useEffect(() => {
    const stop = watch(ev => { if (ev.type.startsWith("config.")) refreshScopes(); });
    return stop;
  }, []);

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Config</h1>
          <p className="text-sm text-fg-muted mt-1">Variables & settings — global, per-service, and per-version blocks</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" leftIcon={<FileEdit className="size-4" />} onClick={() => setResolveOpen(true)}>Effective</Button>
          <Button leftIcon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New scope</Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4">
        <ScopeList scopes={scopes} selected={selected} onSelect={setSelected} />
        <ConfigScopeEditor
          key={scopeId(selected)}
          scope={selected}
          showDelete={selected.kind !== "global"}
          onScopesChanged={refreshScopes}
          onDeleted={() => setSelected({ kind: "global" })}
        />
      </div>

      <NewScopeDialog open={creating} onOpenChange={setCreating} onCreate={s => { setSelected(s); setCreating(false); }} />
      <ResolveDialog open={resolveOpen} onOpenChange={setResolveOpen} />
    </div>
  );
}

function ScopeList({ scopes, selected, onSelect }: { scopes: ConfigScopeSummary[]; selected: ConfigScope; onSelect: (s: ConfigScope) => void }) {
  // Always show Global; group the rest by service.
  const services = useMemo(() => {
    const m = new Map<string, ConfigScopeSummary[]>();
    for (const s of scopes) {
      if (s.scope.kind === "global") continue;
      const svc = s.scope.service ?? "";
      if (!m.has(svc)) m.set(svc, []);
      m.get(svc)!.push(s);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [scopes]);

  const isSel = (s: ConfigScope) => scopeId(s) === scopeId(selected);
  const itemCls = (sel: boolean) => [
    "w-full text-left rounded-[var(--radius-md)] px-2.5 py-1.5 text-sm transition-colors flex items-center gap-2",
    sel ? "bg-[color-mix(in_oklab,var(--brand-500)_12%,transparent)] text-accent" : "text-fg-muted hover:text-fg hover:bg-surface-hover",
  ].join(" ");

  return (
    <Card>
      <CardContent className="p-2">
        <button className={itemCls(isSel({ kind: "global" }))} onClick={() => onSelect({ kind: "global" })}>
          <Globe className="size-4 shrink-0" /> <span className="font-medium">Global</span>
        </button>
        {services.map(([svc, list]) => {
          const svcScope = list.find(l => l.scope.kind === "service");
          const versions = list.filter(l => l.scope.kind === "version");
          return (
            <div key={svc} className="mt-2">
              <button className={itemCls(isSel({ kind: "service", service: svc }))} onClick={() => onSelect({ kind: "service", service: svc })}>
                <Boxes className="size-4 shrink-0" />
                <span className="font-medium truncate">{svc}</span>
                {svcScope && <span className="ml-auto text-[10px] text-fg-subtle">{svcScope.varCount}</span>}
              </button>
              {versions.map(v => (
                <button key={v.scope.constraint} className={`${itemCls(isSel(v.scope))} pl-7`} onClick={() => onSelect(v.scope)}>
                  <GitBranch className="size-3.5 shrink-0" />
                  <code className="font-mono text-xs truncate">{v.scope.constraint}</code>
                  {v.hasDraft && <span className="ml-auto size-1.5 rounded-full bg-warning" />}
                </button>
              ))}
            </div>
          );
        })}
        {scopes.length === 0 && <div className="text-xs text-fg-subtle px-2 py-2">Only Global so far.</div>}
      </CardContent>
    </Card>
  );
}

function NewScopeDialog({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange: (b: boolean) => void; onCreate: (s: ConfigScope) => void }) {
  const [kind, setKind] = useState<"global" | "service" | "version">("service");
  const [service, setService] = useState("");
  const [constraint, setConstraint] = useState("");
  const [services, setServices] = useState<Service[]>([]);

  // Load the service list so the operator can pick instead of typing — but the
  // input stays free-text so a not-yet-registered service can be pre-provisioned.
  useEffect(() => {
    if (!open) return;
    api.listServices().then(setServices).catch(() => { /* picker is best-effort */ });
  }, [open]);

  function create() {
    if (kind === "global") { onCreate({ kind: "global" }); return; }
    if (!service.trim()) { toast.error("Service name required"); return; }
    if (kind === "version" && !constraint.trim()) { toast.error("Version constraint required"); return; }
    onCreate({ kind, service: service.trim(), constraint: kind === "version" ? constraint.trim() : undefined });
    setService(""); setConstraint("");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>New config scope</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Kind</Label>
            <Select value={kind} onValueChange={v => setKind(v as any)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="global">Global — applies to everything</SelectItem>
                <SelectItem value="service">Service — one service's config</SelectItem>
                <SelectItem value="version">Version — a service's version range</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {kind !== "global" && (
            <div>
              <Label htmlFor="ns-svc">Service</Label>
              <Input id="ns-svc" list="ns-svc-list" value={service} onChange={e => setService(e.target.value)}
                placeholder="pick or type a name" leftIcon={<Boxes className="size-4" />} />
              <datalist id="ns-svc-list">
                {services.map(s => <option key={s.name} value={s.name} />)}
              </datalist>
              {services.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {services.slice(0, 8).map(s => (
                    <button key={s.name} type="button" onClick={() => setService(s.name)}
                      className={[
                        "px-2 py-0.5 rounded-full text-xs border transition-colors",
                        service === s.name ? "border-accent text-accent bg-[color-mix(in_oklab,var(--brand-500)_10%,transparent)]" : "border-border text-fg-muted hover:text-fg hover:border-border-strong",
                      ].join(" ")}>
                      {s.name}
                    </button>
                  ))}
                </div>
              )}
              <p className="text-xs text-fg-subtle mt-1">Can be a service that hasn't registered yet.</p>
            </div>
          )}
          {kind === "version" && (
            <div>
              <Label htmlFor="ns-con">Version constraint</Label>
              <Input id="ns-con" value={constraint} onChange={e => setConstraint(e.target.value)} placeholder=">=2.1.0" className="font-mono" />
              <p className="text-xs text-fg-subtle mt-1">npm-style: <code>{">=2.1.0"}</code>, <code>^2.1</code>, <code>1.x</code>.</p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={create}>Open editor</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResolveDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (b: boolean) => void }) {
  const [service, setService] = useState("");
  const [version, setVersion] = useState("");
  const [result, setResult] = useState<ResolvedConfig | null>(null);

  async function run() {
    try { setResult(await api.configResolve(service.trim(), version.trim() || undefined)); }
    catch (e: any) { toast.error(e.message); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Effective config</DialogTitle></DialogHeader>
        <div className="flex items-end gap-2">
          <div className="flex-1"><Label htmlFor="rs-svc">Service</Label><Input id="rs-svc" value={service} onChange={e => setService(e.target.value)} placeholder="billing" /></div>
          <div className="flex-1"><Label htmlFor="rs-ver">Version</Label><Input id="rs-ver" value={version} onChange={e => setVersion(e.target.value)} placeholder="2.1.0" className="font-mono" /></div>
          <Button onClick={run}>Resolve</Button>
        </div>
        {result && (
          <div className="mt-3 max-h-[50vh] overflow-y-auto rounded-[var(--radius-md)] border border-border">
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-wide text-fg-subtle bg-surface">
                <tr><th className="text-left px-3 py-1.5">Key</th><th className="text-left px-3 py-1.5">Value</th><th className="text-left px-3 py-1.5">From</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {Object.entries(result.vars).sort(([a], [b]) => a.localeCompare(b)).map(([k, tv]) => (
                  <tr key={k}>
                    <td className="px-3 py-1.5 font-mono">{k}</td>
                    <td className="px-3 py-1.5 font-mono text-fg-muted truncate max-w-[16rem]">{tvToStr(tv)} <span className="text-fg-subtle">({tv.type})</span></td>
                    <td className="px-3 py-1.5 text-xs text-fg-subtle">{result.provenance?.[k]}</td>
                  </tr>
                ))}
                {Object.keys(result.vars).length === 0 && <tr><td colSpan={3} className="px-3 py-4 text-fg-subtle">No effective config.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
