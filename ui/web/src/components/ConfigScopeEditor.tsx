import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2, History as HistoryIcon, RotateCcw, Save, Check, X, Maximize2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import {
  api, scopeId, watch,
  type ConfigScope, type ConfigScopeResponse, type ConfigRevision, type TypedValue, type VarType,
} from "@/lib/api";
import {
  VAR_TYPES, type Row,
  tvToStr, varsToRows, rowsToVars, rowsSignature, nextRowId, truncate,
  diffVars, type VarDiff,
} from "@/lib/configvars";
import {
  Badge, Button, Card, CardContent, Textarea,
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
  Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui";

// A self-contained editor for a single config scope: loads it, lets the operator
// edit/draft/apply/rollback its variables. Reused on the Config page (full,
// with Delete) and on ServiceDetail (per-service, read-only when the caller
// can't edit the service).
export function ConfigScopeEditor({
  scope, readOnly, showDelete, onScopesChanged, onDeleted,
}: {
  scope: ConfigScope;
  readOnly?: boolean;
  showDelete?: boolean;
  onScopesChanged?: () => void;
  onDeleted?: () => void;
}) {
  const [data, setData] = useState<ConfigScopeResponse | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loaded, setLoaded] = useState<Row[]>([]);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);

  const base = useMemo(() => rowsSignature(loaded), [loaded]);
  const dirty = rowsSignature(rows) !== base;
  // Keep a live ref so the watch handler can decide whether a reload would
  // clobber unsaved edits.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  async function load() {
    setLoading(true);
    try {
      const resp = await api.configGetScope(scope, "draft,history");
      setData(resp);
      const src = resp.draft?.vars ?? resp.active?.vars ?? {};
      const r = varsToRows(src);
      setRows(r);
      setLoaded(r.map(x => ({ ...x })));
      setNote("");
    } catch (e: any) { toast.error(e.message); }
    finally { setLoading(false); }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [scopeId(scope)]);
  useEffect(() => {
    const stop = watch(ev => {
      if (!ev.type.startsWith("config.")) return;
      if (ev.service && scope.service && ev.service !== scope.service) return;
      // Don't yank the rug out from under unsaved local edits.
      if (!dirtyRef.current) load();
    });
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeId(scope)]);

  function setRow(id: number, patch: Partial<Row>) {
    setRows(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r));
  }
  function addRow() { setRows(rs => [...rs, { id: nextRowId(), key: "", type: "string", val: "" }]); }
  function removeRow(id: number) { setRows(rs => rs.filter(r => r.id !== id)); }
  function reset() { setRows(loaded.map(r => ({ ...r }))); setNote(""); }

  async function apply() {
    let vars: Record<string, TypedValue>;
    try { vars = rowsToVars(rows); } catch (e: any) { toast.error(`Invalid value: ${e.message}`); return; }
    try {
      await api.configApply(scope, vars, note.trim() || undefined);
      toast.success("Applied — new revision");
      await load();
      onScopesChanged?.();
    } catch (e: any) { toast.error(e.message); }
  }

  async function saveDraft() {
    let vars: Record<string, TypedValue>;
    try { vars = rowsToVars(rows); } catch (e: any) { toast.error(`Invalid value: ${e.message}`); return; }
    try {
      await api.configSaveDraft(scope, vars);
      toast.success("Draft saved");
      await load();
      onScopesChanged?.();
    } catch (e: any) { toast.error(e.message); }
  }

  async function discardDraft() {
    try { await api.configDeleteDraft(scope); toast.success("Draft discarded"); await load(); onScopesChanged?.(); }
    catch (e: any) { toast.error(e.message); }
  }

  async function deleteScope() {
    try {
      await api.configDeleteScope(scope);
      toast.success("Scope deleted");
      onDeleted?.();
      onScopesChanged?.();
    } catch (e: any) { toast.error(e.message); }
  }

  async function rollback(rev: number) {
    try { await api.configRollback(scope, rev); toast.success(`Rolled back to revision ${rev}`); setHistoryOpen(false); await load(); onScopesChanged?.(); }
    catch (e: any) { toast.error(e.message); }
  }

  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <code className="font-mono text-sm font-medium truncate">{scopeId(scope)}</code>
            {data?.active && <Badge variant="neutral" size="sm">rev {data.active.revision}</Badge>}
            {data?.draft && <Badge variant="warning" size="sm">draft</Badge>}
            {readOnly && <Badge variant="outline" size="sm">read-only</Badge>}
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" leftIcon={<HistoryIcon className="size-3.5" />}
              onClick={() => setHistoryOpen(true)} disabled={!data?.history?.length}>
              History{data?.history?.length ? ` (${Math.min(data.history.length, 10)})` : ""}
            </Button>
            {showDelete && !readOnly && (
              <Button variant="ghost" size="sm" leftIcon={<Trash2 className="size-3.5" />} onClick={deleteScope}>Delete</Button>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <div className="hidden sm:grid grid-cols-[1fr_110px_1.5fr_32px] gap-2 px-1 text-[11px] uppercase tracking-wide text-fg-subtle">
            <span>Key</span><span>Type</span><span>Value</span><span />
          </div>
          {rows.map(r => (
            <VarRow key={r.id} row={r} readOnly={readOnly}
              onChange={p => setRow(r.id, p)} onRemove={() => removeRow(r.id)} onExpand={() => setEditing(r)} />
          ))}
          {rows.length === 0 && (
            <div className="text-sm text-fg-subtle px-1 py-3">
              {loading ? "Loading…" : readOnly ? "No variables." : "No variables. Add one below."}
            </div>
          )}
          {!readOnly && (
            <Button variant="ghost" size="sm" leftIcon={<Plus className="size-3.5" />} onClick={addRow}>Add variable</Button>
          )}
        </div>

        {!readOnly && (
          <div className="mt-4 pt-4 border-t border-border flex items-end gap-2 flex-wrap">
            <div className="flex-1 min-w-[200px]">
              <Label htmlFor={`cfg-note-${scopeId(scope)}`}>Change note</Label>
              <Input id={`cfg-note-${scopeId(scope)}`} value={note} onChange={e => setNote(e.target.value)}
                placeholder="optional, e.g. bump pool size" />
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" leftIcon={<Undo2 className="size-4" />} onClick={reset} disabled={!dirty}>Reset</Button>
              {data?.draft && <Button variant="ghost" leftIcon={<X className="size-4" />} onClick={discardDraft}>Discard draft</Button>}
              <Button variant="secondary" leftIcon={<Save className="size-4" />} onClick={saveDraft} disabled={!dirty}>Save draft</Button>
              <Button leftIcon={<Check className="size-4" />} onClick={apply} disabled={!dirty}>Apply</Button>
            </div>
          </div>
        )}
      </CardContent>

      {editing && (
        <BigValueDialog
          row={editing}
          readOnly={readOnly}
          onClose={() => setEditing(null)}
          onSave={(val) => { setRow(editing.id, { val }); setEditing(null); }}
        />
      )}
      <HistoryDialog open={historyOpen} onOpenChange={setHistoryOpen}
        history={data?.history ?? []} active={data?.active?.revision}
        readOnly={readOnly} onRollback={rollback} />
    </Card>
  );
}

