"use client";

// Add a new employee — a FOCUSED dialog (replaces the old large inline form that pushed the queues
// down the page). Stable labels, explicit required/optional markers, start date, role + access policy,
// and an HONEST readout of what "Start onboarding now" actually does (materializes tracked tasks from
// the policy and moves the person to Onboarding — it does NOT itself grant any access). The server owns
// the real write + the lifecycle machine; this is the form + status readout only.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { deriveWorkEmail } from "@/lib/people/policy";
import { INTAKE_DEFAULTS, displayNameFor, type HireIntake } from "@/lib/people/intake";
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

export function AddEmployeeDialog({ policies }: { policies: { id: string; name: string; issuesEmail?: boolean }[] }): React.JSX.Element {
  const router = useRouter();
  const defaultPolicy = policies.find((p) => p.id === "sales_associate")?.id ?? policies[0]?.id ?? "";
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);
  const [f, setF] = useState<HireIntake>(INTAKE_DEFAULTS);
  const set = (k: keyof HireIntake) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((p) => ({ ...p, [k]: e.target.value }));
  const name = displayNameFor(f);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [department, setDepartment] = useState(defaultPolicy);
  const [startDate, setStartDate] = useState("");
  const [startNow, setStartNow] = useState(true);

  function reset(): void {
    setF(INTAKE_DEFAULTS); setEmail(""); setRole("member"); setDepartment(defaultPolicy);
    setStartDate(""); setStartNow(true); setMsg(null);
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!f.legalFirstName.trim() || !f.legalLastName.trim()) {
      setMsg({ text: "Legal first and last name are required.", tone: "bad" });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/people/employee", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "create", displayName: name, intake: f, workEmail: email, role, department, startDate: startDate || null, startNow }),
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

  const selectedPolicy = policies.find((p) => p.id === department);
  const derivedEmail = selectedPolicy?.issuesEmail ? deriveWorkEmail(name) : null;

  const selectCls = "h-9 w-full rounded-md border border-input bg-[var(--panel)] px-2.5 text-[13px] text-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
  const policyName = policies.find((p) => p.id === department)?.name ?? "the selected";

  return (
    <>
      <Button variant="default" size="lg" onClick={() => { reset(); setOpen(true); }}>
        <UserPlus className="size-4" aria-hidden /> Add employee
      </Button>

      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setMsg(null); }}>
        <DialogContent className="max-h-[90dvh] max-w-xl overflow-y-auto" showCloseButton>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[15px]"><UserPlus className="size-4 text-meta" aria-hidden /> Add employee</DialogTitle>
            <DialogDescription className="text-[12px] text-meta">
              Everything Gusto and the other systems need, collected once. SSN, bank and tax forms are NOT asked here: the hire enters those in Gusto self onboarding.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={submit} className="flex flex-col gap-3.5">
            <p className="text-[11.5px] font-medium uppercase tracking-[0.08em] text-tertiary-text">Person</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="in-legalFirstName" className="text-[12px]">Legal first name <span className="text-critical">*</span></Label>
                <Input id="in-legalFirstName" value={String(f.legalFirstName)} onChange={set("legalFirstName")} autoFocus />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="in-legalLastName" className="text-[12px]">Legal last name <span className="text-critical">*</span></Label>
                <Input id="in-legalLastName" value={String(f.legalLastName)} onChange={set("legalLastName")} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="in-legalMiddleName" className="text-[12px]">Middle name</Label>
                <Input id="in-legalMiddleName" value={String(f.legalMiddleName)} onChange={set("legalMiddleName")} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="in-preferredName" className="text-[12px]">Preferred first name</Label>
                <Input id="in-preferredName" value={String(f.preferredName)} onChange={set("preferredName")} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="in-personalEmail" className="text-[12px]">Personal email <span className="text-critical">*</span></Label>
                <Input id="in-personalEmail" value={String(f.personalEmail)} onChange={set("personalEmail")} type="email" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="in-phone" className="text-[12px]">Mobile phone <span className="text-critical">*</span></Label>
                <Input id="in-phone" value={String(f.phone)} onChange={set("phone")} type="tel" placeholder="(301) 555 0100" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="in-dateOfBirth" className="text-[12px]">Date of birth <span className="text-critical">*</span></Label>
                <Input id="in-dateOfBirth" value={String(f.dateOfBirth)} onChange={set("dateOfBirth")} type="date" />
              </div>
            </div>
            <p className="text-[11.5px] font-medium uppercase tracking-[0.08em] text-tertiary-text">Home address</p>
            <div className="flex flex-col gap-1.5">
                <Label htmlFor="in-street" className="text-[12px]">Street <span className="text-critical">*</span></Label>
                <Input id="in-street" value={String(f.street)} onChange={set("street")} />
              </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="in-city" className="text-[12px]">City <span className="text-critical">*</span></Label>
                <Input id="in-city" value={String(f.city)} onChange={set("city")} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="in-state" className="text-[12px]">State <span className="text-critical">*</span></Label>
                <Input id="in-state" value={String(f.state)} onChange={set("state")} maxLength={2} placeholder="MD" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="in-zip" className="text-[12px]">ZIP <span className="text-critical">*</span></Label>
                <Input id="in-zip" value={String(f.zip)} onChange={set("zip")} inputMode="numeric" />
              </div>
            </div>
            <p className="text-[11.5px] font-medium uppercase tracking-[0.08em] text-tertiary-text">Job and pay</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="in-jobTitle" className="text-[12px]">Job title <span className="text-critical">*</span></Label>
                <Input id="in-jobTitle" value={String(f.jobTitle)} onChange={set("jobTitle")} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="in-manager" className="text-[12px]">Manager</Label>
                <Input id="in-manager" value={String(f.manager)} onChange={set("manager")} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="in-workerType" className="text-[12px]">Type <span className="text-critical">*</span></Label>
                <select id="in-workerType" className={selectCls} value={f.workerType} onChange={set("workerType")}>
                  <option value="employee">Employee (W-2)</option>
                  <option value="contractor">Contractor (1099)</option>
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="in-payType" className="text-[12px]">Pay <span className="text-critical">*</span></Label>
                <div className="flex gap-2">
                  <select id="in-payType" className={selectCls} value={f.payType} onChange={set("payType")}>
                    <option value="hourly">Per hour</option>
                    <option value="salary">Per year</option>
                  </select>
                  <Input aria-label="Pay rate" type="number" min="0" step="0.01" value={f.payRate || ""} onChange={set("payRate")} placeholder="$" />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="in-workLocation" className="text-[12px]">Work location <span className="text-critical">*</span></Label>
                <Input id="in-workLocation" value={String(f.workLocation)} onChange={set("workLocation")} />
              </div>
            </div>
            <p className="text-[11.5px] font-medium uppercase tracking-[0.08em] text-tertiary-text">Access</p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="emp-email" className="text-[12px]">Work email <span className="text-meta">{derivedEmail ? "(filled in from the name)" : "(optional)"}</span></Label>
              <Input id="emp-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={derivedEmail ?? "name@zoeeventsdmv.com"} />
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
