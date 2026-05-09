import { useEffect, useState } from "react";
import { api, AuditEntry } from "@/lib/api";

export default function Audit() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [showRaw, setShowRaw] = useState<string | null>(null);

  async function refresh() {
    try {
      setEntries(await api.listAudit(500, filter || undefined));
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [filter]);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
          <p className="text-sm text-zinc-500 mt-1">Most recent {entries.length} entries</p>
        </div>
        <div className="flex items-center gap-2">
          <input className="input !py-1.5 w-56" placeholder="Filter by service…"
            value={filter} onChange={e => setFilter(e.target.value)} />
          <button className="btn-secondary" onClick={refresh}>Refresh</button>
        </div>
      </div>

      {error && (
        <div className="card mb-4 border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300 text-sm">{error}</div>
      )}

      <div className="card !p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-400">
            <tr>
              <th className="text-left px-4 py-3 font-medium">When</th>
              <th className="text-left px-4 py-3 font-medium">Actor</th>
              <th className="text-left px-4 py-3 font-medium">Action</th>
              <th className="text-left px-4 py-3 font-medium">Target</th>
              <th className="text-left px-4 py-3 font-medium">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {entries.map(e => (
              <tr key={e.id}>
                <td className="px-4 py-2 whitespace-nowrap font-mono text-xs text-zinc-500">{fmt(e.timestamp)}</td>
                <td className="px-4 py-2">{e.actorName || e.actorId || "—"}</td>
                <td className="px-4 py-2"><ActionBadge action={e.action} /></td>
                <td className="px-4 py-2 font-mono text-xs">{e.target || "—"}</td>
                <td className="px-4 py-2">
                  {e.details && Object.keys(e.details).length > 0 ? (
                    <button className="btn-ghost !py-0.5 !px-1 !text-xs"
                      onClick={() => setShowRaw(JSON.stringify(e.details, null, 2))}>
                      view
                    </button>
                  ) : <span className="text-zinc-400">—</span>}
                </td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-12 text-center text-zinc-500">No entries</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showRaw && (
        <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-6">
          <div className="card max-w-2xl max-h-[80vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold">Details</h3>
              <button className="btn-ghost !p-1" onClick={() => setShowRaw(null)}>✕</button>
            </div>
            <pre className="font-mono text-xs whitespace-pre-wrap">{showRaw}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

function ActionBadge({ action }: { action: string }) {
  const cls =
    action.includes("deleted") ? "badge-danger" :
    action.includes("created") || action.includes("upserted") ? "badge-success" :
    action.includes("login") || action.includes("logout") ? "badge-brand" :
    "badge";
  return <span className={cls + " font-mono"}>{action}</span>;
}

function fmt(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
