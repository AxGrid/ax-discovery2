import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, History as HistoryIcon, RotateCcw, Save, Check, X, Globe, Boxes, GitBranch, FileEdit } from "lucide-react";
import { toast } from "sonner";
import {
  api, scopeId, watch,
  type ConfigScope, type ConfigScopeSummary, type ConfigScopeResponse,
  type ConfigRevision, type TypedValue, type VarType, type ResolvedConfig,
} from "@/lib/api";
import {
  Badge, Button, Card, CardContent,
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
  Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui";

const VAR_TYPES: VarType[] = ["string", "int", "float", "bool", "json", "bytes"];

interface Row { id: number; key: string; type: VarType; val: string; }

let rowSeq = 1;

// tvToStr renders a TypedValue's value into an editable string.
function tvToStr(tv: TypedValue): string {
  if (tv.type === "json") return JSON.stringify(tv.value, null, 2);
  if (tv.value === null || tv.value === undefined) return "";
  return String(tv.value);
}

// strToTypedValue parses an editor string back into a TypedValue (throws on bad input).
function strToTypedValue(type: VarType, s: string): TypedValue {
  switch (type) {
    case "int": {
      if (!/^-?\d+$/.test(s.trim())) throw new Error("not a whole number");
      return { type, value: parseInt(s, 10) };
    }
    case "float": {
      const f = Number(s);
      if (Number.isNaN(f)) throw new Error("not a number");
      return { type, value: f };
    }
    case "bool":
      return { type, value: s === "true" };
    case "json":
      return { type, value: JSON.parse(s) }; // throws on invalid
    case "bytes":
      // stored/edited as base64 string
      return { type, value: s };
    default:
      return { type: "string", value: s };
  }
}

function varsToRows(vars: Record<string, TypedValue>): Row[] {
  return Object.entries(vars)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, tv]) => ({ id: rowSeq++, key, type: tv.type, val: tvToStr(tv) }));
}

function rowsToVars(rows: Row[]): Record<string, TypedValue> {
  const out: Record<string, TypedValue> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (!k) continue;
    out[k] = strToTypedValue(r.type, r.val); // may throw
  }
  return out;
}

