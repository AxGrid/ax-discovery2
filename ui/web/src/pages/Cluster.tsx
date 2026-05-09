import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function Cluster() {
  const { me } = useAuth();
  const [members, setMembers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [seedInput, setSeedInput] = useState("");
  const [joining, setJoining] = useState(false);

  async function refresh() {
    try {
      const m = await api.members();
      setMembers(m);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  async function join() {
    const seeds = seedInput.split(",").map(s => s.trim()).filter(Boolean);
    if (seeds.length === 0) return;
    setJoining(true); setError(null); setInfo(null);
    try {
      const r = await api.joinCluster(seeds);
      setInfo(`Contacted ${r.contacted} peer${r.contacted === 1 ? "" : "s"}.`);
      setSeedInput("");
      refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setJoining(false);
    }
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-2xl font-semibold tracking-tight mb-6">Cluster members</h1>
      {error && <div className="card mb-4 border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300 text-sm">{error}</div>}
      {info && <div className="card mb-4 border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 text-sm">{info}</div>}

      {members.length === 0 ? (
        <div className="card text-center text-zinc-500 mb-4">
          Single-node mode (no peers detected). Set <code className="kbd">DISCOVERY_SEEDS</code> on at least two nodes
          {me?.isAdmin && <> or use the form below to join a peer at runtime</>}.
        </div>
      ) : (
        <div className="card mb-4">
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {members.map(m => (
              <li key={m} className="py-2 font-mono text-sm flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                {m}
              </li>
            ))}
          </ul>
        </div>
      )}

      {me?.isAdmin && (
        <div className="card">
          <h2 className="text-sm font-semibold mb-1">Join a peer</h2>
          <p className="text-xs text-zinc-500 mb-3">
            Comma-separated <code className="kbd">host:port</code> of peer gossip endpoints
            (the <code className="kbd">DISCOVERY_GOSSIP_PORT</code> on the other node, default <code className="kbd">7946</code>).
          </p>
          <div className="flex gap-2">
            <input className="input" placeholder="10.0.0.6:7946, 10.0.0.7:7946"
              value={seedInput} onChange={e => setSeedInput(e.target.value)} />
            <button className="btn-primary" onClick={join} disabled={joining || !seedInput.trim()}>
              {joining ? "Joining…" : "Join"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