// --- a single variable row ---

function VarRow({ row, readOnly, onChange, onRemove, onExpand }: {
  row: Row; readOnly?: boolean; onChange: (p: Partial<Row>) => void; onRemove: () => void; onExpand: () => void;
}) {
  return (
    <div className="grid grid-cols-[1fr_110px_1.5fr_32px] gap-2 items-start">
      <Input value={row.key} onChange={e => onChange({ key: e.target.value })} placeholder="db/host"
        className="font-mono text-sm" disabled={readOnly} />
      <Select value={row.type} onValueChange={v => onChange({ type: v as VarType })} disabled={readOnly}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>{VAR_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
      </Select>
      <ValueEditor row={row} readOnly={readOnly} onChange={onChange} onExpand={onExpand} />
      {!readOnly ? (
        <Button variant="ghost" size="icon" className="size-8" onClick={onRemove} aria-label="Remove"><X className="size-4" /></Button>
      ) : <span />}
    </div>
  );
}

// big = render a compact preview + an Expand button instead of a sprawling
// inline textarea. Applies to json/bytes and any long value.
function isBig(row: Row): boolean {
  return row.type === "json" || row.type === "bytes" || row.val.length > 80 || row.val.includes("\n");
}

function ValueEditor({ row, readOnly, onChange, onExpand }: {
  row: Row; readOnly?: boolean; onChange: (p: Partial<Row>) => void; onExpand: () => void;
}) {
  if (row.type === "bool") {
    return (
      <Select value={row.val === "true" ? "true" : "false"} onValueChange={v => onChange({ val: v })} disabled={readOnly}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="true">true</SelectItem><SelectItem value="false">false</SelectItem></SelectContent>
      </Select>
    );
  }
  if (isBig(row)) {
    const empty = row.val.trim() === "";
    return (
      <button type="button" onClick={onExpand}
        className="w-full text-left rounded-[var(--radius-md)] border border-border bg-surface px-2.5 py-1.5 hover:border-border-strong transition-colors group">
        <div className="flex items-start gap-2">
          <code className={`flex-1 text-[11px] leading-snug font-mono whitespace-pre-wrap break-all line-clamp-2 ${empty ? "text-fg-subtle" : "text-fg-muted"}`}>
            {empty ? (row.type === "json" ? "{ } — click to edit" : "empty — click to edit") : truncate(row.val)}
          </code>
          <Maximize2 className="size-3.5 text-fg-subtle group-hover:text-fg shrink-0 mt-0.5" />
        </div>
        <div className="mt-1 flex items-center gap-2 text-[10px] text-fg-subtle">
          <span className="uppercase tracking-wide">{row.type}</span>
          {!empty && <span>· {row.val.length} chars</span>}
        </div>
      </button>
    );
  }
  return (
    <Input
      value={row.val}
      onChange={e => onChange({ val: e.target.value })}
      type={row.type === "int" || row.type === "float" ? "number" : "text"}
      placeholder={row.type === "int" ? "5432" : row.type === "float" ? "1.5" : "value"}
      className="font-mono text-sm" disabled={readOnly}
    />
  );
}

// --- big / JSON value editor with highlighting + validation ---

function escapeHTML(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// highlightJSON returns HTML with token-colored spans. Cheap regex tokenizer —
// good enough for a preview pane (not a parser).
function highlightJSON(src: string): string {
  return escapeHTML(src).replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (m, str, colon, lit, num) => {
      if (str !== undefined) {
        return colon
          ? `<span class="text-accent">${str}</span>${colon}`
          : `<span class="text-success">${str}</span>`;
      }
      if (lit !== undefined) return `<span class="text-warning">${lit}</span>`;
      if (num !== undefined) return `<span class="text-info">${num}</span>`;
      return m;
    },
  );
}

function BigValueDialog({ row, readOnly, onClose, onSave }: {
  row: Row; readOnly?: boolean; onClose: () => void; onSave: (val: string) => void;
}) {
  const [text, setText] = useState(row.val);
  const isJSON = row.type === "json";

  const error = useMemo(() => {
    if (!isJSON || text.trim() === "") return null;
    try { JSON.parse(text); return null; } catch (e: any) { return e.message as string; }
  }, [text, isJSON]);

  function format() {
    try { setText(JSON.stringify(JSON.parse(text), null, 2)); }
    catch (e: any) { toast.error(`Can't format: ${e.message}`); }
  }

  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="font-mono text-sm truncate">{row.key || "(unnamed)"}</span>
            <Badge variant="neutral" size="sm">{row.type}</Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          <Textarea
            value={text}
            onChange={e => setText(e.target.value)}
            readOnly={readOnly}
            spellCheck={false}
            rows={12}
            className="font-mono text-xs leading-relaxed resize-y"
            placeholder={isJSON ? '{\n  "key": "value"\n}' : row.type === "bytes" ? "base64…" : "value"}
          />
          {isJSON && (
            <div className="flex items-center justify-between gap-2 min-h-5">
              {error
                ? <span className="text-xs text-danger truncate">⚠ {error}</span>
                : text.trim() === ""
                  ? <span className="text-xs text-fg-subtle">empty</span>
                  : <span className="text-xs text-success">✓ valid JSON</span>}
              {!readOnly && <Button variant="ghost" size="sm" onClick={format} disabled={!!error}>Format</Button>}
            </div>
          )}
          {isJSON && text.trim() !== "" && !error && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-fg-subtle mb-1">Preview</div>
              <pre className="max-h-44 overflow-auto rounded-[var(--radius-md)] border border-border bg-surface p-3 text-xs font-mono leading-relaxed"
                dangerouslySetInnerHTML={{ __html: highlightJSON(text) }} />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{readOnly ? "Close" : "Cancel"}</Button>
          {!readOnly && <Button onClick={() => onSave(text)} disabled={!!error}>Done</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- revision history with per-key diff ---

function HistoryDialog({ open, onOpenChange, history, active, readOnly, onRollback }: {
  open: boolean; onOpenChange: (b: boolean) => void;
  history: ConfigRevision[]; active?: number; readOnly?: boolean; onRollback: (rev: number) => void;
}) {
  const recent = useMemo(
    () => [...history].sort((a, b) => b.revision - a.revision).slice(0, 10),
    [history],
  );
  const [sel, setSel] = useState<number | null>(null);
  const selected = recent.find(r => r.revision === sel) ?? recent[0];
  const prev = selected ? history.find(r => r.revision === selected.revision - 1) : undefined;
  const diff = selected ? diffVars(prev?.vars, selected.vars) : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>Revision history</DialogTitle></DialogHeader>
        {recent.length === 0 ? (
          <div className="text-sm text-fg-subtle py-4">No history yet.</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-[210px_1fr] gap-4">
            <div className="max-h-[60vh] overflow-y-auto -mx-1 px-1">
              {recent.map(rev => {
                const on = (selected?.revision ?? -1) === rev.revision;
                return (
                  <button key={rev.revision} onClick={() => setSel(rev.revision)}
                    className={[
                      "w-full text-left rounded-[var(--radius-md)] px-2.5 py-2 mb-1 transition-colors border",
                      on ? "border-accent bg-[color-mix(in_oklab,var(--brand-500)_10%,transparent)]" : "border-transparent hover:bg-surface-hover",
                    ].join(" ")}>
                    <div className="flex items-center gap-2">
                      <Badge variant={rev.revision === active ? "brand" : "neutral"} size="sm">rev {rev.revision}</Badge>
                      {rev.revision === active && <span className="text-[11px] text-accent">active</span>}
                    </div>
                    {rev.note && <div className="text-xs mt-1 truncate">{rev.note}</div>}
                    <div className="text-[10px] text-fg-subtle mt-0.5">
                      {new Date(rev.createdAt).toLocaleString()}{rev.author ? ` · ${rev.author}` : ""}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="min-w-0">
              {selected && (
                <>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="text-sm text-fg-muted">
                      Changes in <span className="font-medium text-fg">rev {selected.revision}</span>
                      {prev ? <> vs rev {prev.revision}</> : <> (first revision)</>}
                    </div>
                    {!readOnly && selected.revision !== active && (
                      <Button variant="secondary" size="sm" leftIcon={<RotateCcw className="size-3.5" />}
                        onClick={() => onRollback(selected.revision)}>Rollback</Button>
                    )}
                  </div>
                  <DiffList diff={diff} />
                </>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DiffList({ diff }: { diff: VarDiff[] }) {
  const changed = diff.filter(d => d.kind !== "same");
  const sameCount = diff.length - changed.length;
  return (
    <div className="max-h-[60vh] overflow-y-auto space-y-1.5">
      {changed.length === 0 && <div className="text-sm text-fg-subtle py-2">No variable changes.</div>}
      {changed.map(d => <DiffRow key={d.key} d={d} />)}
      {sameCount > 0 && (
        <div className="text-[11px] text-fg-subtle pt-1">{sameCount} unchanged variable{sameCount === 1 ? "" : "s"}</div>
      )}
    </div>
  );
}

function DiffRow({ d }: { d: VarDiff }) {
  // green = added, amber = changed, red = removed.
  const border =
    d.kind === "added" ? "border-l-success" :
    d.kind === "changed" ? "border-l-warning" :
    "border-l-danger";
  const tag =
    d.kind === "added" ? <Badge variant="success" size="sm">new</Badge> :
    d.kind === "changed" ? <Badge variant="warning" size="sm">changed</Badge> :
    <Badge variant="danger" size="sm">removed</Badge>;
  return (
    <div className={`rounded-[var(--radius-md)] border border-border border-l-[3px] ${border} bg-surface px-3 py-2`}>
      <div className="flex items-center gap-2 mb-1">
        <code className="font-mono text-xs font-medium truncate">{d.key}</code>
        {tag}
      </div>
      {d.kind === "changed" ? (
        <div className="space-y-0.5 text-[11px] font-mono">
          <div className="text-danger/80 break-all"><span className="text-fg-subtle select-none">- </span>{truncate(tvToStr(d.before!))}</div>
          <div className="text-success break-all"><span className="text-fg-subtle select-none">+ </span>{truncate(tvToStr(d.after!))}</div>
        </div>
      ) : (
        <div className="text-[11px] font-mono text-fg-muted break-all">
          {truncate(tvToStr((d.after ?? d.before)!))}
        </div>
      )}
    </div>
  );
}