export default function Config() {
  const [scopes, setScopes] = useState<ConfigScopeSummary[]>([]);
  const [selected, setSelected] = useState<ConfigScope>({ kind: "global" });
  const [data, setData] = useState<ConfigScopeResponse | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [note, setNote] = useState("");
  const [dirty, setDirty] = useState(false);
  const [creating, setCreating] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [resolveOpen, setResolveOpen] = useState(false);

  async function refreshScopes() {
    try { setScopes(await api.configScopes()); } catch (e: any) { toast.error(e.message); }
  }

  async function loadScope(scope: ConfigScope) {
    try {
      const resp = await api.configGetScope(scope, "draft,history");
      setData(resp);
      const src = resp.draft?.vars ?? resp.active?.vars ?? {};
      setRows(varsToRows(src));
      setNote("");
      setDirty(false);
    } catch (e: any) { toast.error(e.message); }
  }

  useEffect(() => { refreshScopes(); }, []);
  useEffect(() => { loadScope(selected); /* eslint-disable-next-line */ }, [scopeId(selected)]);
  useEffect(() => {
    const stop = watch(ev => { if (ev.type.startsWith("config.")) { refreshScopes(); } });
    return stop;
  }, []);

  function setRow(id: number, patch: Partial<Row>) {
    setRows(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r));
    setDirty(true);
  }
  function addRow() { setRows(rs => [...rs, { id: rowSeq++, key: "", type: "string", val: "" }]); setDirty(true); }
  function removeRow(id: number) { setRows(rs => rs.filter(r => r.id !== id)); setDirty(true); }

  async function apply() {
    let vars: Record<string, TypedValue>;
    try { vars = rowsToVars(rows); } catch (e: any) { toast.error(`Invalid value: ${e.message}`); return; }
    try {
      await api.configApply(selected, vars, note.trim() || undefined);
      toast.success(`Applied — new revision`);
      await refreshScopes();
      await loadScope(selected);
    } catch (e: any) { toast.error(e.message); }
  }

  async function saveDraft() {
    let vars: Record<string, TypedValue>;
    try { vars = rowsToVars(rows); } catch (e: any) { toast.error(`Invalid value: ${e.message}`); return; }
    try {
      await api.configSaveDraft(selected, vars);
      toast.success("Draft saved");
      await refreshScopes(); await loadScope(selected);
    } catch (e: any) { toast.error(e.message); }
  }

  async function discardDraft() {
    try { await api.configDeleteDraft(selected); toast.success("Draft discarded"); await refreshScopes(); await loadScope(selected); }
    catch (e: any) { toast.error(e.message); }
  }

  async function deleteScope() {
    if (selected.kind === "global") { toast.error("The global scope can't be deleted"); return; }
    try {
      await api.configDeleteScope(selected);
      toast.success("Scope deleted");
      setSelected({ kind: "global" });
      await refreshScopes();
    } catch (e: any) { toast.error(e.message); }
  }

  async function rollback(rev: number) {
    try { await api.configRollback(selected, rev); toast.success(`Rolled back to revision ${rev}`); setHistoryOpen(false); await refreshScopes(); await loadScope(selected); }
    catch (e: any) { toast.error(e.message); }
  }

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
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
              <div className="flex items-center gap-2 min-w-0">
                <ScopeIcon kind={selected.kind} />
                <code className="font-mono text-sm font-medium truncate">{scopeId(selected)}</code>
                {data?.active && <Badge variant="neutral" size="sm">rev {data.active.revision}</Badge>}
                {data?.draft && <Badge variant="warning" size="sm">draft</Badge>}
              </div>
              <div className="flex items-center gap-1.5">
                <Button variant="ghost" size="sm" leftIcon={<HistoryIcon className="size-3.5" />} onClick={() => setHistoryOpen(true)} disabled={!data?.history?.length}>History</Button>
                {selected.kind !== "global" && (
                  <Button variant="ghost" size="sm" leftIcon={<Trash2 className="size-3.5" />} onClick={deleteScope}>Delete</Button>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <div className="hidden sm:grid grid-cols-[1fr_110px_1.5fr_32px] gap-2 px-1 text-[11px] uppercase tracking-wide text-fg-subtle">
                <span>Key</span><span>Type</span><span>Value</span><span />
              </div>
              {rows.map(r => (
                <VarRow key={r.id} row={r} onChange={p => setRow(r.id, p)} onRemove={() => removeRow(r.id)} />
              ))}
              {rows.length === 0 && <div className="text-sm text-fg-subtle px-1 py-3">No variables. Add one below.</div>}
              <Button variant="ghost" size="sm" leftIcon={<Plus className="size-3.5" />} onClick={addRow}>Add variable</Button>
            </div>

            <div className="mt-4 pt-4 border-t border-border flex items-end gap-2 flex-wrap">
              <div className="flex-1 min-w-[200px]">
                <Label htmlFor="cfg-note">Change note</Label>
                <Input id="cfg-note" value={note} onChange={e => setNote(e.target.value)} placeholder="optional, e.g. bump pool size" />
              </div>
              <div className="flex gap-2">
                {data?.draft && <Button variant="ghost" leftIcon={<X className="size-4" />} onClick={discardDraft}>Discard draft</Button>}
                <Button variant="secondary" leftIcon={<Save className="size-4" />} onClick={saveDraft}>Save draft</Button>
                <Button leftIcon={<Check className="size-4" />} onClick={apply}>Apply{dirty ? " •" : ""}</Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <NewScopeDialog open={creating} onOpenChange={setCreating} onCreate={s => { setSelected(s); setCreating(false); }} />
      <HistoryDialog open={historyOpen} onOpenChange={setHistoryOpen} history={data?.history ?? []} active={data?.active?.revision} onRollback={rollback} />
      <ResolveDialog open={resolveOpen} onOpenChange={setResolveOpen} />
    </div>
  );
}

