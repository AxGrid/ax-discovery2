import { useEffect, useState } from "react";
import { api, User } from "@/lib/api";
import { useAuth } from "@/lib/auth";

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
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);

  async function refresh() {
    try {
      setUsers(await api.listUsers());
      setError(null);
    } catch (e: any) {
      setError(e.message);
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
      } else {
        await api.createUser({
          username: d.username,
          displayName: d.displayName,
          password: d.password,
          isAdmin: d.isAdmin,
        });
      }
      setEditing(null);
      refresh();
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function remove(u: User) {
    if (!confirm(`Delete user "${u.username}"?`)) return;
    try {
      await api.deleteUser(u.id);
      refresh();
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
          <p className="text-sm text-zinc-500 mt-1">{users.length} accounts</p>
        </div>
        <button className="btn-primary" onClick={() => setEditing({ ...blankDraft })}>+ New user</button>
      </div>

      {error && (
        <div className="card mb-4 border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300 text-sm">{error}</div>
      )}

      {editing && <UserEditor draft={editing} onClose={() => setEditing(null)} onSave={save} />}

      <div className="card !p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-400">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Username</th>
              <th className="text-left px-4 py-3 font-medium">Display name</th>
              <th className="text-left px-4 py-3 font-medium">Role</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {users.map(u => (
              <tr key={u.id}>
                <td className="px-4 py-3 font-mono">{u.username}</td>
                <td className="px-4 py-3">{u.displayName || "—"}</td>
                <td className="px-4 py-3">
                  {u.isAdmin
                    ? <span className="badge-brand">admin</span>
                    : <span className="badge">user</span>}
                  {u.id === me?.userId && <span className="ml-2 text-xs text-zinc-500">(you)</span>}
                </td>
                <td className="px-4 py-3 text-right space-x-2">
                  <button className="btn-ghost !py-1 !text-xs"
                    onClick={() => setEditing({
                      id: u.id,
                      username: u.username,
                      displayName: u.displayName || "",
                      password: "",
                      isAdmin: u.isAdmin,
                    })}>Edit</button>
                  <button className="btn-danger !py-1 !text-xs"
                    onClick={() => remove(u)}
                    disabled={u.id === me?.userId}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
    <div className="fixed inset-0 z-40 bg-black/40 flex items-start justify-center p-6 overflow-y-auto">
      <div className="card w-full max-w-md my-8" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">{isNew ? "New user" : `Edit ${draft.username}`}</h2>
          <button className="btn-ghost !p-1" onClick={onClose}>✕</button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="label">Username</label>
            <input className="input" value={d.username}
              onChange={e => setD({ ...d, username: e.target.value })}
              autoFocus={isNew} />
          </div>
          <div>
            <label className="label">Display name</label>
            <input className="input" value={d.displayName}
              onChange={e => setD({ ...d, displayName: e.target.value })} />
          </div>
          <div>
            <label className="label">{isNew ? "Password" : "New password (leave blank to keep)"}</label>
            <input type="password" className="input" value={d.password}
              onChange={e => setD({ ...d, password: e.target.value })} />
          </div>
          <label className="flex items-center gap-2 mt-2">
            <input type="checkbox" checked={d.isAdmin}
              onChange={e => setD({ ...d, isAdmin: e.target.checked })} />
            <span className="text-sm">Administrator</span>
          </label>
        </div>
        <div className="mt-5 flex gap-2 justify-end">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={() => onSave(d)}>Save</button>
        </div>
      </div>
    </div>
  );
}
