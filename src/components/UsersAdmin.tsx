"use client";

import { useState } from "react";
import { UserPlus, KeyRound, Check, X } from "lucide-react";
import { ROLE_LABEL, assignableRoles, type Role } from "@/lib/auth/roles";

interface UserRow {
  id: string;
  username: string;
  name: string;
  role: Role;
  active: boolean;
  lastLoginAt: string | null;
}

export function UsersAdmin({
  initialUsers,
  viewerRole,
  viewerId,
}: {
  initialUsers: UserRow[];
  viewerRole: Role;
  viewerId: string | null;
}): React.JSX.Element {
  const [users, setUsers] = useState<UserRow[]>(initialUsers);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const roles = assignableRoles(viewerRole);

  const canManage = (u: UserRow): boolean =>
    viewerRole === "owner" ? true : u.role === "member";

  const patch = async (id: string, body: Record<string, unknown>) => {
    setMsg(null);
    const r = await fetch("/api/auth/users", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, ...body }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.user) {
      setUsers((us) => us.map((u) => (u.id === id ? { ...u, ...j.user } : u)));
      setMsg({ ok: true, text: "Saved." });
    } else {
      setMsg({ ok: false, text: j.error || "Failed." });
    }
  };

  const resetPassword = async (u: UserRow) => {
    const pw = window.prompt(`New password for ${u.username} (min 8 chars):`);
    if (!pw) return;
    await patch(u.id, { password: pw });
  };

  return (
    <div className="space-y-6">
      {msg && <div className={`border p-2.5 text-sm ${msg.ok ? "border-emerald-500/40 text-emerald-300" : "border-red-500/40 text-red-300"}`}>{msg.text}</div>}

      {/* Existing users */}
      <div className="overflow-x-auto border border-white/10">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="p-2.5">User</th>
              <th className="p-2.5">Role</th>
              <th className="p-2.5">Status</th>
              <th className="p-2.5">Last login</th>
              <th className="p-2.5"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {users.map((u) => {
              const editable = canManage(u);
              return (
                <tr key={u.id} className={u.active ? "" : "opacity-50"}>
                  <td className="p-2.5">
                    <div className="font-medium">{u.name || u.username}</div>
                    <div className="text-[11px] text-muted-foreground">@{u.username}{u.id === viewerId ? " · you" : ""}</div>
                  </td>
                  <td className="p-2.5">
                    {editable && roles.length > 0 ? (
                      <select
                        value={u.role}
                        onChange={(e) => patch(u.id, { role: e.target.value })}
                        className="rounded border border-white/15 bg-transparent px-2 py-1 text-sm"
                      >
                        {[...new Set([u.role, ...roles])].map((r) => (
                          <option key={r} value={r} className="bg-background">
                            {ROLE_LABEL[r as Role]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="border border-white/15 px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">{ROLE_LABEL[u.role]}</span>
                    )}
                  </td>
                  <td className="p-2.5">
                    <span className={u.active ? "text-emerald-300" : "text-muted-foreground"}>{u.active ? "Active" : "Disabled"}</span>
                  </td>
                  <td className="p-2.5 text-[11px] text-muted-foreground">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "never"}</td>
                  <td className="p-2.5">
                    {editable && (
                      <div className="flex items-center justify-end gap-1.5">
                        <button onClick={() => resetPassword(u)} title="Reset password" className="rounded border border-white/15 p-1.5 text-muted-foreground hover:text-foreground">
                          <KeyRound className="size-3.5" />
                        </button>
                        <button
                          onClick={() => patch(u.id, { active: !u.active })}
                          title={u.active ? "Deactivate" : "Reactivate"}
                          className="rounded border border-white/15 p-1.5 text-muted-foreground hover:text-foreground"
                        >
                          {u.active ? <X className="size-3.5" /> : <Check className="size-3.5" />}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <AddUser
        roles={roles}
        onAdded={(u) => {
          setUsers((us) => [...us, u]);
          setMsg({ ok: true, text: `Added ${u.username}.` });
        }}
        onError={(text) => setMsg({ ok: false, text })}
      />
    </div>
  );
}

function AddUser({ roles, onAdded, onError }: { roles: Role[]; onAdded: (u: UserRow) => void; onError: (t: string) => void }): React.JSX.Element {
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>(roles[roles.length - 1] ?? "member");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const r = await fetch("/api/auth/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, name, role, password }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok && j.user) {
      onAdded(j.user);
      setUsername("");
      setName("");
      setPassword("");
    } else {
      onError(j.error || "Failed to add user.");
    }
  };

  return (
    <form onSubmit={submit} className="surface space-y-3 border border-white/10 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold"><UserPlus className="size-4" /> Add a teammate</div>
      <div className="grid gap-2 sm:grid-cols-4">
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" className="rounded border border-white/15 bg-transparent px-2.5 py-1.5 text-sm" />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name (optional)" className="rounded border border-white/15 bg-transparent px-2.5 py-1.5 text-sm" />
        <select value={role} onChange={(e) => setRole(e.target.value as Role)} className="rounded border border-white/15 bg-transparent px-2.5 py-1.5 text-sm">
          {roles.map((r) => (
            <option key={r} value={r} className="bg-background">{ROLE_LABEL[r]}</option>
          ))}
        </select>
        <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="password (min 8)" className="rounded border border-white/15 bg-transparent px-2.5 py-1.5 text-sm" />
      </div>
      <button type="submit" disabled={busy || !username || password.length < 8} className="btn-hero rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50">
        {busy ? "Adding…" : "Add teammate"}
      </button>
    </form>
  );
}
