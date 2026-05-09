import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { api, CheckMode, CheckResponse, Instance, Interface, ProbeResult, Service, User, Visibility, watch } from "@/lib/api";
import { StatusBadge } from "@/components/StatusBadge";
import { useAuth } from "@/lib/auth";
import { VisibilityBadge } from "./Services";

export default function ServiceDetail() {
  const { name = "" } = useParams();
  const navigate = useNavigate();
  const { me } = useAuth();
  const [service, setService] = useState<Service | null>(null);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [allUsers, setAllUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingInst, setEditingInst] = useState<Instance | null>(null);
  const [editingMeta, setEditingMeta] = useState(false);

  async function refresh() {
    try {
      const [svc, insts] = await Promise.all([
        api.getService(name),
        api.listInstances(name),
      ]);
      setService(svc);
      setInstances(insts);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }

  useEffect(() => {
    refresh();
    const stop = watch(ev => { if (ev.service === name) refresh(); });
    return stop;
  }, [name]);

  // Admins can list users; non-admins can't, so we fall back to a free-text user-id input.
  useEffect(() => {
    if (me?.isAdmin) {
      api.listUsers().then(setAllUsers).catch(() => setAllUsers(null));
    }
  }, [me?.isAdmin]);

  // Permission check mirrors the server: admin OR owner OR (public + authenticated) OR grant.
  const canEdit = useMemo(() => {
    if (!service || !me) return false;
    if (me.isAdmin) return true;
    if ((service.visibility ?? "public") === "public") return !!me.userId;
    if (service.ownerId && service.ownerId === me.userId) return true;
    return (service.grants ?? []).includes(me.userId ?? "");
  }, [service, me]);

  // Only admin or service owner can manage grants.
  const canManageGrants = useMemo(() => {
    if (!service || !me) return false;
    if (me.isAdmin) return true;
    return service.ownerId === me.userId;
  }, [service, me]);

  async function deleteService() {
    if (!confirm(`Delete service "${name}" and all its instances?`)) return;
    try {
      await api.deleteService(name);
      navigate("/");
    } catch (e: any) { setError(e.message); }
  }

  async function deleteInstance(id: string) {
    if (!confirm(`Delete instance ${id}?`)) return;
    try {
      await api.deleteInstance(name, id);
      refresh();
    } catch (e: any) { setError(e.message); }
  }

  // Per-instance manual check state — keep results in a map so multiple
  // instances can show their last result simultaneously.
  const [checking, setChecking] = useState<Record<string, boolean>>({});
  const [checkResults, setCheckResults] = useState<Record<string, CheckResponse>>({});

  async function checkNow(id: string) {
    setChecking(p => ({ ...p, [id]: true }));
    try {
      const r = await api.checkInstance(name, id);
      setCheckResults(p => ({ ...p, [id]: r }));
    } catch (e: any) {
      setCheckResults(p => ({
        ...p,
        [id]: { ok: false, status: "down", mode: "http", results: [{ interface: "(error)", ok: false, error: e.message, latencyMs: 0 }] },
      }));
    } finally {
      setChecking(p => ({ ...p, [id]: false }));
      refresh();
    }
  }

  function copyInstance(inst: Instance) {
    setEditingInst({
      ...inst,
      id: "",                  // fresh ID will be generated on save
      address: inst.address,   // pre-filled — user changes if they want
      lastHeartbeat: "",
      registeredAt: "",
      updatedAt: "",
    });
  }

  async function saveMeta(patch: Partial<Service>) {
    if (!service) return;
    try {
      await api.putService(service.name, {
        description: patch.description ?? service.description,
        visibility: patch.visibility ?? service.visibility,
        tags: service.tags,
        metadata: service.metadata,
      });
      setEditingMeta(false);
      refresh();
    } catch (e: any) { setError(e.message); }
  }

  async function renameService(newName: string) {
    if (!service || !newName || newName === service.name) return;
    try {
      const renamed = await api.renameService(service.name, newName);
      setEditingMeta(false);
      navigate(`/services/${encodeURIComponent(renamed.name)}`, { replace: true });
    } catch (e: any) { setError(e.message); }
  }

  async function addGrant(userId: string) {
    try {
      await api.addGrant(name, userId);
      refresh();
    } catch (e: any) { setError(e.message); }
  }

  async function removeGrant(userId: string) {
    try {
      await api.removeGrant(name, userId);
      refresh();
    } catch (e: any) { setError(e.message); }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <Link to="/" className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">← Services</Link>
        <div className="flex items-end justify-between gap-3 mt-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-semibold tracking-tight truncate">{name}</h1>
              <VisibilityBadge v={service?.visibility} />
              {!canEdit && <span className="badge text-xs">read-only for you</span>}
            </div>
            {service?.description && <div className="text-sm text-zinc-500 mt-1">{service.description}</div>}
          </div>
          <div className="flex gap-2">
            {canEdit && (
              <>
                <button className="btn-secondary" onClick={() => setEditingMeta(true)}>Settings</button>
                <button className="btn-secondary" onClick={() => setEditingInst({
                  id: "", service: name, address: "", interfaces: [],
                  weight: 1, status: "up", ttlSeconds: 30,
                  checkMode: "heartbeat", checkIntervalSec: 15,
                  lastHeartbeat: "", registeredAt: "", updatedAt: "",
                })}>+ Instance</button>
                <button className="btn-danger" onClick={deleteService}>Delete</button>
              </>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="card mb-4 border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300 text-sm">{error}</div>
      )}

      {editingMeta && service && (
        <ServiceMetaEditor
          service={service}
          users={allUsers}
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

      <h2 className="text-sm uppercase tracking-wider text-zinc-400 dark:text-zinc-500 mb-3">
        Instances ({instances.length})
      </h2>

      {instances.length === 0 ? (
        <div className="card text-center text-zinc-500">No instances registered.</div>
      ) : (
        <div className="space-y-3">
          {instances.map(inst => (
            <div key={inst.id} className="card">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-sm truncate">{inst.address}</span>
                    <StatusBadge status={inst.status} />
                    <CheckModeBadge mode={inst.checkMode} />
                    <span className="badge">weight {inst.weight}</span>
                    {(!inst.checkMode || inst.checkMode === "heartbeat") && (
                      <span className="badge">TTL {inst.ttlSeconds}s</span>
                    )}
                  </div>
                  <div className="text-xs text-zinc-500 mt-1 font-mono truncate">id: {inst.id}</div>
                  <div className="text-xs text-zinc-500 mt-0.5">last heartbeat: {fmtTime(inst.lastHeartbeat)}</div>
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
                    <button className="btn-secondary !py-1 !text-xs"
                      disabled={checking[inst.id]}
                      onClick={() => checkNow(inst.id)}>
                      {checking[inst.id] ? "Checking…" : "Check"}
                    </button>
                    <button className="btn-secondary !py-1 !text-xs" onClick={() => setEditingInst(inst)}>Edit</button>
                    <button className="btn-secondary !py-1 !text-xs" onClick={() => copyInstance(inst)}>Copy</button>
                    <button className="btn-danger !py-1 !text-xs" onClick={() => deleteInstance(inst.id)}>Delete</button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CheckReport({ result, onDismiss }: { result: CheckResponse; onDismiss: () => void }) {
  return (
    <div className={
      "mt-3 rounded-xl border px-3 py-2 text-xs " +
      (result.ok
        ? "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200"
        : "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40 text-red-800 dark:text-red-200")
    }>
      <div className="flex items-center justify-between mb-1">
        <span className="font-semibold">
          {result.ok ? "Check passed" : "Check failed"}
          <span className="opacity-60 ml-2 font-normal">mode: {result.mode || "heartbeat"}</span>
        </span>
        <button className="btn-ghost !p-0.5 !text-xs opacity-70 hover:opacity-100" onClick={onDismiss}>✕</button>
      </div>
      <ul className="space-y-1">
        {result.results.map((r, i) => (
          <li key={i} className="font-mono break-all">
            <span className={r.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}>
              {r.ok ? "✓" : "✗"}
            </span>{" "}
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
  const cls =
    m === "heartbeat" ? "badge" :
    m === "http" || m === "tcp" ? "badge-brand" :
    "badge-warn";
  return <span className={cls + " font-mono text-[11px]"}>check: {m}</span>;
}

// findInterfaceProbe pulls the matching ProbeResult out of the instance's
// last-check report. Returns undefined when the instance has no probe history
// yet (heartbeat-only modes never populate this) so the pill falls back to
// the neutral colour rather than implying a result we don't have.
function findInterfaceProbe(inst: Instance, name: string): ProbeResult | undefined {
  return inst.lastCheck?.results?.find(r => r.interface === name);
}

function InterfacePill({ it, probe }: { it: Interface; probe?: ProbeResult }) {
  const proto = (it.tls && (it.protocol === "http" || it.protocol === "ws"))
    ? it.protocol + "s" : it.protocol;

  // Three states: known-failed (red), known-good (green), unknown (brand).
  let cls = "badge-brand";
  let title: string | undefined;
  if (probe) {
    if (probe.ok) {
      cls = "badge-success";
      title = `OK${probe.httpStatus ? ` · HTTP ${probe.httpStatus}` : ""}${probe.latencyMs ? ` · ${probe.latencyMs}ms` : ""}`;
    } else {
      cls = "badge-danger";
      title = probe.error || "FAILED";
    }
  }

  return (
    <span className={cls + " font-mono"} title={title}>
      {it.name}: {proto}:{it.port}{it.path || ""}
    </span>
  );
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

// --- meta editor (visibility + grants) ---

function ServiceMetaEditor({
  service, users, canManageGrants, onClose, onSave, onRename, onAddGrant, onRemoveGrant,
}: {
  service: Service;
  users: User[] | null;
  canManageGrants: boolean;
  onClose: () => void;
  onSave: (patch: Partial<Service>) => void;
  onRename: (newName: string) => void;
  onAddGrant: (userId: string) => void;
  onRemoveGrant: (userId: string) => void;
}) {
  const [name, setName] = useState(service.name);
  const [description, setDescription] = useState(service.description || "");
  const [visibility, setVisibility] = useState<Visibility>(service.visibility || "public");
  const [grantInput, setGrantInput] = useState("");

  function userLabel(id: string) {
    const u = users?.find(x => x.id === id);
    return u ? `${u.username}${u.displayName ? ` (${u.displayName})` : ""}` : id;
  }

  function handleSave() {
    // Rename is a separate, side-effecting operation (changes the resource
    // key + URL) so we run it after the regular save and let it own the
    // navigation. Doing them in one click matches user intent.
    onSave({ description, visibility });
    if (name.trim() && name.trim() !== service.name) {
      onRename(name.trim());
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-start justify-center p-6 overflow-y-auto">
      <div className="card w-full max-w-xl my-8" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Service settings</h2>
          <button className="btn-ghost !p-1" onClick={onClose}>✕</button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="label">Name</label>
            <input className="input" value={name} onChange={e => setName(e.target.value)} />
            {name.trim() !== service.name && (
              <div className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                Renaming moves all instances under the new name.
              </div>
            )}
          </div>
          <div>
            <label className="label">Description</label>
            <input className="input" value={description} onChange={e => setDescription(e.target.value)} />
          </div>
          <div>
            <label className="label">Visibility</label>
            <select className="input" value={visibility}
              onChange={e => setVisibility(e.target.value as Visibility)}>
              <option value="public">public — anyone can edit</option>
              <option value="private">private — only owner / admin / granted</option>
            </select>
          </div>
        </div>

        <div className="mt-5 pt-5 border-t border-zinc-200 dark:border-zinc-800">
          <h3 className="text-sm font-semibold mb-2">Owner & access</h3>
          <div className="text-xs text-zinc-500 mb-3">
            Owner: <span className="font-mono">{service.ownerId ? userLabel(service.ownerId) : "system"}</span>
          </div>
          <div>
            <label className="label">Granted users</label>
            {(service.grants || []).length === 0 ? (
              <div className="text-sm text-zinc-500 mb-2">No additional users have edit access.</div>
            ) : (
              <ul className="space-y-1 mb-3">
                {(service.grants || []).map(uid => (
                  <li key={uid} className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg bg-zinc-50 dark:bg-zinc-800/50">
                    <span className="font-mono text-sm">{userLabel(uid)}</span>
                    {canManageGrants && (
                      <button className="btn-ghost !py-0.5 !px-1 !text-xs" onClick={() => onRemoveGrant(uid)}>remove</button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canManageGrants && (
              <div className="flex gap-2">
                {users ? (
                  <select className="input" value={grantInput} onChange={e => setGrantInput(e.target.value)}>
                    <option value="">— select user —</option>
                    {users.filter(u => u.id !== service.ownerId && !(service.grants || []).includes(u.id))
                          .map(u => (
                            <option key={u.id} value={u.id}>{u.username}</option>
                          ))}
                  </select>
                ) : (
                  <input className="input" placeholder="user id"
                    value={grantInput} onChange={e => setGrantInput(e.target.value)} />
                )}
                <button className="btn-secondary"
                  onClick={() => { if (grantInput) { onAddGrant(grantInput); setGrantInput(""); } }}>
                  Grant
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="mt-6 flex gap-2 justify-end">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  );
}

// --- instance editor ---

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
  const [err, setErr] = useState<string | null>(null);
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
    setSaving(true); setErr(null);
    try {
      const id = inst.id || cryptoRandomId();
      // Send only writable fields — managed timestamps must not appear here
      // because the server json-decodes them as time.Time and would reject "".
      await api.putInstance(serviceName, id, {
        id,
        address: inst.address,
        interfaces: inst.interfaces,
        weight: inst.weight,
        status: inst.status,
        ttlSeconds: inst.ttlSeconds,
        checkMode: inst.checkMode,
        checkIntervalSec: inst.checkIntervalSec,
        metadata: inst.metadata,
      });
      onSaved();
    } catch (e: any) { setErr(e.message); }
    finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-start justify-center p-6 overflow-y-auto">
      <div className="card w-full max-w-2xl my-8" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">{isNew ? "New instance" : "Edit instance"}</h2>
          <button className="btn-ghost !p-1" onClick={onClose}>✕</button>
        </div>
        {err && <div className="text-red-600 dark:text-red-400 text-sm mb-3">{err}</div>}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {!isNew && (
            <div className="md:col-span-2">
              <label className="label">Instance ID</label>
              <input className="input font-mono text-xs" value={inst.id} disabled />
            </div>
          )}
          <div className="md:col-span-2">
            <label className="label">Address (host or IP)</label>
            <input className="input" value={inst.address}
              onChange={e => update("address", e.target.value)}
              placeholder="10.0.0.5 or service.internal" autoFocus={isNew}/>
          </div>
          <div>
            <label className="label">Weight</label>
            <input type="number" className="input" min={0} value={inst.weight}
              onChange={e => update("weight", parseInt(e.target.value) || 0)} />
          </div>
          <div>
            <label className="label">Status</label>
            <select className="input" value={inst.status}
              onChange={e => update("status", e.target.value as Instance["status"])}>
              <option value="up">up</option>
              <option value="starting">starting</option>
              <option value="draining">draining</option>
              <option value="down">down</option>
            </select>
          </div>

          <div>
            <label className="label">Liveness check</label>
            <select className="input" value={inst.checkMode || "heartbeat"}
              onChange={e => update("checkMode", e.target.value as CheckMode)}>
              <option value="heartbeat">heartbeat — service sends pings</option>
              <option value="http">http — discovery probes HealthURL</option>
              <option value="tcp">tcp — discovery TCP-connects to first interface</option>
              <option value="none">none — never auto-mark down</option>
            </select>
          </div>
          <div>
            <label className="label">
              {(inst.checkMode === "http" || inst.checkMode === "tcp")
                ? "Probe interval (s)" : "Heartbeat TTL (s)"}
            </label>
            {(inst.checkMode === "http" || inst.checkMode === "tcp") ? (
              <input type="number" className="input" min={1}
                value={inst.checkIntervalSec || 15}
                onChange={e => update("checkIntervalSec", parseInt(e.target.value) || 0)} />
            ) : (
              <input type="number" className="input" min={0} value={inst.ttlSeconds}
                onChange={e => update("ttlSeconds", parseInt(e.target.value) || 0)} />
            )}
          </div>
        </div>
        <div className="mt-5">
          <div className="flex items-center justify-between mb-2">
            <label className="label !mb-0">Interfaces</label>
            <button className="btn-ghost !py-1 !text-xs" onClick={addIface}>+ Add</button>
          </div>
          <div className="space-y-2">
            {inst.interfaces.length === 0 && (
              <div className="text-sm text-zinc-500">No interfaces. Add one (e.g. WEB http:8080).</div>
            )}
            {inst.interfaces.map((it, idx) => {
              const isHTTPish = ["http", "https", "ws", "wss"].includes(it.protocol);
              return (
              <div key={idx} className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-3 space-y-2">
                <div className="grid grid-cols-12 gap-2 items-end">
                  <div className="col-span-3">
                    <label className="label text-xs">Name</label>
                    <input className="input !py-1.5" value={it.name}
                      onChange={e => updateIface(idx, { name: e.target.value })}
                      placeholder="WEB / WS / GRPC" />
                  </div>
                  <div className="col-span-3">
                    <label className="label text-xs">Protocol</label>
                    <select className="input !py-1.5" value={it.protocol}
                      onChange={e => updateIface(idx, { protocol: e.target.value })}>
                      <option value="http">http</option>
                      <option value="https">https</option>
                      <option value="ws">ws</option>
                      <option value="wss">wss</option>
                      <option value="tcp">tcp</option>
                      <option value="grpc">grpc</option>
                      <option value="udp">udp</option>
                    </select>
                  </div>
                  <div className="col-span-2">
                    <label className="label text-xs">Port</label>
                    <input type="number" className="input !py-1.5" value={it.port}
                      onChange={e => updateIface(idx, { port: parseInt(e.target.value) || 0 })} />
                  </div>
                  <div className="col-span-3">
                    <label className="label text-xs">Path</label>
                    <input className="input !py-1.5" value={it.path || ""}
                      onChange={e => updateIface(idx, { path: e.target.value })}
                      placeholder="/api" />
                  </div>
                  <div className="col-span-1 pb-1.5 flex justify-end">
                    <button className="btn-ghost !p-1.5" onClick={() => removeIface(idx)} title="remove">✕</button>
                  </div>
                </div>
                {isHTTPish && (
                  <div>
                    <label className="label text-xs">Health-check URL <span className="text-zinc-400">(optional)</span></label>
                    <input className="input !py-1.5" value={it.healthUrl || ""}
                      onChange={e => updateIface(idx, { healthUrl: e.target.value })}
                      placeholder="/healthz, or full https://other.host/health" />
                    <div className="text-[11px] text-zinc-500 mt-1">
                      Leave empty to probe the main address — any 2xx/3xx counts as up.
                      Use a full URL to point at a different host (e.g. behind a reverse proxy).
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <input type="checkbox" id={`tls-${idx}`} checked={!!it.tls}
                    onChange={e => updateIface(idx, { tls: e.target.checked })} />
                  <label htmlFor={`tls-${idx}`} className="text-xs text-zinc-600 dark:text-zinc-400">
                    Force TLS (use https/wss even when protocol is http/ws)
                  </label>
                </div>
              </div>
              );
            })}
          </div>
        </div>
        <div className="mt-6 flex gap-2 justify-end">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : isNew ? "Create" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function cryptoRandomId(): string {
  if (crypto && "randomUUID" in crypto) return crypto.randomUUID();
  return "id-" + Math.random().toString(36).slice(2, 12);
}
