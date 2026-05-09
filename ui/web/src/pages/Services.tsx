import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Plus } from "lucide-react";
import { api, Service, watch } from "@/lib/api";
import {
  Badge, Button, Card, CardContent,
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
  Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui";
import { toast } from "sonner";

export default function Services() {
  const [services, setServices] = useState<Service[]>([]);
  const [counts, setCounts] = useState<Record<string, { up: number; total: number }>>({});
  const [loading, setLoading] = useState(true);
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
    } catch (e: any) {
      toast.error(e.message);
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
      toast.success(`Service "${newName.trim()}" created`);
      setNewName(""); setNewDesc(""); setNewVisibility("public"); setCreating(false);
      refresh();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Services</h1>
          <p className="text-sm text-fg-muted mt-1">{services.length} registered</p>
        </div>
        <Button leftIcon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
          New service
        </Button>
      </div>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New service</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="svc-name">Name</Label>
              <Input id="svc-name" value={newName}
                onChange={e => setNewName(e.target.value)} placeholder="e.g. billing" autoFocus />
            </div>
            <div>
              <Label htmlFor="svc-desc">Description</Label>
              <Input id="svc-desc" value={newDesc}
                onChange={e => setNewDesc(e.target.value)} placeholder="optional" />
            </div>
            <div>
              <Label>Visibility</Label>
              <Select value={newVisibility} onValueChange={v => setNewVisibility(v as "public" | "private")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="public">public — anyone can edit</SelectItem>
                  <SelectItem value="private">private — only owner / admin / granted</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            <Button onClick={create}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {loading ? (
        <div className="text-fg-muted">Loading…</div>
      ) : services.length === 0 ? (
        <Card>
          <CardContent className="text-center text-fg-muted py-12">
            No services yet. Click <strong>New service</strong> to add one,
            or register one via the API / client library.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {services.map(s => (
            <Link to={`/services/${encodeURIComponent(s.name)}`} key={s.name}
                  className="group rounded-[var(--radius-lg)]">
              <Card className="hover:border-accent/50 transition-colors h-full">
                <CardContent className="pt-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold truncate">{s.name}</span>
                        <VisibilityBadge v={s.visibility} />
                      </div>
                      {s.description && <div className="text-sm text-fg-muted truncate mt-1">{s.description}</div>}
                    </div>
                    <CountBadge c={counts[s.name]} />
                  </div>
                  {s.tags && s.tags.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1">
                      {s.tags.map(t => <Badge key={t} variant="neutral" size="sm">{t}</Badge>)}
                    </div>
                  )}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function VisibilityBadge({ v }: { v?: string }) {
  if (v === "private") return <Badge variant="warning" size="sm">private</Badge>;
  return <Badge variant="neutral" size="sm">public</Badge>;
}

function CountBadge({ c }: { c?: { up: number; total: number } }) {
  if (!c) return <Badge variant="neutral" size="sm">—</Badge>;
  if (c.total === 0) return <Badge variant="neutral" size="sm">no instances</Badge>;
  if (c.up === c.total) return <Badge variant="success" size="sm" dot>{c.up}/{c.total} up</Badge>;
  if (c.up === 0) return <Badge variant="danger" size="sm" dot>0/{c.total} up</Badge>;
  return <Badge variant="warning" size="sm" dot>{c.up}/{c.total} up</Badge>;
}
