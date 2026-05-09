import { useEffect, useState } from "react";
import { Plug } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from "@/components/ui";

export default function Cluster() {
  const { me } = useAuth();
  const [members, setMembers] = useState<string[]>([]);
  const [seedInput, setSeedInput] = useState("");
  const [joining, setJoining] = useState(false);

  async function refresh() {
    try {
      setMembers(await api.members());
    } catch (e: any) {
      toast.error(e.message);
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
    setJoining(true);
    try {
      const r = await api.joinCluster(seeds);
      toast.success(`Contacted ${r.contacted} peer${r.contacted === 1 ? "" : "s"}`);
      setSeedInput("");
      refresh();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setJoining(false);
    }
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-2xl font-semibold tracking-tight mb-6">Cluster members</h1>

      {members.length === 0 ? (
        <Card>
          <CardContent className="text-center text-fg-muted py-8">
            Single-node mode (no peers detected). Set <code className="font-mono text-xs px-1.5 py-0.5 rounded bg-surface">DISCOVERY_SEEDS</code> on at least two nodes
            {me?.isAdmin && <> or use the form below to join a peer at runtime</>}.
          </CardContent>
        </Card>
      ) : (
        <Card className="mb-4">
          <CardContent className="pt-4">
            <ul className="divide-y divide-border">
              {members.map(m => (
                <li key={m} className="py-2 font-mono text-sm flex items-center gap-2">
                  <span className="size-2 rounded-full bg-success" />
                  {m}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {me?.isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Join a peer</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-xs text-fg-muted mb-3">
              Comma-separated <code className="font-mono px-1.5 py-0.5 rounded bg-surface">host:port</code> of peer gossip endpoints
              (the <code className="font-mono px-1.5 py-0.5 rounded bg-surface">DISCOVERY_GOSSIP_PORT</code> on the other node, default <code className="font-mono px-1.5 py-0.5 rounded bg-surface">7946</code>).
            </p>
            <div className="flex gap-2">
              <Input className="flex-1" placeholder="10.0.0.6:7946, 10.0.0.7:7946"
                value={seedInput} onChange={e => setSeedInput(e.target.value)} />
              <Button leftIcon={<Plug className="size-4" />} loading={joining}
                disabled={!seedInput.trim()} onClick={join}>
                Join
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
