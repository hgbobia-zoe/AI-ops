"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SopSignForm({ token, name, statement }: { token: string; name: string; statement: string }): React.JSX.Element {
  const [typed, setTyped] = useState("");
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function sign(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/sop-ack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, name: typed }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (data?.ok) setDone(true);
      else setErr(data?.error ?? "Could not sign. Try again.");
    } catch {
      setErr("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) return <p className="text-sm">Signed. Thank you, {name}! You can close this page.</p>;

  return (
    <form onSubmit={sign} className="flex flex-col gap-3">
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
        <span>{statement}</span>
      </label>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="sop-name" className="text-[12px]">Type your full name ({name})</Label>
        <Input id="sop-name" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="name" />
      </div>
      {err && <p className="text-sm text-critical">{err}</p>}
      <Button type="submit" disabled={!agree || !typed.trim() || busy}>{busy ? "Signing…" : "Sign"}</Button>
    </form>
  );
}
