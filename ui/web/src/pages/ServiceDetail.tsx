import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { ArrowLeft, Ban, Check, Copy, Hash, Lock, Plus, Settings, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, CheckMode, CheckResponse, CorpUserHit, Instance, Interface, ProbeResult, Service, Visibility, watch } from "@/lib/api";
import { StatusBadge } from "@/components/StatusBadge";
import { useAuth } from "@/lib/auth";
import { VisibilityBadge } from "./Services";
import {
  Badge, Button, Card, CardContent, Checkbox,
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
  Input, Label,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui";

export default function ServiceDetail() {
  const { name = "" } = useParams();
  const navigate = useNavigate();
  const { me } = useAuth();
  const [service, setService] = useState<Service | null>(null);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [editingInst, setEditingInst] = useState<Instance | null>(null);
  const [editingMeta, setEditingMeta] = useState(false);
  const [confirmDeleteService, setConfirmDeleteService] = useState(false);
  const [pendingDeleteInst, setPendingDeleteInst] = useState<string | null>(null);

  async function refresh() {
    try {
      const [svc, insts] = await Promise.all([
        api.getService(name),
        api.listInstances(name),
      ]);
      setService(svc);
      setInstances(insts);
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  useEffect(() => {
    refresh();
    const stop = watch(ev => { if (ev.service === name) refresh(); });
    return stop;
  }, [name]);

  const canEdit = useMemo(() => {
    if (!service || !me) return false;
    if (me.isAdmin) return true;
    if ((service.visibility ?? "public") === "public") return !!me.userId;
    if (service.ownerId && service.ownerId === me.userId) return true;
    return (service.grants ?? []).includes(me.userId ?? "");
  }, [service, me]);

  const canManageGrants = useMemo(() => {
    if (!service || !me) return false;
    if (me.isAdmin) return true;
    return service.ownerId === me.userId;
  }, [service, me]);

  async function deleteService() {
    try {
      await api.deleteService(name);
      toast.success(`Service "${name}" deleted`);
      navigate("/services");
    } catch (e: any) { toast.error(e.message); }
  }

  async function deleteInstance(id: string) {
    try {
      await api.deleteInstance(name, id);
      toast.success("Instance deleted");
      setPendingDeleteInst(null);
      refresh();
    } catch (e: any) { toast.error(e.message); }
  }

  async function toggleBlock(inst: Instance) {
    try {
      await api.blockInstance(name, inst.id, !inst.blocked);
      toast.success(inst.blocked ? "Instance unblocked — back in rotation" : "Instance blocked — traffic rebalanced");
      refresh();
    } catch (e: any) { toast.error(e.message); }
  }

  async function saveMeta(patch: Partial<Service>) {
    if (!service) return;
    try {
      await api.putService(service.name, {
        description: patch.description ?? service.description,
        visibility: patch.visibility ?? service.visibility,
        tags: patch.tags ?? service.tags,
        metadata: service.metadata,
      });
      toast.success("Service updated");
      setEditingMeta(false);
      refresh();
    } catch (e: any) { toast.error(e.message); }
  }

  async function renameService(newName: string) {
    if (!service || !newName || newName === service.name) return;
    try {
      const renamed = await api.renameService(service.name, newName);
      toast.success(`Renamed to "${renamed.name}"`);
      setEditingMeta(false);
      navigate(`/services/${encodeURIComponent(renamed.name)}`, { replace: true });
    } catch (e: any) { toast.error(e.message); }
  }

  async function addGrant(userId: string) {
    try {
      await api.addGrant(name, userId);
      toast.success("Access granted");
      refresh();
    } catch (e: any) { toast.error(e.message); }
  }

  async function removeGrant(userId: string) {
    try {
      await api.removeGrant(name, userId);
      toast.success("Access revoked");
      refresh();
    } catch (e: any) { toast.error(e.message); }
  }

  // Per-instance manual check state.
  const [checking, setChecking] = useState<Record<string, boolean>>({});
  const [checkResults, setCheckResults] = useState<Record<string, CheckResponse>>({});

  async function checkNow(id: string) {
    setChecking(p => ({ ...p, [id]: true }));
    try {
      const r = await api.checkInstance(name, id);
      setCheckResults(p => ({ ...p, [id]: r }));
      if (r.ok) toast.success("Check passed");
      else toast.error("Check failed");
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setChecking(p => ({ ...p, [id]: false }));
      refresh();
    }
  }

  function copyInstance(inst: Instance) {
    setEditingInst({
      ...inst,
      id: "",
      address: inst.address,
      managed: false, // operator-made copy is editable, not self-managed
      lastHeartbeat: "",
      registeredAt: "",
      updatedAt: "",
    });
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <Link to="/services" className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg">
          <ArrowLeft className="size-3.5" /> Services
        </Link>
        <div className="flex items-end justify-between gap-3 mt-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-semibold tracking-tight truncate">{name}</h1>
              <VisibilityBadge v={service?.visibility} />
              {!canEdit && <Badge variant="outline" size="sm">read-only for you</Badge>}
            </div>
            {service?.description && <div className="text-sm text-fg-muted mt-1">{service.description}</div>}
            {service?.tags && service.tags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {service.tags.map(t => (
                  <Link key={t} to={`/services?tag=${encodeURIComponent(t)}`}
                    className="inline-flex items-center gap-1 h-6 px-2 rounded-full text-xs font-medium bg-surface border border-border text-fg-muted hover:text-fg hover:border-border-strong transition-colors">
                    <Hash className="size-3" />
                    {t}
                  </Link>
                ))}
              </div>
            )}
          </div>
          <div className="flex gap-2">
            {canEdit && (
              <>
                <Button variant="secondary" leftIcon={<Settings className="size-4" />} onClick={() => setEditingMeta(true)}>Settings</Button>
                <Button variant="secondary" leftIcon={<Plus className="size-4" />} onClick={() => setEditingInst({
                  id: "", service: name, address: "", interfaces: [],
                  weight: 1, status: "up", ttlSeconds: 30,
                  checkMode: "heartbeat", checkIntervalSec: 15,
                  lastHeartbeat: "", registeredAt: "", updatedAt: "",
                })}>Instance</Button>
                <Button variant="danger" leftIcon={<Trash2 className="size-4" />} onClick={() => setConfirmDeleteService(true)}>Delete</Button>
              </>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDeleteService}
        onOpenChange={setConfirmDeleteService}
        title="Delete service"
        body={`Permanently delete "${name}" and all its instances?`}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={deleteService}
      />
      <ConfirmDialog
        open={!!pendingDeleteInst}
        onOpenChange={open => !open && setPendingDeleteInst(null)}
        title="Delete instance"
        body={pendingDeleteInst ? `Delete instance ${pendingDeleteInst}?` : ""}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={() => pendingDeleteInst && deleteInstance(pendingDeleteInst)}
      />

      {editingMeta && service && (
        <ServiceMetaEditor
          service={service}
          canManageGrants={canManageGrants}
          onClose={() => setEditingMeta(false)}
          onSave={saveMeta}
          onRename={renameService}
          onAddGrant={addGrant}
          onRemoveGrant={removeGrant}
        />
      )}

      {editingInst && (
        <InstanceEditor
          serviceName={name}
          initial={editingInst}
          onClose={() => setEditingInst(null)}
          onSaved={() => { setEditingInst(null); refresh(); }}
        />
      )}

      <h2 className="text-sm uppercase tracking-wider text-fg-subtle mb-3">
        Instances ({instances.length})
      </h2>

      {instances.length === 0 ? (
        <Card><CardContent className="text-center text-fg-muted py-8">No instances registered.</CardContent></Card>
      ) : (
        <div className="space-y-3">
          {instances.map(inst => (
            <Card key={inst.id} className={inst.blocked ? "border-warning/50" : undefined}>
              <CardContent className="pt-4">
                <div className="flex items-start justify-between gap-3">
                  <div className={`min-w-0 flex-1 ${inst.blocked ? "opacity-60" : ""}`}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-sm truncate">{inst.address}</span>
                      <StatusBadge status={inst.status} />
                      {inst.version && (
                        <Badge variant="brand" size="sm" title="Instance version (semver-queryable)">v{inst.version}</Badge>
                      )}
                      {inst.blocked && (
                        <Badge variant="warning" size="sm" title="Operator-blocked — excluded from discover/pick.">
                          <Ban className="size-3 mr-1" />blocked
                        </Badge>
                      )}
                      <CheckModeBadge mode={inst.checkMode} />
                      {inst.managed && (
                        <Badge variant="info" size="sm" title="Self-registered by the service via discovery2-client. UI edits are blocked.">
                          <Lock className="size-3 mr-1" />self-managed
                        </Badge>
                      )}
                      <Badge variant="outline" size="sm">weight {inst.weight}</Badge>
                      {(!inst.checkMode || inst.checkMode === "heartbeat") && (
                        <Badge variant="outline" size="sm">TTL {inst.ttlSeconds}s</Badge>
                      )}
                    </div>
                    <div className="text-xs text-fg-muted mt-1 font-mono truncate">id: {inst.id}</div>
                    <div className="text-xs text-fg-muted mt-0.5">last heartbeat: {fmtTime(inst.lastHeartbeat)}</div>
                    {inst.interfaces.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {inst.interfaces.map((it, i) => (
                          <InterfacePill key={i} it={it}
                            probe={findInterfaceProbe(inst, it.name)} />
                        ))}
                      </div>
                    )}
                    {checkResults[inst.id] && (
                      <CheckReport result={checkResults[inst.id]}
                        onDismiss={() => setCheckResults(p => { const n = { ...p }; delete n[inst.id]; return n; })} />
                    )}
                  </div>
                  {canEdit && (
                    <div className="flex flex-col gap-2 shrink-0">
                      {/* Manual Check is only useful for active probe modes —
                          on heartbeat-mode it would just re-evaluate TTL,
                          which the background sweeper does anyway. */}
                      {(inst.checkMode === "http" || inst.checkMode === "tcp") && (
                        <Button variant="secondary" size="sm" loading={checking[inst.id]} leftIcon={<Check className="size-3.5" />}
                          onClick={() => checkNow(inst.id)}>Check</Button>
                      )}
                      {!inst.managed && (
                        <Button variant="secondary" size="sm" leftIcon={<Settings className="size-3.5" />}
                          onClick={() => setEditingInst(inst)}>Edit</Button>
                      )}
                      {/* Block works even on managed instances — it's an
                          operator action the owning client cannot override. */}
                      <Button
                        variant={inst.blocked ? "primary" : "secondary"}
                        size="sm"
                        leftIcon={inst.blocked ? <Check className="size-3.5" /> : <Ban className="size-3.5" />}
                        onClick={() => toggleBlock(inst)}
                        title={inst.blocked ? "Return this instance to rotation" : "Remove from discovery so traffic rebalances"}
                      >
                        {inst.blocked ? "Unblock" : "Block"}
                      </Button>
                      <Button variant="secondary" size="sm" leftIcon={<Copy className="size-3.5" />}
                        onClick={() => copyInstance(inst)}>Copy</Button>
                      {!inst.managed && (
                        <Button variant="danger" size="sm" leftIcon={<Trash2 className="size-3.5" />}
                          onClick={() => setPendingDeleteInst(inst.id)}>Delete</Button>
                      )}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function ConfirmDialog({
  open, onOpenChange, title, body, confirmLabel = "Confirm", confirmVariant = "primary", onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  body: string;
  confirmLabel?: string;
  confirmVariant?: "primary" | "danger";
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <p className="text-sm text-fg-muted">{body}</p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant={confirmVariant} onClick={() => { onConfirm(); onOpenChange(false); }}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function findInterfaceProbe(inst: Instance, name: string): ProbeResult | undefined {
  return inst.lastCheck?.results?.find(r => r.interface === name);
}

function InterfacePill({ it, probe }: { it: Interface; probe?: ProbeResult }) {
  const proto = (it.tls && (it.protocol === "http" || it.protocol === "ws"))
    ? it.protocol + "s" : it.protocol;
  let variant: "brand" | "success" | "danger" = "brand";
  let title: string | undefined;
  if (probe) {
    if (probe.ok) {
      variant = "success";
      title = `OK${probe.httpStatus ? ` · HTTP ${probe.httpStatus}` : ""}${probe.latencyMs ? ` · ${probe.latencyMs}ms` : ""}`;
    } else {
      variant = "danger";
      title = probe.error || "FAILED";
    }
  }
  return (
    <Badge variant={variant} className="font-mono" title={title}>
      {it.name}: {proto}:{it.port}{it.path || ""}
    </Badge>
  );
}

function CheckReport({ result, onDismiss }: { result: CheckResponse; onDismiss: () => void }) {
  return (
    <div className={
      "mt-3 rounded-[var(--radius-md)] border px-3 py-2 text-xs " +
      (result.ok
        ? "border-[color-mix(in_oklab,var(--success)_25%,transparent)] bg-success-bg text-success"
        : "border-[color-mix(in_oklab,var(--danger)_25%,transparent)] bg-danger-bg text-danger")
    }>
      <div className="flex items-center justify-between mb-1">
        <span className="font-semibold">
          {result.ok ? "Check passed" : "Check failed"}
          <span className="opacity-60 ml-2 font-normal">mode: {result.mode || "heartbeat"}</span>
        </span>
        <button className="opacity-70 hover:opacity-100 px-1" onClick={onDismiss} aria-label="Dismiss">✕</button>
      </div>
      <ul className="space-y-1">
        {result.results.map((r, i) => (
          <li key={i} className="font-mono break-all">
            <span>{r.ok ? "✓" : "✗"}</span>{" "}
            <span className="font-semibold">{r.interface}</span>
            {r.url && <> → {r.url}</>}
            {r.httpStatus ? <> · HTTP {r.httpStatus}</> : null}
            {r.latencyMs ? <> · {r.latencyMs}ms</> : null}
            {r.error && <span className="opacity-80"> · {r.error}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CheckModeBadge({ mode }: { mode?: CheckMode }) {
  const m: CheckMode = mode || "heartbeat";
  if (m === "heartbeat") return <Badge variant="outline" size="sm" className="font-mono">check: heartbeat</Badge>;
  if (m === "http" || m === "tcp") return <Badge variant="brand" size="sm" className="font-mono">check: {m}</Badge>;
  return <Badge variant="warning" size="sm" className="font-mono">check: {m}</Badge>;
}

function fmtTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  return d.toLocaleString();
}

// --- Service settings (visibility, grants, rename) ---

function ServiceMetaEditor({
  service, canManageGrants, onClose, onSave, onRename, onAddGrant, onRemoveGrant,
}: {
  service: Service;
  canManageGrants: boolean;
  onClose: () => void;
  onSave: (patch: Partial<Service>) => void;
  onRename: (newName: string) => void;
  onAddGrant: (userId: string) => void;
  onRemoveGrant: (userId: string) => void;
}) {
  const [name, setName] = useState(service.name);
  const [description, setDescription] = useState(service.description || "");
  const [tags, setTags] = useState((service.tags || []).join(", "));
  const [visibility, setVisibility] = useState<Visibility>(service.visibility || "public");
  const [grantInput, setGrantInput] = useState("");
  const [grantHit, setGrantHit] = useState<CorpUserHit | null>(null);
  const [grantBusy, setGrantBusy] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);

  function userLabel(id: string) {
    return id; // Owner/grant IDs are corp-ui user IDs; the human label
               // would require a corp lookup per ID. Keep the IDs visible
               // here — search-by-identifier below resolves on demand.
  }

  async function searchCorp() {
    setGrantError(null);
    setGrantHit(null);
    if (!grantInput.trim()) return;
    setGrantBusy(true);
    try {
      const hits = await api.searchCorpUsers(grantInput.trim());
      if (hits.length === 0) {
        setGrantError("no user found in corp-ui");
      } else {
        setGrantHit(hits[0]);
      }
    } catch (e: any) {
      setGrantError(e.message || "search failed");
    } finally {
      setGrantBusy(false);
    }
  }

  function handleSave() {
    const tagList = tags.split(",").map(t => t.trim()).filter(Boolean);
    onSave({ description, visibility, tags: tagList });
    if (name.trim() && name.trim() !== service.name) {
      onRename(name.trim());
    }
  }

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>Service settings</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="meta-name">Name</Label>
            <Input id="meta-name" value={name} onChange={e => setName(e.target.value)} />
            {name.trim() !== service.name && (
              <div className="text-xs text-warning mt-1">
                Renaming moves all instances under the new name.
              </div>
            )}
          </div>
          <div>
            <Label htmlFor="meta-desc">Description</Label>
            <Input id="meta-desc" value={description} onChange={e => setDescription(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="meta-tags">Tags</Label>
            <Input id="meta-tags" value={tags} onChange={e => setTags(e.target.value)}
              placeholder="comma-separated, e.g. backend, prod" />
            <p className="text-xs text-fg-subtle mt-1">Used to group and filter services.</p>
          </div>
          <div>
            <Label>Visibility</Label>
            <Select value={visibility || "public"} onValueChange={v => setVisibility(v as Visibility)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="public">public — anyone can edit</SelectItem>
                <SelectItem value="private">private — only owner / admin / granted</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="mt-2 pt-4 border-t border-border">
          <h3 className="text-sm font-semibold mb-2">Owner & access</h3>
          <div className="text-xs text-fg-muted mb-3">
            Owner: <span className="font-mono">{service.ownerId ? userLabel(service.ownerId) : "system"}</span>
          </div>
          <Label>Granted users</Label>
          {(service.grants || []).length === 0 ? (
            <div className="text-sm text-fg-muted mb-2">No additional users have edit access.</div>
          ) : (
            <ul className="space-y-1 mb-3">
              {(service.grants || []).map(uid => (
                <li key={uid} className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-[var(--radius-md)] bg-surface">
                  <span className="font-mono text-sm">{userLabel(uid)}</span>
                  {canManageGrants && (
                    <Button variant="ghost" size="sm" onClick={() => onRemoveGrant(uid)}>remove</Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canManageGrants && (
            <div className="space-y-2">
              <div className="flex gap-2">
                <Input className="flex-1" placeholder="email or username (in corp-ui)"
                  value={grantInput} onChange={e => { setGrantInput(e.target.value); setGrantHit(null); setGrantError(null); }} />
                <Button variant="secondary" disabled={grantBusy || !grantInput.trim()} onClick={searchCorp}>
                  {grantBusy ? "…" : "Find"}
                </Button>
                <Button variant="primary"
                  disabled={!grantHit}
                  onClick={() => {
                    if (grantHit) {
                      onAddGrant(grantHit.id);
                      setGrantInput("");
                      setGrantHit(null);
                    }
                  }}>
                  Grant
                </Button>
              </div>
              {grantError && <div className="text-xs text-danger">{grantError}</div>}
              {grantHit && (
                <div className="text-xs text-fg-muted">
                  Found <span className="font-mono">{grantHit.email || grantHit.username || grantHit.id}</span>
                  {" "}— click Grant to add.
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- Instance editor ---

function InstanceEditor({
  serviceName, initial, onClose, onSaved,
}: {
  serviceName: string;
  initial: Instance;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [inst, setInst] = useState<Instance>(initial);
  const [saving, setSaving] = useState(false);
  const isNew = !initial.id;

  function update<K extends keyof Instance>(k: K, v: Instance[K]) {
    setInst(p => ({ ...p, [k]: v }));
  }
  function updateIface(idx: number, patch: Partial<Interface>) {
    setInst(p => ({ ...p, interfaces: p.interfaces.map((it, i) => i === idx ? { ...it, ...patch } : it) }));
  }
  function addIface() {
    setInst(p => ({ ...p, interfaces: [...p.interfaces, { name: "", protocol: "http", port: 8080 }] }));
  }
  function removeIface(idx: number) {
    setInst(p => ({ ...p, interfaces: p.interfaces.filter((_, i) => i !== idx) }));
  }

  async function save() {
    setSaving(true);
    try {
      const id = inst.id || cryptoRandomId();
      await api.putInstance(serviceName, id, {
        id,
        address: inst.address,
        version: inst.version?.trim() || undefined,
        interfaces: inst.interfaces,
        weight: inst.weight,
        status: inst.status,
        ttlSeconds: inst.ttlSeconds,
        checkMode: inst.checkMode,
        checkIntervalSec: inst.checkIntervalSec,
        metadata: inst.metadata,
      });
      toast.success(isNew ? "Instance created" : "Instance updated");
      onSaved();
    } catch (e: any) { toast.error(e.message); }
    finally { setSaving(false); }
  }

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{isNew ? "New instance" : "Edit instance"}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {!isNew && (
            <div className="md:col-span-2">
              <Label htmlFor="inst-id">Instance ID</Label>
              <Input id="inst-id" value={inst.id} disabled className="font-mono text-xs" />
            </div>
          )}
          <div>
            <Label htmlFor="inst-addr">Address (host or IP)</Label>
            <Input id="inst-addr" value={inst.address}
              onChange={e => update("address", e.target.value)}
              placeholder="10.0.0.5 or service.internal" autoFocus={isNew} />
          </div>
          <div>
            <Label htmlFor="inst-version">Version</Label>
            <Input id="inst-version" value={inst.version ?? ""}
              onChange={e => update("version", e.target.value)}
              placeholder="2.1.0" className="font-mono" />
            <p className="text-xs text-fg-subtle mt-1">Semver enables <code>ver&gt;=2.1.0</code> queries.</p>
          </div>
          <div>
            <Label htmlFor="inst-weight">Weight</Label>
            <Input id="inst-weight" type="number" min={0} value={inst.weight}
              onChange={e => update("weight", parseInt(e.target.value) || 0)} />
          </div>
          <div>
            <Label>Status</Label>
            <Select value={inst.status || "up"} onValueChange={v => update("status", v as Instance["status"])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="up">up</SelectItem>
                <SelectItem value="starting">starting</SelectItem>
                <SelectItem value="draining">draining</SelectItem>
                <SelectItem value="down">down</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Liveness check</Label>
            <Select value={inst.checkMode || "heartbeat"} onValueChange={v => update("checkMode", v as CheckMode)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="heartbeat">heartbeat — service sends pings</SelectItem>
                <SelectItem value="http">http — discovery probes HealthURL</SelectItem>
                <SelectItem value="tcp">tcp — discovery TCP-connects</SelectItem>
                <SelectItem value="none">none — never auto-mark down</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>
              {(inst.checkMode === "http" || inst.checkMode === "tcp")
                ? "Probe interval (s)" : "Heartbeat TTL (s)"}
            </Label>
            {(inst.checkMode === "http" || inst.checkMode === "tcp") ? (
              <Input type="number" min={1}
                value={inst.checkIntervalSec || 15}
                onChange={e => update("checkIntervalSec", parseInt(e.target.value) || 0)} />
            ) : (
              <Input type="number" min={0} value={inst.ttlSeconds}
                onChange={e => update("ttlSeconds", parseInt(e.target.value) || 0)} />
            )}
          </div>
        </div>

        <div className="mt-2 pt-4 border-t border-border">
          <div className="flex items-center justify-between mb-2">
            <Label className="!mb-0">Interfaces</Label>
            <Button variant="ghost" size="sm" leftIcon={<Plus className="size-3.5" />} onClick={addIface}>Add</Button>
          </div>
          <div className="space-y-2">
            {inst.interfaces.length === 0 && (
              <div className="text-sm text-fg-muted">No interfaces. Add one (e.g. WEB http:8080).</div>
            )}
            {inst.interfaces.map((it, idx) => {
              const isHTTPish = ["http", "https", "ws", "wss"].includes(it.protocol);
              return (
                <div key={idx} className="rounded-[var(--radius-md)] border border-border p-3 space-y-2">
                  <div className="grid grid-cols-12 gap-2 items-end">
                    <div className="col-span-3">
                      <Label className="text-xs">Name</Label>
                      <Input value={it.name}
                        onChange={e => updateIface(idx, { name: e.target.value })}
                        placeholder="WEB / WS / GRPC" />
                    </div>
                    <div className="col-span-3">
                      <Label className="text-xs">Protocol</Label>
                      <Select value={it.protocol}
                        onValueChange={v => updateIface(idx, { protocol: v })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="http">http</SelectItem>
                          <SelectItem value="https">https</SelectItem>
                          <SelectItem value="ws">ws</SelectItem>
                          <SelectItem value="wss">wss</SelectItem>
                          <SelectItem value="tcp">tcp</SelectItem>
                          <SelectItem value="grpc">grpc</SelectItem>
                          <SelectItem value="udp">udp</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="col-span-2">
                      <Label className="text-xs">Port</Label>
                      <Input type="number" value={it.port}
                        onChange={e => updateIface(idx, { port: parseInt(e.target.value) || 0 })} />
                    </div>
                    <div className="col-span-3">
                      <Label className="text-xs">Path</Label>
                      <Input value={it.path || ""}
                        onChange={e => updateIface(idx, { path: e.target.value })}
                        placeholder="/api" />
                    </div>
                    <div className="col-span-1 pb-1.5 flex justify-end">
                      <Button variant="ghost" size="icon" onClick={() => removeIface(idx)}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                  {isHTTPish && (
                    <div>
                      <Label className="text-xs">Health-check URL <span className="text-fg-subtle">(optional)</span></Label>
                      <Input value={it.healthUrl || ""}
                        onChange={e => updateIface(idx, { healthUrl: e.target.value })}
                        placeholder="/healthz, or full https://other.host/health" />
                      <div className="text-[11px] text-fg-muted mt-1">
                        Leave empty to probe the main address — any 2xx/3xx counts as up.
                        Use a full URL to point at a different host (e.g. behind a reverse proxy).
                      </div>
                    </div>
                  )}
                  <label className="flex items-center gap-2 mt-1">
                    <Checkbox checked={!!it.tls}
                      onCheckedChange={v => updateIface(idx, { tls: v === true })} />
                    <span className="text-xs text-fg-muted">
                      Force TLS (use https/wss even when protocol is http/ws)
                    </span>
                  </label>
                </div>
              );
            })}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} loading={saving}>{isNew ? "Create" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function cryptoRandomId(): string {
  if (crypto && "randomUUID" in crypto) return crypto.randomUUID();
  return "id-" + Math.random().toString(36).slice(2, 12);
}
