"use client";

// Add a new employee — a FOCUSED dialog (replaces the old large inline form that pushed the queues
// down the page). Stable labels, explicit required/optional markers, start date, role + access policy,
// and an HONEST readout of what "Start onboarding now" actually does (materializes tracked tasks from
// the policy and moves the person to Onboarding — it does NOT itself grant any access). The server owns
// the real write + the lifecycle machine; this is the form + status readout only.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { UserPlus, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const ROLES = [
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
  { value: "owner", label: "Owner" },
] as const;

export function AddEmployeeDialog({ policies }: { policies: { id: string; name: string }[] }): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [department, setDepartment] = useState(policies[0]?.id ?? "");
  const [startDate, setStartDate] = useState("");
  const [startNow, setStartNow] = useState(true);

  function reset(): void {
    setName(""); setEmail(""); setRole("member"); setDepartment(policies[0]?.id ?? "");
    setStartDate(""); setStartNow(true); setMsg(null);
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
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
        setOpen(false);
        reset();
        router.refresh();
      }
    } catch {
      setMsg({ text: "Network error.", tone: "bad" });
    } finally {
      setBusy(false);
    }
  }

  const selectCls = "h-9 w-full rounded-md border border-input bg-[var(--panel)] px-2.5 text-[13px] text-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
  const policyName = policies.find((p) => p.id === department)?.name ?? "the selected";

  return (
    <>
      <Button variant="default" size="lg" onClick={() => { reset(); setOpen(true); }}>
        <UserPlus className="size-4" aria-hidden /> Add employee
      </Button>

      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setMsg(null); }}>
        <DialogContent className="max-w-md" showCloseButton>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[15px]"><UserPlus className="size-4 text-meta" aria-hidden /> Add employee</DialogTitle>
            <DialogDescription className="text-[12px] text-meta">
              Creates a lifecycle record in this registry. Payroll&apos;s worker directory is separate and populated from Connecteam.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={submit} className="flex flex-col gap-3.5">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="emp-name" className="text-[12px]">Full name <span className="text-critical">*</span></Label>
              <Input id="emp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Jordan Rivera" autoFocus required />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="emp-email" className="text-[12px]">Work email <span className="text-meta">(optional)</span></Label>
              <Input id="emp-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@zoeeventsdmv.com" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="emp-policy" className="text-[12px]">Access policy <span className="text-critical">*</span></Label>
                <select id="emp-policy" className={selectCls} value={department} onChange={(e) => setDepartment(e.target.value)}>
                  {policies.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="emp-role" className="text-[12px]">Console role <span className="text-critical">*</span></Label>
                <select id="emp-role" className={selectCls} value={role} onChange={(e) => setRole(e.target.value)}>
                  {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="emp-start" className="text-[12px]">Start date <span className="text-meta">(optional)</span></Label>
              <Input id="emp-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-full" />
            </div>

            <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border bg-[var(--row)] p-3">
              <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} />
              <span className="text-[12px] leading-snug">
                <span className="font-medium text-foreground">Start onboarding now</span>
                <span className="mt-0.5 block text-meta">
                  {startNow
                    ? `Moves them to Onboarding and creates the provisioning checklist from the ${policyName} policy. The Zoe login can then be approved and run; every other system is a tracked manual step. No access is granted by this action.`
                    : "Creates the record in Starting soon. You can begin onboarding later from their profile."}
                </span>
              </span>
            </label>

            {msg && <p className={`text-[12px] ${msg.tone === "ok" ? "text-positive" : "text-critical"}`} role={msg.tone === "bad" ? "alert" : undefined}>{msg.text}</p>}

            <div className="flex items-center justify-end gap-2 border-t border-rule pt-3">
              <Button type="button" variant="ghost" size="lg" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
              <Button type="submit" variant="default" size="lg" disabled={busy}>
                {busy ? "Adding…" : <>{startNow ? "Add & start onboarding" : "Add employee"} <ArrowRight className="size-4" aria-hidden /></>}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
