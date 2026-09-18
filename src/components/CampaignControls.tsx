"use client";

// Opportunity Radar — campaign controls: create a campaign with target criteria (then auto-match), and
// run auto-match on an existing campaign.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { KIND_LABEL, JURISDICTION_LABEL, type Jurisdiction, type OpportunityKind } from "@/lib/opportunity/types";

export function CampaignCreate() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [minScore, setMinScore] = useState("");

  async function create() {
    if (!name.trim()) { toast.error("Name the campaign"); return; }
    setBusy(true);
    try {
      const criteria: Record<string, unknown> = {};
      if (kind) criteria.kinds = [kind];
      if (jurisdiction) criteria.jurisdictions = [jurisdiction];
      if (minScore) criteria.minScore = Number(minScore);
      const res = await fetch("/api/opportunity/campaign", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create", name, criteria }) });
      const data = (await res.json()) as { campaign?: { id: string } };
      if (!res.ok || !data.campaign) throw new Error();
      // Auto-match immediately so the campaign is populated.
      await fetch("/api/opportunity/campaign", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "automatch", campaignId: data.campaign.id }) });
      toast.success("Campaign created");
      setOpen(false); setName(""); setKind(""); setJurisdiction(""); setMinScore("");
      router.refresh();
    } catch {
      toast.error("Could not create the campaign");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return <button onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 rounded border border-foreground/25 bg-foreground/[0.06] px-2.5 py-1 text-[12.5px] font-medium text-foreground hover:bg-foreground/[0.12]"><Plus className="size-3.5" /> New campaign</button>;

  return (
    <div className="flex flex-wrap items-end gap-2 rounded border border-border p-3">
      <label className="flex flex-col gap-0.5 text-[11px] text-meta">Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Montgomery County Government Events" className="w-64 rounded border border-border bg-transparent px-2 py-1 text-[12.5px] text-foreground" /></label>
      <label className="flex flex-col gap-0.5 text-[11px] text-meta">Type<select value={kind} onChange={(e) => setKind(e.target.value)} className="rounded border border-border bg-transparent px-2 py-1 text-[12.5px] text-foreground"><option value="">Any</option>{(Object.keys(KIND_LABEL) as OpportunityKind[]).map((k) => <option key={k} value={k} className="bg-background">{KIND_LABEL[k]}</option>)}</select></label>
      <label className="flex flex-col gap-0.5 text-[11px] text-meta">Jurisdiction<select value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} className="rounded border border-border bg-transparent px-2 py-1 text-[12.5px] text-foreground"><option value="">Any</option>{(Object.keys(JURISDICTION_LABEL) as Jurisdiction[]).map((j) => <option key={j} value={j} className="bg-background">{JURISDICTION_LABEL[j]}</option>)}</select></label>
      <label className="flex flex-col gap-0.5 text-[11px] text-meta">Min score<input value={minScore} onChange={(e) => setMinScore(e.target.value)} inputMode="numeric" placeholder="0" className="w-16 rounded border border-border bg-transparent px-2 py-1 text-[12.5px] text-foreground" /></label>
      <button onClick={create} disabled={busy} className="rounded border border-foreground/25 bg-foreground/[0.06] px-3 py-1.5 text-[12.5px] font-medium text-foreground hover:bg-foreground/[0.12] disabled:opacity-50">{busy ? "Creating…" : "Create + match"}</button>
      <button onClick={() => setOpen(false)} className="text-[12px] text-meta hover:text-foreground">Cancel</button>
    </div>
  );
}

export function CampaignAutoMatch({ campaignId }: { campaignId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      const res = await fetch("/api/opportunity/campaign", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "automatch", campaignId }) });
      const data = (await res.json()) as { assigned?: number };
      if (!res.ok) throw new Error();
      toast.success(`Matched ${data.assigned ?? 0} opportunit${data.assigned === 1 ? "y" : "ies"}`);
      router.refresh();
    } catch {
      toast.error("Auto-match failed");
    } finally {
      setBusy(false);
    }
  }
  return <button onClick={run} disabled={busy} className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[12px] text-tertiary-text hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50"><Wand2 className="size-3.5" /> {busy ? "Matching…" : "Auto-match by criteria"}</button>;
}
