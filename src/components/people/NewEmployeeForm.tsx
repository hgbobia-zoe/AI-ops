"use client";

// Add a new employee. Posts to the people engine (create) and optionally kicks off onboarding. The server
// owns the real write + the lifecycle machine; this is just the form + status readout.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { UserPlus } from "lucide-react";

export function NewEmployeeForm({ policies }: { policies: { id: string; name: string }[] }): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [department, setDepartment] = useState(policies[0]?.id ?? "");
  const [startDate, setStartDate] = useState("");
  const [startNow, setStartNow] = useState(true);

  async function submit(): Promise<void> {
    if (!name.trim()) {
      setMsg({ text: "Name is required.", tone: "bad" });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/people/employee", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "create", displayName: name, workEmail: email, role, department, startDate: startDate || null, startNow }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; id?: string; error?: string } | null;
      if (!res.ok || !data?.ok) {
        setMsg({ text: data?.error ?? "Could not create employee.", tone: "bad" });
      } else {
        setMsg({ text: "Employee added.", tone: "ok" });
        setName(""); setEmail(""); setStartDate("");
        router.refresh();
      }
    } catch {
      setMsg({ text: "Network error.", tone: "bad" });
    } finally {
      setBusy(false);
    }
  }

  const field = "h-9 rounded-md border border-border bg-[var(--panel)] px-2.5 text-[13px] text-foreground";
  return (
    <div className="rounded-lg border border-border bg-[var(--panel)] p-4">
      <h3 className="mb-3 flex items-center gap-2 text-[13px] font-medium uppercase tracking-[0.08em] text-tertiary-text"><UserPlus className="size-4" /> Add employee</h3>
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        <input className={field} placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className={field} placeholder="Work email (optional)" value={email} onChange={(e) => setEmail(e.target.value)} />
        <select className={field} value={department} onChange={(e) => setDepartment(e.target.value)} aria-label="Access policy">
          {policies.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select className={field} value={role} onChange={(e) => setRole(e.target.value)} aria-label="Console role">
          <option value="member">Member</option>
          <option value="admin">Admin</option>
          <option value="owner">Owner</option>
        </select>
        <label className="flex items-center gap-2 text-[12.5px] text-meta">
          <span>Start date</span>
          <input type="date" className={`${field} flex-1`} value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </label>
        <label className="flex items-center gap-2 text-[12.5px] text-meta">
          <input type="checkbox" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} /> Start onboarding now
        </label>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button onClick={submit} disabled={busy} className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-foreground px-4 text-[13px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-60">
          {busy ? "Adding…" : "Add employee"}
        </button>
        {msg && <span className={`text-[12px] ${msg.tone === "ok" ? "text-positive" : "text-critical"}`}>{msg.text}</span>}
      </div>
    </div>
  );
}
