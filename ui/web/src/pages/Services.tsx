import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, Service, watch } from "@/lib/api";

export default function Services() {
  const [services, setServices] = useState<Service[]>([]);
  const [counts, setCounts] = useState<Record<string, { up: number; total: number }>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newVisibility, setNewVisibility] = useState<"public" | "private">("public");

  async function refresh() {
    try {
      const svcs = await api.listServices();
      setServices(svcs);
      const c: Record<string, { up: number; total: number }> = {};
      await Promise.all(svcs.map(async s => {
        try {
          const insts = await api.listInstances(s.name);
          c[s.name] = { total: insts.length, up: insts.filter(i => i.status === "up").length };
        } catch {
          c[s.name] = { total: 0, up: 0 };
        }
      }));
      setCounts(c);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const stop = watch(() => refresh());
    return stop;
  }, []);

  async function create() {
    if (!newName.trim()) return;
    try {
      await api.putService(newName.trim(), {
        description: newDesc.trim() || undefined,
        visibility: newVisibility,
      });
      setNewName(""); setNewDesc(""); setNewVisibility("public"); setCreating(false);
      refresh();
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Services</h1>
          <p className="text-sm text-zinc-500 mt-1">{services.length} registered</p>
        </div>
        <button className="btn-primary" onClick={() => setCreating(v => !v)}>+ New service</button>
      </div>

      {error && (
        <div className="card mb-4 border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300 text-sm">
          {error}
        </div>
      )}

      {creating && (
        <div className="card mb-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="label">Name</label>
              <input className="input" value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. billing" autoFocus />
            </div>
            <div>
              <label className="label">Description</label>
              <input className="input" value={newDesc} onChange={e => setNewDesc(e.target.value)} placeholder="optional" />
            </div>
            <div>
              <label className="label">Visibility</label>
              <select className="input" value={newVisibility}
                onChange={e => setNewVisibility(e.target.value as "public" | "private")}>
                <option value="public">public — anyone can edit</option>
                <option value="private">private — only owner / admin / granted</option>
              </select>
            </div>
          </div>
          <div className="mt-4 flex gap-2 justify-end">
            <button className="btn-ghost" onClick={() => setCreating(false)}>Cancel</button>
            <button className="btn-primary" onClick={create}>Create</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-zinc-500">Loading…</div>
      ) : services.length === 0 ? (
        <div className="card text-center text-zinc-500">
          No services yet. Click <strong>+ New service</strong> to add one,
          or register one via the API / client library.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {services.map(s => (
            <Link to={`/services/${encodeURIComponent(s.name)}`} key={s.name}
                  className="card hover:shadow-glow hover:border-brand-300 dark:hover:border-brand-500/50 transition">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold truncate">{s.name}</span>
                    <VisibilityBadge v={s.visibility} />
                  </div>
                  {s.description && <div className="text-sm text-zinc-500 truncate mt-1">{s.description}</div>}
                </div>
                <CountBadge c={counts[s.name]} />
              </div>
              {s.tags && s.tags.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {s.tags.map(t => <span key={t} className="badge">{t}</span>)}
                </div>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function VisibilityBadge({ v }: { v?: string }) {
  if (v === "private") return <span className="badge-warn">private</span>;
  return <span className="badge">public</span>;
}

function CountBadge({ c }: { c?: { up: number; total: number } }) {
  if (!c) return <span className="badge">—</span>;
  if (c.total === 0) return <span className="badge">no instances</span>;
  if (c.up === c.total) return <span className="badge-success">{c.up}/{c.total} up</span>;
  if (c.up === 0) return <span className="badge-danger">0/{c.total} up</span>;
  return <span className="badge-warn">{c.up}/{c.total} up</span>;
}
