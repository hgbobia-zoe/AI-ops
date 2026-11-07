"use client";

// Opportunity Radar — detail actions: the lifecycle stage (manual override) and "Convert to Goodshuffle".
// Converting is INTENT ONLY (owner rule): the person confirms the prospect replied interested, booked a
// meeting or asked for a quote, and confirms the contact. Only then is a Goodshuffle project queued (or an
// existing one linked). Nothing is created for cold outreach. Once linked, the booking decides the outcome.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Send } from "lucide-react";
import { toast } from "sonner";
import { STAGE_LABEL, STAGE_ORDER, type LifecycleStage } from "@/lib/opportunity/types";

const SELECTABLE: LifecycleStage[] = [...STAGE_ORDER, "QUOTED", "WON", "LOST", "ARCHIVED"].filter((s, i, a) => a.indexOf(s) === i) as LifecycleStage[];

type IntentKind = "replied_interested" | "meeting_booked" | "asked_for_quote";
const INTENTS: { kind: IntentKind; label: string }[] = [
  { kind: "replied_interested", label: "Replied interested" },
  { kind: "meeting_booked", label: "Meeting or call booked" },
  { kind: "asked_for_quote", label: "Asked for a quote" },
];

export interface ConversionProps {
  intakeId: string | null;
  intakeStatus: string | null;
  intent: { kind: IntentKind; note: string } | null;
  convertedBy: string | null;
  convertedAt: string | null;
  suggestedIntent: IntentKind | null;
  prefill: { firstName: string; lastName: string; email: string; phone: string };
  booking: { stage: "QUOTED" | "WON" | "LOST"; signed: boolean; statusLabel: string | null; contractTotal: number | null } | null;
}

const input = "w-full rounded border border-border bg-transparent px-2 py-1 text-[12.5px] text-foreground placeholder:text-meta";

export function OpportunityActions({
  id,
  stage,
  salesStatus,
  bookingId,
  conversion,
}: {
  id: string;
  stage: LifecycleStage;
  salesStatus: "NONE" | "OPPORTUNITY_CREATED" | "LINKED";
  bookingId: string | null;
  conversion: ConversionProps;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState<IntentKind | "">(conversion.suggestedIntent ?? "");
  const [note, setNote] = useState("");
  const [c, setC] = useState(conversion.prefill);

  async function setStage(next: string) {
    if (next === stage) return;
    setBusy(true);
    try {
      const res = await fetch("/api/opportunity/stage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, stage: next }) });
      if (!res.ok) throw new Error();
      toast.success(`Stage set to ${STAGE_LABEL[next as LifecycleStage]}`);
      router.refresh();
    } catch {
      toast.error("Could not update the stage");
    } finally {
      setBusy(false);
    }
  }

  async function convert() {
    setBusy(true);
    try {
      const res = await fetch("/api/opportunity/handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, intent: { kind: intent, note }, contact: c }),
      });
      const d = (await res.json()) as { ok?: boolean; status?: string; error?: string };
      if (!res.ok || !d.ok) throw new Error(d.error || "Could not convert");
      toast.success(d.status === "linked_existing" ? "Linked to the contact's existing Goodshuffle project" : d.status === "already" ? "Already converted" : "Goodshuffle project queued. It appears once the office session creates it.");
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const b = conversion.booking;
  let status: React.ReactNode = null;
  if (salesStatus === "LINKED" && bookingId) {
    status = (
      <a href={`https://pro.goodshuffle.com/app/project/detail?id=${encodeURIComponent(bookingId)}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded border border-positive/40 px-2.5 py-1.5 text-[12.5px] font-medium text-positive transition-colors hover:bg-[var(--row-hover)]">
        {b ? (b.signed ? "Signed in Goodshuffle" : b.stage === "LOST" ? "Lost in Goodshuffle" : "Quoted in Goodshuffle") : "Linked to Goodshuffle"}
        {b?.contractTotal != null ? ` · $${Math.round(b.contractTotal).toLocaleString()}` : ""}
        <ArrowUpRight className="size-3.5" />
      </a>
    );
  } else if (salesStatus === "OPPORTUNITY_CREATED") {
    status = (
      <span className="rounded border border-attention/40 px-2.5 py-1.5 text-[12.5px] text-attention" title="The office Goodshuffle session creates the project on its next pull">
        {conversion.intakeStatus === "failed" ? "Goodshuffle create failed: see Intake" : "Goodshuffle project queued"}
      </span>
    );
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-[12px] text-meta">
          Stage
          <select value={stage} disabled={busy || !!b} title={b ? "Set by the linked Goodshuffle booking" : undefined} onChange={(e) => setStage(e.target.value)} className="rounded border border-border bg-transparent px-2 py-1 text-[12.5px] text-foreground disabled:opacity-50">
            {SELECTABLE.map((s) => <option key={s} value={s} className="bg-background">{STAGE_LABEL[s]}</option>)}
          </select>
        </label>
        {status ?? (
          <button onClick={() => setOpen((o) => !o)} disabled={busy} title="Only for a prospect who showed intent: replied interested, booked a meeting or asked for a quote" className="inline-flex items-center gap-2 rounded border border-foreground/25 bg-foreground/[0.06] px-3 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-foreground/[0.12] disabled:opacity-50">
            <Send className="size-3.5" /> Convert to Goodshuffle
          </button>
        )}
      </div>
      {open && !status && (
        <div className="w-full max-w-[420px] rounded border border-border bg-background p-3 text-left">
          <p className="mb-2 text-[12px] text-meta">Goodshuffle projects are only for prospects who showed intent. Confirm what happened:</p>
          <div className="mb-2 flex flex-col gap-1">
            {INTENTS.map((i) => (
              <label key={i.kind} className="flex items-center gap-2 text-[12.5px] text-foreground">
                <input type="radio" name={`intent-${id}`} checked={intent === i.kind} onChange={() => setIntent(i.kind)} /> {i.label}
                {conversion.suggestedIntent === i.kind && <span className="text-[11px] text-meta">(from the worklist)</span>}
              </label>
            ))}
          </div>
          <input className={`${input} mb-2`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What did they say? (optional)" />
          <div className="mb-2 grid grid-cols-2 gap-2">
            <input className={input} value={c.firstName} onChange={(e) => setC({ ...c, firstName: e.target.value })} placeholder="First name" />
            <input className={input} value={c.lastName} onChange={(e) => setC({ ...c, lastName: e.target.value })} placeholder="Last name" />
            <input className={input} value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} placeholder="Email" inputMode="email" />
            <input className={input} value={c.phone} onChange={(e) => setC({ ...c, phone: e.target.value })} placeholder="Phone" inputMode="tel" />
          </div>
          <p className="mb-2 text-[11.5px] text-meta">If this contact already has a Goodshuffle project, it is linked instead of creating a new one. No welcome email is sent.</p>
          <div className="flex items-center gap-2">
            <button onClick={convert} disabled={busy || !intent} className="rounded border border-foreground/25 bg-foreground/[0.06] px-3 py-1.5 text-[12.5px] font-medium text-foreground hover:bg-foreground/[0.12] disabled:opacity-50">{busy ? "Working…" : "Confirm and create"}</button>
            <button onClick={() => setOpen(false)} className="text-[12px] text-meta hover:text-foreground">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