function ScopeIcon({ kind }: { kind: string }) {
  const cls = "size-4 text-fg-muted shrink-0";
  if (kind === "global") return <Globe className={cls} />;
  if (kind === "version") return <GitBranch className={cls} />;
  return <Boxes className={cls} />;
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

function VarRow({ row, onChange, onRemove }: { row: Row; onChange: (p: Partial<Row>) => void; onRemove: () => void }) {
  return (
    <div className="grid grid-cols-[1fr_110px_1.5fr_32px] gap-2 items-start">
      <Input value={row.key} onChange={e => onChange({ key: e.target.value })} placeholder="db/host" className="font-mono text-sm" />
      <Select value={row.type} onValueChange={v => onChange({ type: v as VarType })}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>{VAR_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
      </Select>
      <ValueEditor row={row} onChange={onChange} />
      <Button variant="ghost" size="icon" className="size-8" onClick={onRemove} aria-label="Remove"><X className="size-4" /></Button>
    </div>
  );
}

function ValueEditor({ row, onChange }: { row: Row; onChange: (p: Partial<Row>) => void }) {
  if (row.type === "bool") {
    return (
      <Select value={row.val === "true" ? "true" : "false"} onValueChange={v => onChange({ val: v })}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="true">true</SelectItem><SelectItem value="false">false</SelectItem></SelectContent>
      </Select>
    );
  }
  if (row.type === "json" || row.type === "bytes") {
    return (
      <textarea
        value={row.val}
        onChange={e => onChange({ val: e.target.value })}
        rows={row.type === "json" ? 3 : 2}
        placeholder={row.type === "json" ? '{"k":1}' : "base64…"}
        className="w-full rounded-[var(--radius-md)] border border-border bg-surface px-2.5 py-1.5 text-sm font-mono resize-y focus:outline-none focus:border-accent"
      />
    );
  }
  return (
    <Input
      value={row.val}
      onChange={e => onChange({ val: e.target.value })}
      type={row.type === "int" || row.type === "float" ? "number" : "text"}
      placeholder={row.type === "int" ? "5432" : row.type === "float" ? "1.5" : "value"}
      className="font-mono text-sm"
    />
  );
}

function NewScopeDialog({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange: (b: boolean) => void; onCreate: (s: ConfigScope) => void }) {
  const [kind, setKind] = useState<"global" | "service" | "version">("service");
  const [service, setService] = useState("");
  const [constraint, setConstraint] = useState("");

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
              <Input id="ns-svc" value={service} onChange={e => setService(e.target.value)} placeholder="billing" />
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

function HistoryDialog({ open, onOpenChange, history, active, onRollback }: {
  open: boolean; onOpenChange: (b: boolean) => void; history: ConfigRevision[]; active?: number; onRollback: (rev: number) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Revision history</DialogTitle></DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto divide-y divide-border">
          {history.map(rev => (
            <div key={rev.revision} className="py-2.5 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Badge variant={rev.revision === active ? "brand" : "neutral"} size="sm">rev {rev.revision}</Badge>
                  <span className="text-xs text-fg-subtle">{Object.keys(rev.vars).length} vars</span>
                  {rev.revision === active && <span className="text-xs text-accent">active</span>}
                </div>
                {rev.note && <div className="text-sm mt-0.5 truncate">{rev.note}</div>}
                <div className="text-[11px] text-fg-subtle">{new Date(rev.createdAt).toLocaleString()}{rev.author ? ` · ${rev.author}` : ""}</div>
              </div>
              {rev.revision !== active && (
                <Button variant="secondary" size="sm" leftIcon={<RotateCcw className="size-3.5" />} onClick={() => onRollback(rev.revision)}>Rollback</Button>
              )}
            </div>
          ))}
          {history.length === 0 && <div className="text-sm text-fg-subtle py-4">No history yet.</div>}
        </div>
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
