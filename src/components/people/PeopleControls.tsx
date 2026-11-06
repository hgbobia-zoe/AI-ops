"use client";

// Small People controls: edit a person's mobile or access policy, run staff matching, confirm a suggested
// link, and verify Connecteam write access. Each posts to the People API (owner/admin gated server side)
// and refreshes; the server owns every rule and audit.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Msg = { text: string; tone: "ok" | "bad" } | null;

function usePost(): { busy: boolean; msg: Msg; post: (url: string, body: unknown) => Promise<boolean> } {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  async function post(url: string, body: unknown): Promise<boolean> {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; message?: string; error?: string } | null;
      const ok = res.ok && data?.ok !== false;
      setMsg({ text: data?.message ?? data?.error ?? (ok ? "Done." : "Failed."), tone: ok ? "ok" : "bad" });
      if (ok) router.refresh();
      return ok;
    } catch {
      setMsg({ text: "Network error.", tone: "bad" });
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, msg, post };
}

function Note({ msg }: { msg: Msg }): React.JSX.Element | null {
  if (!msg) return null;
  return <span className={`text-[11px] ${msg.tone === "ok" ? "text-positive" : "text-critical"}`}>{msg.text}</span>;
}

export function PhoneEdit({ id, phone }: { id: string; phone: string | null }): React.JSX.Element {
  const { busy, msg, post } = usePost();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(phone ?? "");
  if (!editing) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className={phone ? "text-secondary-text" : "text-attention"}>{phone ?? "No mobile"}</span>
        <Button variant="ghost" size="xs" onClick={() => setEditing(true)}>{phone ? "Edit" : "Add mobile"}</Button>
        <Note msg={msg} />
      </span>
    );
  }
  return (
    <form
      className="inline-flex items-center gap-1.5"
      onSubmit={async (e) => { e.preventDefault(); if (await post("/api/people/employee", { action: "set_phone", id, phone: value })) setEditing(false); }}
    >
      <Input type="tel" inputMode="tel" aria-label="Mobile" value={value} onChange={(e) => setValue(e.target.value)} placeholder="301 555 0123" className="h-7 w-36 text-[12px]" autoFocus />
      <Button size="xs" type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
      <Button variant="ghost" size="xs" type="button" onClick={() => setEditing(false)}>Cancel</Button>
      <Note msg={msg} />
    </form>
  );
}

export function PolicyPicker({ id, policies }: { id: string; policies: { id: string; name: string }[] }): React.JSX.Element {
  const { busy, msg, post } = usePost();
  const [value, setValue] = useState("");
  return (
    <span className="inline-flex items-center gap-1.5">
      <select aria-label="Access policy" className="h-7 rounded-md border border-input bg-[var(--panel)] px-2 text-[12px] text-foreground" value={value} onChange={(e) => setValue(e.target.value)}>
        <option value="">Set a policy…</option>
        {policies.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <Button size="xs" disabled={busy || !value} onClick={() => void post("/api/people/employee", { action: "set_policy", id, department: value })}>Save</Button>
      <Note msg={msg} />
    </span>
  );
}

export function RunMatchButton(): React.JSX.Element {
  const { busy, msg, post } = usePost();
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" onClick={() => void post("/api/people/match", { action: "run" })} disabled={busy}>{busy ? "Matching…" : "Match now"}</Button>
      <Note msg={msg} />
    </span>
  );
}

export function ConfirmLinkButton({ employeeId, employeeName, field, value }: { employeeId: string; employeeName: string; field: string; value: string | number }): React.JSX.Element {
  const { busy, msg, post } = usePost();
  return (
    <span className="inline-flex items-center gap-1.5">
      <Button variant="outline" size="xs" disabled={busy} onClick={() => void post("/api/people/match", { action: "link", employeeId, field, value })}>
        {busy ? "Linking…" : `It is ${employeeName}`}
      </Button>
      <Note msg={msg} />
    </span>
  );
}

export function VerifyConnecteamButton({ verified }: { verified: boolean }): React.JSX.Element {
  const { busy, msg, post } = usePost();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button size="sm" variant={verified ? "outline" : "default"} onClick={() => void post("/api/people/connecteam", {})} disabled={busy}>
        {busy ? "Checking…" : verified ? "Check again" : "Verify Connecteam write access"}
      </Button>
      <Note msg={msg} />
    </span>
  );
}

/** The "Add to People" cell for one New in Gusto row: pick the role in People, add, or stop tracking. */
export function AddFromGustoCell({ id, name, policies, suggested, cellClass }: {
  id: string; name: string; policies: { id: string; name: string }[]; suggested: string; cellClass: string;
}): React.JSX.Element {
  const { busy, msg, post } = usePost();
  const [policy, setPolicy] = useState(suggested);
  return (
    <td className={cellClass}>
      <div className="flex w-[150px] flex-col items-stretch gap-1">
        <select aria-label={`Role in People for ${name}`} className="h-7 w-full rounded-md border border-input bg-[var(--panel)] px-2 text-[12px] text-foreground" value={policy} onChange={(e) => setPolicy(e.target.value)}>
          {policies.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <Button size="xs" disabled={busy} onClick={() => void post("/api/people/gusto", { action: "add", id, policyId: policy })}>{busy ? "Adding…" : "Add to People"}</Button>
        <Button variant="ghost" size="xs" disabled={busy} onClick={() => void post("/api/people/gusto", { action: "hide", id })}>Not tracked here</Button>
        {msg && <div className="whitespace-normal"><Note msg={msg} /></div>}
      </div>
    </td>
  );
}
