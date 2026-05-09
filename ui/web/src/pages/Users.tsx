import { useEffect, useState } from "react";
import { Plus, Trash2, Pencil } from "lucide-react";
import { toast } from "sonner";
import { api, User } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  Badge, Button, Card, CardContent, Checkbox,
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
  Input, Label,
} from "@/components/ui";

type Draft = {
  id?: string;
  username: string;
  displayName: string;
  password: string;
  isAdmin: boolean;
};

const blankDraft: Draft = { username: "", displayName: "", password: "", isAdmin: false };

export default function Users() {
  const { me } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [pendingDelete, setPendingDelete] = useState<User | null>(null);

  async function refresh() {
    try {
      setUsers(await api.listUsers());
    } catch (e: any) {
      toast.error(e.message);
    }
  }
  useEffect(() => { refresh(); }, []);

  async function save(d: Draft) {
    try {
      if (d.id) {
        const patch: any = {
          username: d.username,
          displayName: d.displayName,
          isAdmin: d.isAdmin,
        };
        if (d.password) patch.password = d.password;
        await api.updateUser(d.id, patch);
        toast.success(`User "${d.username}" updated`);
      } else {
        await api.createUser({
          username: d.username,
          displayName: d.displayName,
          password: d.password,
          isAdmin: d.isAdmin,
        });
        toast.success(`User "${d.username}" created`);
      }
      setEditing(null);
      refresh();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function remove(u: User) {
    try {
      await api.deleteUser(u.id);
      toast.success(`User "${u.username}" deleted`);
      setPendingDelete(null);
      refresh();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
          <p className="text-sm text-fg-muted mt-1">{users.length} accounts</p>
        </div>
        <Button leftIcon={<Plus className="size-4" />} onClick={() => setEditing({ ...blankDraft })}>
          New user
        </Button>
      </div>

      {editing && <UserEditor draft={editing} onClose={() => setEditing(null)} onSave={save} />}

      <Dialog open={!!pendingDelete} onOpenChange={open => !open && setPendingDelete(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Delete user</DialogTitle></DialogHeader>
          <p className="text-sm text-fg-muted">
            Permanently delete user <span className="font-mono">{pendingDelete?.username}</span>?
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => pendingDelete && remove(pendingDelete)}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card className="overflow-hidden">
        <CardContent className="!p-0">
          <table className="w-full text-sm">
            <thead className="bg-surface text-fg-muted">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Username</th>
                <th className="text-left px-4 py-3 font-medium">Display name</th>
                <th className="text-left px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {users.map(u => (
                <tr key={u.id}>
                  <td className="px-4 py-3 font-mono">{u.username}</td>
                  <td className="px-4 py-3">{u.displayName || "—"}</td>
                  <td className="px-4 py-3">
                    {u.isAdmin
                      ? <Badge variant="brand" size="sm">admin</Badge>
                      : <Badge variant="neutral" size="sm">user</Badge>}
                    {u.id === me?.userId && <span className="ml-2 text-xs text-fg-subtle">(you)</span>}
                  </td>
                  <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                    <Button variant="ghost" size="sm" leftIcon={<Pencil className="size-3.5" />}
                      onClick={() => setEditing({
                        id: u.id,
                        username: u.username,
                        displayName: u.displayName || "",
                        password: "",
                        isAdmin: u.isAdmin,
                      })}>Edit</Button>
                    <Button variant="ghost" size="sm" leftIcon={<Trash2 className="size-3.5" />}
                      disabled={u.id === me?.userId}
                      onClick={() => setPendingDelete(u)}>Delete</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function UserEditor({ draft, onClose, onSave }: {
  draft: Draft;
  onClose: () => void;
  onSave: (d: Draft) => void;
}) {
  const [d, setD] = useState<Draft>(draft);
  const isNew = !d.id;

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isNew ? "New user" : `Edit ${draft.username}`}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="user-username">Username</Label>
            <Input id="user-username" value={d.username}
              onChange={e => setD({ ...d, username: e.target.value })}
              autoFocus={isNew} />
          </div>
          <div>
            <Label htmlFor="user-display">Display name</Label>
            <Input id="user-display" value={d.displayName}
              onChange={e => setD({ ...d, displayName: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="user-pass">{isNew ? "Password" : "New password (leave blank to keep)"}</Label>
            <Input id="user-pass" type="password" value={d.password}
              onChange={e => setD({ ...d, password: e.target.value })} />
          </div>
          <label className="flex items-center gap-2 mt-2">
            <Checkbox checked={d.isAdmin}
              onCheckedChange={v => setD({ ...d, isAdmin: v === true })} />
            <span className="text-sm">Administrator</span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onSave(d)}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
