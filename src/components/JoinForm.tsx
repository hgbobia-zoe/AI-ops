"use client";

// Invite acceptance form. The invitee picks their own username + password (the owner never sets one).
// Posts to the public /api/auth/accept, which creates the account with the invite's role and signs
// them in, then we drop them into the app.

import { useState } from "react";
import { UserPlus } from "lucide-react";

export function JoinForm({ token, presetName, role }: { token: string; presetName: string; role: string }): React.JSX.Element {
  const [name, setName] = useState(presetName);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, username, password, name }),
      });
      if (r.ok) {
        window.location.href = "/";
        return;
      }
      const j = (await r.json().catch(() => null)) as { error?: string } | null;
      setError(j?.error ?? "Could not create your account.");
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="surface space-y-3 rounded-2xl border border-white/10 p-5">
      <p className="text-sm text-muted-foreground">
        You&apos;re joining as <span className="font-medium text-foreground capitalize">{role}</span>. Choose a username and password —
        these are yours.
      </p>

      <label className="block text-sm font-medium" htmlFor="name">Your name</label>
      <input
        id="name"
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full rounded-lg border border-white/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-white/40"
        placeholder="First Last"
      />

      <label className="block text-sm font-medium" htmlFor="user">Username</label>
      <input
        id="user"
        type="text"
        autoFocus
        autoComplete="username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        className="w-full rounded-lg border border-white/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-white/40"
        placeholder="Pick a username"
      />

      <label className="block text-sm font-medium" htmlFor="pw">Password</label>
      <input
        id="pw"
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="w-full rounded-lg border border-white/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-white/40"
        placeholder="At least 8 characters"
      />

      {error && <p className="text-sm text-red-300">{error}</p>}
      <button
        type="submit"
        disabled={busy || !username || password.length < 8}
        className="btn-hero flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
      >
        <UserPlus className="size-4" /> {busy ? "Creating…" : "Create my account"}
      </button>
    </form>
  );
}
