"use client";

import { useState } from "react";
import { Lock } from "lucide-react";

export function LoginForm({ next }: { next: string }): React.JSX.Element {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (r.ok) {
        window.location.href = next;
        return;
      }
      setError(r.status === 401 ? "Incorrect username or password." : r.status === 503 ? "Login isn't configured yet." : "Sign-in failed.");
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="surface space-y-3 rounded-2xl border border-white/10 p-5">
      <label className="block text-sm font-medium" htmlFor="user">
        Username
      </label>
      <input
        id="user"
        type="text"
        autoFocus
        autoComplete="username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        className="w-full rounded-lg border border-white/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-white/40"
        placeholder="Your username"
      />
      <label className="block text-sm font-medium" htmlFor="pw">
        Password
      </label>
      <input
        id="pw"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="w-full rounded-lg border border-white/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-white/40"
        placeholder="Your password"
      />
      {error && <p className="text-sm text-red-300">{error}</p>}
      <button
        type="submit"
        disabled={busy || !username || !password}
        className="btn-hero flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
      >
        <Lock className="size-4" /> {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
