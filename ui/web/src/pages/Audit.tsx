import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, AuditEntry } from "@/lib/api";
import { toast } from "sonner";
import {
  Badge, Button, Card, CardContent,
  Dialog, DialogContent, DialogHeader, DialogTitle,
  Input,
} from "@/components/ui";

export default function Audit() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [showRaw, setShowRaw] = useState<string | null>(null);

  async function refresh() {
    try {
      setEntries(await api.listAudit(500, filter || undefined));
    } catch (e: any) {
      toast.error(e.message);
    }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [filter]);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
          <p className="text-sm text-fg-muted mt-1">Most recent {entries.length} entries</p>
        </div>
        <div className="flex items-center gap-2">
          <Input className="w-56" placeholder="Filter by service…"
            value={filter} onChange={e => setFilter(e.target.value)} />
          <Button variant="secondary" leftIcon={<RefreshCw className="size-4" />} onClick={refresh}>Refresh</Button>
        </div>
      </div>

      <Card className="overflow-hidden">
        <CardContent className="!p-0">
          <table className="w-full text-sm">
            <thead className="bg-surface text-fg-muted">
              <tr>
                <th className="text-left px-4 py-3 font-medium">When</th>
                <th className="text-left px-4 py-3 font-medium">Actor</th>
                <th className="text-left px-4 py-3 font-medium">Action</th>
                <th className="text-left px-4 py-3 font-medium">Target</th>
                <th className="text-left px-4 py-3 font-medium">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {entries.map(e => (
                <tr key={e.id}>
                  <td className="px-4 py-2 whitespace-nowrap font-mono text-xs text-fg-muted">{fmt(e.timestamp)}</td>
                  <td className="px-4 py-2">{e.actorName || e.actorId || "—"}</td>
                  <td className="px-4 py-2"><ActionBadge action={e.action} /></td>
                  <td className="px-4 py-2 font-mono text-xs">{e.target || "—"}</td>
                  <td className="px-4 py-2">
                    {e.details && Object.keys(e.details).length > 0 ? (
                      <Button variant="ghost" size="sm"
                        onClick={() => setShowRaw(JSON.stringify(e.details, null, 2))}>view</Button>
                    ) : <span className="text-fg-subtle">—</span>}
                  </td>
                </tr>
              ))}
              {entries.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-12 text-center text-fg-muted">No entries</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Dialog open={!!showRaw} onOpenChange={open => !open && setShowRaw(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Details</DialogTitle></DialogHeader>
          <pre className="font-mono text-xs whitespace-pre-wrap max-h-[60vh] overflow-auto bg-surface rounded-[var(--radius-md)] p-3">{showRaw}</pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ActionBadge({ action }: { action: string }) {
  const variant: any =
    action.includes("deleted") ? "danger" :
    action.includes("created") || action.includes("upserted") ? "success" :
    action.includes("login") || action.includes("logout") ? "brand" :
    "neutral";
  return <Badge variant={variant} size="sm" className="font-mono">{action}</Badge>;
}

function fmt(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
