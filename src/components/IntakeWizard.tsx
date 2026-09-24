"use client";

// Guided Sales Intake — the on-the-phone wizard. One question at a time, large tap targets, autosave,
// back navigation, branching, then a review and the Goodshuffle create. Deterministic: the salesperson
// supplies every fact; the wizard only decides which question comes next and what's required. UNKNOWN /
// "Not sure" are first-class, never inferred to No. Inventory is intentionally NOT here — it's added in
// Goodshuffle after the shell is created.

import { useEffect, useRef, useState, useCallback } from "react";
import { FolderPlus, ArrowLeft, ArrowRight, Check, ExternalLink, Loader2, AlertTriangle, RefreshCw } from "lucide-react";
import type { Intake, IntakePatch, TriState } from "@/lib/intake/types";
import { missingRequired } from "@/lib/intake/types";

type Phase = "start" | "wizard" | "review" | "submitting" | "creating" | "done" | "failed";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const digits = (s: string): string => s.replace(/\D/g, "");
const phoneOk = (s: string): boolean => digits(s).length >= 10;

const EVENT_TYPES: { v: Intake["eventType"]; label: string }[] = [
  { v: "wedding", label: "Wedding" },
  { v: "corporate", label: "Corporate" },
  { v: "social", label: "Birthday / Private party" },
  { v: "other", label: "Other" },
];
// One question replaces the old "commercial vs residential?" + "what kind of location?" pair. These three
// classes map straight onto the dispatch delivery-hours guardrail: commercial (an office) is the only one
// that's business-hours restricted; venue is the default for anything that arranges its own access.
const LOCATION_CLASSES: { v: Exclude<Intake["locationClass"], "">; label: string; desc: string }[] = [
  { v: "residential", label: "Residential", desc: "A home or private residence." },
  { v: "commercial", label: "Commercial", desc: "An office building. Delivery must land within business hours." },
  { v: "venue", label: "Venue", desc: "Event space, hotel, school, park, or public space — they arrange their own access, including off-hours." },
];

// ── Step registry (branching via `when`) ───────────────────────────────────────
type StepId =
  | "customer" | "eventType" | "locationClass" | "guests" | "date" | "times"
  | "location" | "delivery" | "deliveryFlexible" | "deliveryType" | "deliveryTime" | "setup" | "pickup" | "access" | "notes";

// The three delivery types the rep walks the customer through. "standard" is the flexible day-before
// option (our operational preference) and carries the free 9AM–8PM window; the other two are same-day
// paid windows. Order = how we present them: recommended first.
const DELIVERY_TYPES: { v: Exclude<Intake["deliveryTier"], "">; label: string; window: string; price: string; note: string; recommended?: boolean }[] = [
  { v: "standard", label: "Flexible — day before, pick up day after", window: "9AM–8PM", price: "No charge", recommended: true, note: "Our recommendation. We deliver the day before and grab it the day after, so we can work around other jobs — and it keeps their cost down. Most homeowners are fine with this unless they don't own the home or the site has a restriction." },
  { v: "premium", label: "Premium — 2-hour window", window: "Same day · 2-hour window", price: "+$100", note: "Same-day delivery inside a 2-hour window." },
  { v: "exact", label: "Exact time — 30-minute window", window: "Same day · 30-minute window", price: "+$150", note: "For venues that require a precise load-in time." },
];

// Section grouping for the progress rail — the familiar project mental model a Goodshuffle user already
// carries: Customer → Event → Schedule → Location → Logistics → Notes. Purely presentational; the STEPS
// array still drives the actual sequence and branching.
const SECTIONS: { label: string; steps: StepId[] }[] = [
  { label: "Customer", steps: ["customer"] },
  { label: "Event", steps: ["eventType", "locationClass", "guests"] },
  { label: "Schedule", steps: ["date", "times"] },
  { label: "Location", steps: ["location"] },
  { label: "Logistics", steps: ["delivery", "deliveryFlexible", "deliveryType", "deliveryTime", "setup", "pickup", "access"] },
  { label: "Notes", steps: ["notes"] },
];
const sectionIndexOf = (id: StepId | undefined): number => (id ? SECTIONS.findIndex((s) => s.steps.includes(id)) : 0);

interface StepDef {
  id: StepId;
  title: string;
  subtitle?: string;
  when?: (i: Intake) => boolean;
  canNext: (i: Intake) => boolean;
}

const wantsDelivery = (i: Intake): boolean => i.deliveryRequired === "yes" || i.deliveryRequired === "not_sure";

const STEPS: StepDef[] = [
  { id: "customer", title: "Who are we helping?", subtitle: "Capture this while you have them on the line.", canNext: (i) => !!i.firstName.trim() && !!i.lastName.trim() && phoneOk(i.phone) && EMAIL_RE.test(i.email) },
  { id: "eventType", title: "What type of event is this?", canNext: (i) => !!i.eventType && (i.eventType !== "other" || !!i.eventTypeOther.trim()) },
  { id: "locationClass", title: "Where's the delivery?", subtitle: "This sets how we handle delivery timing — commercial offices are the ones we can't deliver to outside business hours.", canNext: (i) => !!i.locationClass },
  { id: "guests", title: "About how many guests?", subtitle: "A rough number is fine.", canNext: (i) => i.guestCount != null || i.guestCountUnknown },
  { id: "date", title: "What's the event date?", canNext: (i) => !!i.eventDate },
  { id: "times", title: "What time does it start and end?", canNext: (i) => !i.eventStartTime || !i.eventEndTime || i.eventEndTime > i.eventStartTime },
  { id: "location", title: "Where's the event?", canNext: () => true },
  { id: "delivery", title: "Will they need delivery?", canNext: () => true },
  { id: "deliveryFlexible", title: "Can we deliver the day before and pick up the day after?", subtitle: "Ask this first. We prefer it — it's no extra cost and gives us room to work around other jobs. Usually fine for a home unless they don't own it or the site restricts access. Yes sets the standard 9AM–8PM window; No means we pin down a same-day window next.", when: wantsDelivery, canNext: (i) => !!i.deliveryFlexible },
  { id: "deliveryType", title: "Which same-day delivery window do they need?", subtitle: "They can't take the free day-before window, so walk them through the same-day options and their cost.", when: (i) => wantsDelivery(i) && i.deliveryFlexible !== "" && i.deliveryFlexible !== "yes", canNext: (i) => i.deliveryTier === "premium" || i.deliveryTier === "exact" },
  { id: "deliveryTime", title: "What times do they need?", subtitle: "They chose a same-day window, so lock in both the drop-off and the pick-up time we'll build it around. Both are required.", when: (i) => wantsDelivery(i) && (i.deliveryTier === "premium" || i.deliveryTier === "exact"), canNext: (i) => !!i.dropoffTime && !!i.pickupTime },
  { id: "setup", title: "Do they want setup help?", subtitle: "Setting up rental equipment on site → Event Readiness Service.", canNext: () => true },
  { id: "pickup", title: "Do they want breakdown help?", subtitle: "Helping tear down after — gathering chairs, removing cushions, etc. → Event Readiness Service.", canNext: () => true },
  { id: "access", title: "A quick logistics check", subtitle: "Just the basics — the full survey happens later.", when: (i) => i.deliveryRequired !== "no" || i.setupRequired !== "no" || i.pickupRequired !== "no", canNext: () => true },
  { id: "notes", title: "Anything else worth noting?", subtitle: "Free-form. Keep facts in the fields above; put color here.", canNext: () => true },
];

export function IntakeWizard(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>("start");
  const [intake, setIntake] = useState<Intake | null>(null);
  const [stepIdx, setStepIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const steps = intake ? STEPS.filter((s) => !s.when || s.when(intake)) : [];
  const step = steps[stepIdx];

  // Autosave (debounced). Also flushed immediately on navigation.
  const flush = useCallback(async (id: string, patch: IntakePatch): Promise<void> => {
    try { await fetch(`/api/intake/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }); } catch { /* autosave is best-effort */ }
  }, []);
  const pendingRef = useRef<IntakePatch>({});
  const set = useCallback((patch: IntakePatch): void => {
    setIntake((prev) => (prev ? { ...prev, ...patch } : prev));
    pendingRef.current = { ...pendingRef.current, ...patch };
    if (!intake) return;
    const id = intake.id;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { const p = pendingRef.current; pendingRef.current = {}; void flush(id, p); }, 500);
  }, [intake, flush]);
  const flushNow = useCallback((): void => {
    if (!intake) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const p = pendingRef.current; pendingRef.current = {};
    if (Object.keys(p).length) void flush(intake.id, p);
  }, [intake, flush]);

  async function start(): Promise<void> {
    setError(null);
    try {
      const r = await fetch("/api/intake", { method: "POST" });
      const j = (await r.json()) as { intake?: Intake };
      if (j.intake) { setIntake(j.intake); setStepIdx(0); setPhase("wizard"); }
      else setError("Couldn't start a new project. Try again.");
    } catch { setError("Couldn't start a new project. Try again."); }
  }

  // Start a new project immediately on entry — no "Start" gate. Runs once (ref guards React's
  // double-invoke in dev + any re-render). A failure drops to the retry state below.
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    void start();
  }, []);

  function next(): void { flushNow(); if (stepIdx < steps.length - 1) setStepIdx((n) => n + 1); else setPhase("review"); }
  function back(): void { flushNow(); if (stepIdx > 0) setStepIdx((n) => n - 1); }
  function jumpTo(id: StepId): void { const idx = steps.findIndex((s) => s.id === id); if (idx >= 0) { setStepIdx(idx); setPhase("wizard"); } }

  if (phase === "start") return <BootScreen error={error} onRetry={start} />;
  if (!intake) return <div className="p-8 text-[13px] text-meta">Loading…</div>;
  if (phase === "review") return <ReviewScreen intake={intake} onEdit={jumpTo} onBack={() => { setPhase("wizard"); setStepIdx(steps.length - 1); }} onCreate={() => submit(intake, setPhase, setError, setIntake)} error={error} />;
  if (phase === "submitting" || phase === "creating") return <CreatingScreen intake={intake} setIntake={setIntake} setPhase={setPhase} />;
  if (phase === "done") return <DoneScreen intake={intake} />;
  if (phase === "failed") return <FailedScreen intake={intake} onRetry={() => submit(intake, setPhase, setError, setIntake)} onBackToReview={() => setPhase("review")} />;

  // wizard
  return (
    <div className="mx-auto flex min-h-[calc(100dvh-8rem)] max-w-2xl flex-col px-4 py-5">
      <SectionRail steps={steps} current={stepIdx} />
      <div className="mt-5 flex-1">
        <h2 className="text-[22px] font-medium tracking-tight">{step.title}</h2>
        {step.subtitle && <p className="mt-1 text-[13.5px] text-meta">{step.subtitle}</p>}
        <div className="mt-5">
          <StepBody step={step} intake={intake} set={set} />
        </div>
      </div>
      <div className="mt-6 flex items-center justify-between gap-3">
        {stepIdx > 0
          ? <button onClick={back} className="flex items-center gap-1.5 rounded border border-border px-3 py-2 text-[13.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)]"><ArrowLeft className="size-4" /> Back</button>
          : <span />}
        <button onClick={next} disabled={!step.canNext(intake)} className="flex items-center gap-1.5 rounded border border-foreground/70 bg-foreground/[0.06] px-5 py-2 text-[14px] font-medium transition-colors hover:bg-[var(--row-hover)] disabled:cursor-not-allowed disabled:opacity-40">
          {stepIdx === steps.length - 1 ? "Review" : "Next"} <ArrowRight className="size-4" />
        </button>
      </div>
    </div>
  );
}

async function submit(intake: Intake, setPhase: (p: Phase) => void, setError: (e: string | null) => void, setIntake: (i: Intake) => void): Promise<void> {
  const miss = missingRequired(intake);
  if (miss.length) { setError(`Still missing: ${miss.join(", ")}`); return; }
  setError(null); setPhase("submitting");
  try {
    const r = await fetch(`/api/intake/${intake.id}/create`, { method: "POST" });
    const j = (await r.json()) as { ok?: boolean; status?: string; missing?: string[]; error?: string };
    if (j.ok) { setIntake({ ...intake, status: "creating", gsStatus: j.status === "created" ? "created" : "queued" }); setPhase("creating"); }
    else if (j.error === "missing_required") { setError(`Still missing: ${(j.missing ?? []).join(", ")}`); setPhase("review"); }
    else { setError(j.error ?? "Couldn't queue the quote."); setPhase("review"); }
  } catch { setError("Couldn't reach the server."); setPhase("review"); }
}

// ── Screens ────────────────────────────────────────────────────────────────────

// Entry state: New Project starts immediately (auto-started on mount), so this only shows a brief
// loading beat — or a retry if creating the draft failed. No "Start" gate.
function BootScreen({ error, onRetry }: { error: string | null; onRetry: () => void }): React.JSX.Element {
  return (
    <div className="mx-auto flex min-h-[calc(100dvh-8rem)] max-w-xl flex-col items-center justify-center px-4 text-center">
      {error ? (
        <>
          <div className="flex size-14 items-center justify-center rounded border border-border bg-panel"><FolderPlus className="size-6 text-foreground" /></div>
          <h1 className="mt-5 text-[22px] font-medium tracking-tight">New Project</h1>
          <p className="mt-2 text-[13.5px] text-critical">{error}</p>
          <button onClick={onRetry} className="mt-5 flex items-center gap-2 rounded border border-foreground/70 bg-foreground/[0.06] px-6 py-3 text-[15px] font-medium transition-colors hover:bg-[var(--row-hover)]">
            <RefreshCw className="size-4" /> Try again
          </button>
        </>
      ) : (
        <>
          <Loader2 className="size-7 animate-spin text-foreground" />
          <p className="mt-3 text-[13.5px] text-meta">Starting a new project…</p>
        </>
      )}
    </div>
  );
}

// The progress/context rail — the current section dominates; completed sections stay visible so the
// salesperson always sees where they are in the Customer → Event → Location → Schedule structure.
function SectionRail({ steps, current }: { steps: StepDef[]; current: number }): React.JSX.Element {
  const activeSection = sectionIndexOf(steps[current]?.id);
  const pct = Math.round(((current + 1) / steps.length) * 100);
  return (
    <div>
      <div className="flex items-center gap-1.5 overflow-x-auto whitespace-nowrap text-[11.5px]">
        {SECTIONS.map((s, i) => (
          <span key={s.label} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-border">/</span>}
            <span className={i === activeSection ? "font-medium text-foreground" : i < activeSection ? "text-tertiary-text" : "text-meta"}>{s.label}</span>
          </span>
        ))}
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-[var(--row)]"><div className="h-full bg-foreground/70 transition-all" style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

// ── Step bodies ──────────────────────────────────────────────────────────────
function StepBody({ step, intake, set }: { step: StepDef; intake: Intake; set: (p: IntakePatch) => void }): React.JSX.Element {
  switch (step.id) {
    case "customer": return <CustomerStep intake={intake} set={set} />;
    case "eventType": return (
      <div className="space-y-3">
        <ChoiceGrid options={EVENT_TYPES} value={intake.eventType} onChange={(v) => set({ eventType: v })} cols={2} />
        {intake.eventType === "other" && <TextField label="Describe the event type" value={intake.eventTypeOther} onChange={(v) => set({ eventTypeOther: v })} autoFocus />}
      </div>
    );
    case "locationClass": return <LocationClassStep intake={intake} set={set} />;
    case "guests": return <GuestsStep intake={intake} set={set} />;
    case "date": return <DateStep intake={intake} set={set} />;
    case "times": return <TimesStep intake={intake} set={set} />;
    case "location": return <LocationStep intake={intake} set={set} />;
    case "delivery": return <TriChoice value={intake.deliveryRequired} onChange={(v) => set({ deliveryRequired: v })} />;
    case "deliveryFlexible": return (
      <TriChoice
        value={intake.deliveryFlexible}
        onChange={(v) => set(v === "yes"
          ? { deliveryFlexible: "yes", deliveryTier: "standard", dropoffTime: "", pickupTime: "" } // yes → default flexible 9AM–8PM window
          : { deliveryFlexible: v, ...(intake.deliveryTier === "standard" ? { deliveryTier: "" } : {}) })} // no/not sure → pick a same-day window next
      />
    );
    case "deliveryType": return <DeliveryTypeStep intake={intake} set={set} />;
    case "deliveryTime": return <DeliveryTimeStep intake={intake} set={set} />;
    case "setup": return <TriChoice value={intake.setupRequired} onChange={(v) => set({ setupRequired: v })} />;
    case "pickup": return <TriChoice value={intake.pickupRequired} onChange={(v) => set({ pickupRequired: v })} />;
    case "access": return <AccessStep intake={intake} set={set} />;
    case "notes": return <TextArea value={intake.salesNotes} onChange={(v) => set({ salesNotes: v })} placeholder="e.g. Customer may add guests later; prefers a call back after 5pm." rows={6} autoFocus />;
  }
}

function CustomerStep({ intake, set }: { intake: Intake; set: (p: IntakePatch) => void }): React.JSX.Element {
  const [match, setMatch] = useState<{ name: string; email: string; phone: string; gsUrl: string } | null>(null);
  const [looked, setLooked] = useState("");
  useEffect(() => {
    const d = digits(intake.phone);
    if (d.length < 10 || d === looked) return;
    const t = setTimeout(async () => {
      setLooked(d);
      try {
        const r = await fetch("/api/intake/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: intake.phone }) });
        const j = (await r.json()) as { match: typeof match };
        setMatch(j.match);
      } catch { /* ignore */ }
    }, 600);
    return () => clearTimeout(t);
  }, [intake.phone, looked]);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <TextField label="First name" value={intake.firstName} onChange={(v) => set({ firstName: v })} autoFocus />
        <TextField label="Last name" value={intake.lastName} onChange={(v) => set({ lastName: v })} />
      </div>
      <TextField label="Phone" value={intake.phone} onChange={(v) => set({ phone: v })} type="tel" invalid={!!intake.phone && !phoneOk(intake.phone)} />
      <TextField label="Email" value={intake.email} onChange={(v) => set({ email: v })} type="email" invalid={!!intake.email && !EMAIL_RE.test(intake.email)} />
      {match && (
        <div className="rounded border border-attention/40 bg-attention/[0.07] p-3 text-[12.5px] text-attention">
          <div className="font-medium">We may already have this customer in our records.</div>
          <div className="mt-0.5">{match.name}{match.email ? ` · ${match.email}` : ""}</div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button onClick={() => { const [f, ...r] = (match.name || "").split(" "); set({ firstName: intake.firstName || f || "", lastName: intake.lastName || r.join(" "), email: intake.email || match.email }); }} className="rounded border border-attention/50 px-2 py-1 text-[12px] hover:bg-attention/10">Use their info</button>
            <a href={match.gsUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[12px] text-tertiary-text hover:bg-[var(--row-hover)]"><ExternalLink className="size-3" /> View in Goodshuffle</a>
          </div>
          <p className="mt-1.5 text-[11px] text-meta">Based on our records. Goodshuffle is checked again when the quote is created.</p>
        </div>
      )}
    </div>
  );
}

// The single "where's the delivery?" question — descriptive cards, and a business-hours callout the moment
// Commercial is picked so the salesperson sets that expectation on the call.
function LocationClassStep({ intake, set }: { intake: Intake; set: (p: IntakePatch) => void }): React.JSX.Element {
  return (
    <div className="space-y-2.5">
      {LOCATION_CLASSES.map((o) => {
        const on = intake.locationClass === o.v;
        return (
          <button key={o.v} onClick={() => set({ locationClass: o.v })} className={`w-full rounded border px-4 py-3.5 text-left transition-colors ${on ? "border-foreground/70 bg-foreground/[0.08]" : "border-border hover:bg-[var(--row-hover)]"}`}>
            <div className="flex items-center gap-2 text-[15px] font-medium">{on && <Check className="size-4" />}{o.label}</div>
            <div className="mt-0.5 text-[12.5px] text-meta">{o.desc}</div>
          </button>
        );
      })}
      {intake.locationClass === "commercial" && (
        <div className="flex items-start gap-2 rounded border border-attention/40 bg-attention/[0.07] p-3 text-[12.5px] text-attention">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>Office building — we&apos;ll schedule delivery within business hours (weekdays, ~9am–5pm). Set that expectation with the customer now.</span>
        </div>
      )}
    </div>
  );
}

// Shown only when they CAN'T do the flexible day-before window (deliveryFlexible !== "yes"): the same-day
// paid options (premium/exact) with prices, so the rep walks the customer through the choice. The flexible
// "standard" option lives in the day-before question, not here.
function DeliveryTypeStep({ intake, set }: { intake: Intake; set: (p: IntakePatch) => void }): React.JSX.Element {
  return (
    <div className="space-y-2.5">
      {DELIVERY_TYPES.filter((t) => t.v !== "standard").map((t) => {
        const on = intake.deliveryTier === t.v;
        return (
          <button
            key={t.v}
            onClick={() => set({ deliveryTier: t.v })}
            className={`w-full rounded border px-4 py-3.5 text-left transition-colors ${on ? "border-foreground/70 bg-foreground/[0.08]" : "border-border hover:bg-[var(--row-hover)]"}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              {on && <Check className="size-4 shrink-0" />}
              <span className="text-[15px] font-medium">{t.label}</span>
              {t.recommended && <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-emerald-300">Recommended</span>}
              <span className="ml-auto text-[12.5px] tabular-nums text-meta">{t.window} · {t.price}</span>
            </div>
            <div className="mt-1 text-[12.5px] text-meta">{t.note}</div>
          </button>
        );
      })}
    </div>
  );
}

// Only for premium/exact: the rep enters the START of each same-day window (drop-off + pick-up); the END is
// auto-computed to match the option — Premium = +2 hours, Exact = +30 minutes — and shown live. Both required.
function DeliveryTimeStep({ intake, set }: { intake: Intake; set: (p: IntakePatch) => void }): React.JSX.Element {
  const mins = intake.deliveryTier === "exact" ? 30 : 120;
  const width = intake.deliveryTier === "exact" ? "30-minute" : "2-hour";
  const dropWin = windowLabel(intake.dropoffTime, mins);
  const pickWin = windowLabel(intake.pickupTime, mins);
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-[11px] uppercase tracking-[0.08em] text-meta">Drop-off — window start</span>
          <input type="time" value={intake.dropoffTime} onChange={(e) => set({ dropoffTime: e.target.value })} autoFocus
            className="w-full rounded border border-border bg-[var(--row)] px-3 py-3 text-[16px] outline-none focus:border-foreground/40" />
          <span className="mt-1 block text-[12px] text-foreground/80">{dropWin ? `Window: ${dropWin}` : `Enter a time → ${width} window`}</span>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] uppercase tracking-[0.08em] text-meta">Pick-up — window start</span>
          <input type="time" value={intake.pickupTime} onChange={(e) => set({ pickupTime: e.target.value })}
            className="w-full rounded border border-border bg-[var(--row)] px-3 py-3 text-[16px] outline-none focus:border-foreground/40" />
          <span className="mt-1 block text-[12px] text-foreground/80">{pickWin ? `Window: ${pickWin}` : `Enter a time → ${width} window`}</span>
        </label>
      </div>
      <p className="text-[11px] text-meta">Enter the start of each window; we auto-fill the end to match the {width} option. This adds the {intake.deliveryTier === "exact" ? "exact-time" : "premium"} timing as its own line item in Goodshuffle.</p>
    </div>
  );
}

function GuestsStep({ intake, set }: { intake: Intake; set: (p: IntakePatch) => void }): React.JSX.Element {
  return (
    <div className="space-y-3">
      <input type="number" min={0} inputMode="numeric" value={intake.guestCount ?? ""} onChange={(e) => set({ guestCount: e.target.value === "" ? null : Math.max(0, Math.round(Number(e.target.value))), guestCountUnknown: false })} placeholder="Number of guests" autoFocus
        className="w-full rounded border border-border bg-[var(--row)] px-3 py-3 text-[18px] tabular-nums outline-none focus:border-foreground/40" />
      <button onClick={() => set({ guestCount: null, guestCountUnknown: !intake.guestCountUnknown })} className={`w-full rounded border px-3 py-2.5 text-[13.5px] transition-colors ${intake.guestCountUnknown ? "border-foreground/60 bg-foreground/[0.06]" : "border-border text-tertiary-text hover:bg-[var(--row-hover)]"}`}>
        {intake.guestCountUnknown ? "✓ " : ""}Customer doesn&apos;t know yet
      </button>
    </div>
  );
}

function DateStep({ intake, set }: { intake: Intake; set: (p: IntakePatch) => void }): React.JSX.Element {
  const past = intake.eventDate ? intake.eventDate < new Date().toISOString().slice(0, 10) : false;
  return (
    <div className="space-y-2">
      <input type="date" value={intake.eventDate} onChange={(e) => set({ eventDate: e.target.value })} autoFocus
        className="w-full rounded border border-border bg-[var(--row)] px-3 py-3 text-[16px] outline-none focus:border-foreground/40" />
      {past && <p className="flex items-center gap-1.5 text-[12.5px] text-attention"><AlertTriangle className="size-3.5" /> That date is in the past — confirm it before continuing.</p>}
      <p className="text-[11px] text-meta">This captures the event date. It does not promise Zoe can fulfill it.</p>
    </div>
  );
}

function TimesStep({ intake, set }: { intake: Intake; set: (p: IntakePatch) => void }): React.JSX.Element {
  const bad = intake.eventStartTime && intake.eventEndTime && intake.eventEndTime <= intake.eventStartTime;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3">
        <label className="block"><span className="mb-1 block text-[11px] uppercase tracking-[0.08em] text-meta">Start</span>
          <input type="time" value={intake.eventStartTime} onChange={(e) => set({ eventStartTime: e.target.value })} className="w-full rounded border border-border bg-[var(--row)] px-3 py-3 text-[16px] outline-none focus:border-foreground/40" /></label>
        <label className="block"><span className="mb-1 block text-[11px] uppercase tracking-[0.08em] text-meta">End</span>
          <input type="time" value={intake.eventEndTime} onChange={(e) => set({ eventEndTime: e.target.value })} className="w-full rounded border border-border bg-[var(--row)] px-3 py-3 text-[16px] outline-none focus:border-foreground/40" /></label>
      </div>
      {bad && <p className="flex items-center gap-1.5 text-[12.5px] text-critical"><AlertTriangle className="size-3.5" /> End time must be after the start time.</p>}
    </div>
  );
}

function LocationStep({ intake, set }: { intake: Intake; set: (p: IntakePatch) => void }): React.JSX.Element {
  return (
    <div className="space-y-3">
      <TextField label="Venue / location name" value={intake.venueName} onChange={(v) => set({ venueName: v })} placeholder="Leave blank if it's the customer's home" autoFocus />
      <AddressAutocomplete intake={intake} set={set} />
      <div className="grid grid-cols-[1fr_88px_110px] gap-3">
        <TextField label="City" value={intake.city} onChange={(v) => set({ city: v })} />
        <TextField label="State" value={intake.state} onChange={(v) => set({ state: v })} />
        <TextField label="ZIP" value={intake.zip} onChange={(v) => set({ zip: v })} />
      </div>
      <p className="text-[11px] text-meta">Start typing the street address to search — pick a match to fill city, state, and ZIP.</p>
    </div>
  );
}

// US state name → 2-letter, so a picked address matches the manual convention (Photon returns full names).
const US_STATE_ABBR: Record<string, string> = { "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE", "district of columbia": "DC", "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS", "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD", "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS", "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK", "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT", "vermont": "VT", "virginia": "VA", "washington": "WA", "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY" };
const abbrState = (s: string): string => US_STATE_ABBR[s.trim().toLowerCase()] ?? s;

interface PhotonProps { name?: string; housenumber?: string; street?: string; city?: string; district?: string; state?: string; postcode?: string; countrycode?: string }

// Free address autocomplete via Photon (komoot, OpenStreetMap) — no API key, CORS-enabled. Picking a
// suggestion fills street/city/state/ZIP; the salesperson can still edit any field afterward.
function AddressAutocomplete({ intake, set }: { intake: Intake; set: (p: IntakePatch) => void }): React.JSX.Element {
  const [suggestions, setSuggestions] = useState<PhotonProps[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  const onType = (v: string): void => {
    set({ streetAddress: v });
    if (timer.current) clearTimeout(timer.current);
    const q = v.trim();
    if (q.length < 4) { setSuggestions([]); setOpen(false); return; }
    const my = ++seq.current;
    timer.current = setTimeout(() => {
      void (async () => {
        try {
          const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=en`);
          const j = (await r.json()) as { features?: { properties: PhotonProps }[] };
          if (my !== seq.current) return; // a newer keystroke won
          const feats = (j.features ?? []).map((f) => f.properties).filter((p) => (p.street || p.name) && p.city);
          setSuggestions(feats.slice(0, 6));
          setOpen(feats.length > 0);
        } catch { /* autocomplete is best-effort */ }
      })();
    }, 300);
  };

  const pick = (p: PhotonProps): void => {
    const street = [p.housenumber, p.street].filter(Boolean).join(" ") || p.name || intake.streetAddress;
    set({ streetAddress: street, city: p.city || p.district || intake.city, state: p.state ? abbrState(p.state) : intake.state, zip: p.postcode || intake.zip });
    setOpen(false); setSuggestions([]);
    seq.current++; // ignore any in-flight response
  };

  const fmt = (p: PhotonProps): string => [[p.housenumber, p.street].filter(Boolean).join(" ") || p.name, p.city, p.state && abbrState(p.state), p.postcode].filter(Boolean).join(", ");

  return (
    <div className="relative">
      <label className="block">
        <span className="mb-1 block text-[11px] uppercase tracking-[0.08em] text-meta">Street address</span>
        <input
          value={intake.streetAddress}
          onChange={(e) => onType(e.target.value)}
          onFocus={() => { if (suggestions.length) setOpen(true); }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          autoComplete="off"
          placeholder="Start typing to search…"
          className="w-full rounded border border-border bg-[var(--row)] px-3 py-2.5 text-[15px] outline-none focus:border-foreground/40"
        />
      </label>
      {open && suggestions.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded border border-border bg-panel shadow-lg">
          {suggestions.map((p, i) => (
            <li key={i}>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); pick(p); }} className="block w-full px-3 py-2 text-left text-[13px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">
                {fmt(p)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AccessStep({ intake, set }: { intake: Intake; set: (p: IntakePatch) => void }): React.JSX.Element {
  const a = intake.accessNotes;
  const setA = (patch: Partial<Intake["accessNotes"]>): void => set({ accessNotes: { ...a, ...patch } });
  const residential = intake.locationClass === "residential";
  return (
    <div className="space-y-4">
      {residential ? (
        <>
          <MiniTri label="Are there stairs?" value={a.stairs ?? ""} onChange={(v) => setA({ stairs: v })} />
          <MiniTri label="Is there an elevator?" value={a.elevator ?? ""} onChange={(v) => setA({ elevator: v })} />
          <MiniTri label="Any parking / loading restrictions?" value={a.parkingRestrictions ?? ""} onChange={(v) => setA({ parkingRestrictions: v })} />
        </>
      ) : (
        <>
          <MiniTri label="Is there a loading dock?" value={a.loadingDock ?? ""} onChange={(v) => setA({ loadingDock: v })} />
          <MiniTri label="Any access restrictions?" value={a.accessRestrictions ?? ""} onChange={(v) => setA({ accessRestrictions: v })} />
          <MiniTri label="Long carry from truck to setup?" value={a.longCarry ?? ""} onChange={(v) => setA({ longCarry: v })} />
          <TextField label="Required delivery window (if any)" value={a.deliveryWindow ?? ""} onChange={(v) => setA({ deliveryWindow: v })} placeholder="e.g. must deliver 8–10am" />
        </>
      )}
      <TextArea value={a.crewNotes ?? ""} onChange={(v) => setA({ crewNotes: v })} placeholder="Anything the delivery / setup team should know" rows={3} label="For the crew" />
    </div>
  );
}

// ── Review + result screens ────────────────────────────────────────────────────
function ReviewScreen({ intake, onEdit, onBack, onCreate, error }: { intake: Intake; onEdit: (id: StepId) => void; onBack: () => void; onCreate: () => void; error: string | null }): React.JSX.Element {
  const miss = missingRequired(intake);
  return (
    <div className="mx-auto max-w-2xl px-4 py-5">
      <h1 className="text-[22px] font-medium tracking-tight">Review</h1>
      <p className="mt-1 text-[13px] text-meta">Check each section, then create the Goodshuffle project shell.</p>

      <div className="mt-4 space-y-3">
        <ReviewSection title="Customer" onEdit={() => onEdit("customer")} rows={[["Name", [intake.firstName, intake.lastName].filter(Boolean).join(" ")], ["Phone", intake.phone], ["Email", intake.email]]} />
        <ReviewSection title="Event" onEdit={() => onEdit("eventType")} rows={[["Type", intake.eventType === "other" ? intake.eventTypeOther || "Other" : intake.eventType || "—"], ["Guests", intake.guestCount != null ? String(intake.guestCount) : intake.guestCountUnknown ? "Unknown" : "Not asked"], ["Date", intake.eventDate || "—"], ["Time", intake.eventStartTime ? `${intake.eventStartTime}${intake.eventEndTime ? ` – ${intake.eventEndTime}` : ""}` : "—"]]} />
        <ReviewSection title="Location" onEdit={() => onEdit("locationClass")} rows={[["Setting", LOCATION_CLASSES.find((c) => c.v === intake.locationClass)?.label ?? "—"], ["Venue", intake.venueName || "—"], ["Address", [intake.streetAddress, intake.city, intake.state, intake.zip].filter(Boolean).join(", ") || "—"]]} />
        <ReviewSection title="Logistics" onEdit={() => onEdit("delivery")} rows={[["Delivery", triLabel(intake.deliveryRequired)], ...(intake.deliveryTier ? [["Timing", deliveryTimingSummary(intake)] as [string, string]] : []), ["Setup help", triLabel(intake.setupRequired)], ["Breakdown help", triLabel(intake.pickupRequired)]]} />
        <ReviewSection title="Notes" onEdit={() => onEdit("notes")} rows={[["Sales notes", intake.salesNotes || "—"]]} />
      </div>

      <div className="mt-5 rounded border border-sky-500/30 bg-sky-500/[0.06] p-3 text-[12.5px] text-sky-100">
        <div className="font-medium">Project shell ready to create.</div>
        <div className="mt-0.5 text-sky-200/90">Rental inventory is added manually in Goodshuffle after the project is created. This does not create a priced quote.</div>
      </div>

      {miss.length > 0 && <p className="mt-3 flex items-center gap-1.5 text-[13px] text-critical"><AlertTriangle className="size-4" /> Still missing: {miss.join(", ")}</p>}
      {error && <p className="mt-2 text-[13px] text-critical">{error}</p>}

      <div className="mt-5 flex items-center justify-between gap-3">
        <button onClick={onBack} className="flex items-center gap-1.5 rounded border border-border px-3 py-2 text-[13.5px] text-tertiary-text hover:bg-[var(--row-hover)]"><ArrowLeft className="size-4" /> Back</button>
        <button onClick={onCreate} disabled={miss.length > 0} className="flex items-center gap-2 rounded border border-emerald-500/50 bg-emerald-500/15 px-5 py-2.5 text-[14px] font-medium text-emerald-100 hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-40"><Check className="size-4" /> Create Project</button>
      </div>
    </div>
  );
}

function ReviewSection({ title, rows, onEdit }: { title: string; rows: [string, string][]; onEdit: () => void }): React.JSX.Element {
  return (
    <div className="rounded border border-border bg-panel p-3">
      <div className="mb-2 flex items-center justify-between"><div className="text-[11px] font-medium uppercase tracking-[0.1em] text-meta">{title}</div><button onClick={onEdit} className="text-[12px] text-tertiary-text underline underline-offset-2 hover:text-foreground">Edit</button></div>
      <dl className="space-y-1 text-[13px]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-2"><dt className="w-24 shrink-0 text-meta">{k}</dt><dd className="min-w-0 flex-1">{v || "—"}</dd></div>
        ))}
      </dl>
    </div>
  );
}

function CreatingScreen({ intake, setIntake, setPhase }: { intake: Intake; setIntake: (i: Intake) => void; setPhase: (p: Phase) => void }): React.JSX.Element {
  const [waited, setWaited] = useState(0);
  useEffect(() => {
    let live = true;
    const poll = async (): Promise<void> => {
      try {
        const r = await fetch(`/api/intake/${intake.id}`, { cache: "no-store" });
        const j = (await r.json()) as { intake?: Intake };
        if (!live || !j.intake) return;
        if (j.intake.gsStatus === "created") { setIntake(j.intake); setPhase("done"); return; }
        if (j.intake.gsStatus === "failed") { setIntake(j.intake); setPhase("failed"); return; }
      } catch { /* keep polling */ }
    };
    const iv = setInterval(() => { setWaited((w) => w + 1); void poll(); }, 2500);
    void poll();
    return () => { live = false; clearInterval(iv); };
  }, [intake.id, setIntake, setPhase]);
  const slow = waited > 8; // ~20s
  return (
    <div className="mx-auto flex min-h-[calc(100dvh-8rem)] max-w-xl flex-col items-center justify-center px-4 text-center">
      <Loader2 className="size-8 animate-spin text-foreground" />
      <h1 className="mt-4 text-[20px] font-medium">Creating the project in Goodshuffle…</h1>
      <p className="mt-2 max-w-sm text-[13px] text-meta">Your project is saved. This runs through the logged-in office session, so it can take a moment.</p>
      {slow && <p className="mt-3 max-w-sm text-[12.5px] text-attention">Still working. If the office Auto-Pull isn&apos;t running, it will finish on the next pull cycle. You can safely leave this open.</p>}
    </div>
  );
}

function DoneScreen({ intake }: { intake: Intake }): React.JSX.Element {
  return (
    <div className="mx-auto max-w-xl px-4 py-8">
      <div className="flex items-center gap-2 text-emerald-300"><div className="flex size-9 items-center justify-center rounded-full border border-emerald-500/40 bg-emerald-500/15"><Check className="size-5" /></div><h1 className="text-[22px] font-medium tracking-tight text-foreground">Project Created</h1></div>
      <dl className="mt-5 space-y-2 rounded border border-border bg-panel p-4 text-[14px]">
        <Row k="Customer" v={[intake.firstName, intake.lastName].filter(Boolean).join(" ") || "—"} />
        <Row k="Event" v={eventLabel(intake)} />
        <Row k="Date" v={formatEventDate(intake.eventDate) || "—"} />
        <Row k="Location" v={[intake.city, intake.state].filter(Boolean).join(", ") || intake.venueName || "—"} />
        <Row k="Goodshuffle Project" v="Created" tone="text-emerald-300" />
        <Row k="Inventory" v="Not yet added" tone="text-attention" />
      </dl>
      <div className="mt-5 flex flex-wrap gap-3">
        {intake.gsProjectUrl && <a href={intake.gsProjectUrl} target="_blank" rel="noreferrer" onClick={() => { void fetch(`/api/intake/${intake.id}/opened`, { method: "POST" }).catch(() => {}); }} className="flex items-center gap-2 rounded border border-foreground/70 bg-foreground/[0.06] px-5 py-2.5 text-[14px] font-medium hover:bg-[var(--row-hover)]"><ExternalLink className="size-4" /> Open in Goodshuffle</a>}
        <a href="/sales" className="flex items-center gap-1.5 rounded border border-border px-4 py-2.5 text-[13.5px] text-tertiary-text hover:bg-[var(--row-hover)]"><ArrowLeft className="size-4" /> Return to Sales</a>
      </div>
      <p className="mt-3 text-[12px] text-meta">This is the project shell — not a priced inventory quote. Add the rental inventory in Goodshuffle to finish it.</p>
    </div>
  );
}

const DONE_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "2027-06-20" → "June 20, 2027"; blank if unparseable. */
function formatEventDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || "");
  if (!m) return "";
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return "";
  return `${DONE_MONTHS[mo - 1]} ${Number(m[3])}, ${m[1]}`;
}
function eventLabel(i: Intake): string {
  if (i.eventType === "other") return i.eventTypeOther.trim() || "Other";
  return EVENT_TYPES.find((e) => e.v === i.eventType)?.label ?? "—";
}

function FailedScreen({ intake, onRetry, onBackToReview }: { intake: Intake; onRetry: () => void; onBackToReview: () => void }): React.JSX.Element {
  return (
    <div className="mx-auto max-w-xl px-4 py-8">
      <div className="flex items-center gap-2 text-critical"><AlertTriangle className="size-6" /><h1 className="text-[20px] font-medium tracking-tight text-foreground">Project not created</h1></div>
      <p className="mt-3 text-[13.5px] text-meta">Your project details were saved, but the Goodshuffle project was not created. {intake.gsError ? `(${intake.gsError})` : ""}</p>
      <div className="mt-5 flex flex-wrap gap-3">
        <button onClick={onRetry} className="flex items-center gap-2 rounded border border-foreground/70 bg-foreground/[0.06] px-5 py-2.5 text-[14px] font-medium hover:bg-[var(--row-hover)]"><RefreshCw className="size-4" /> Retry</button>
        <button onClick={onBackToReview} className="rounded border border-border px-4 py-2.5 text-[13.5px] text-tertiary-text hover:bg-[var(--row-hover)]">Back to review</button>
      </div>
    </div>
  );
}

// ── Small shared UI ─────────────────────────────────────────────────────────────
function Row({ k, v, tone }: { k: string; v: string; tone?: string }): React.JSX.Element {
  return <div className="flex gap-3"><dt className="w-28 shrink-0 text-meta">{k}</dt><dd className={`min-w-0 flex-1 ${tone ?? ""}`}>{v || "—"}</dd></div>;
}

function TextField({ label, value, onChange, type = "text", placeholder, autoFocus, invalid }: { label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string; autoFocus?: boolean; invalid?: boolean }): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] uppercase tracking-[0.08em] text-meta">{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoFocus={autoFocus}
        className={`w-full rounded border bg-[var(--row)] px-3 py-2.5 text-[15px] outline-none focus:border-foreground/40 ${invalid ? "border-critical/60" : "border-border"}`} />
    </label>
  );
}

function TextArea({ label, value, onChange, placeholder, rows = 4, autoFocus }: { label?: string; value: string; onChange: (v: string) => void; placeholder?: string; rows?: number; autoFocus?: boolean }): React.JSX.Element {
  return (
    <label className="block">
      {label && <span className="mb-1 block text-[11px] uppercase tracking-[0.08em] text-meta">{label}</span>}
      <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={rows} autoFocus={autoFocus}
        className="w-full resize-y rounded border border-border bg-[var(--row)] px-3 py-2.5 text-[14px] outline-none focus:border-foreground/40" />
    </label>
  );
}

function ChoiceGrid<T extends string>({ options, value, onChange, cols = 2, big }: { options: { v: T; label: string }[]; value: string; onChange: (v: T) => void; cols?: number; big?: boolean }): React.JSX.Element {
  return (
    <div className={`grid gap-2.5 ${cols === 2 ? "grid-cols-2" : "grid-cols-1"}`}>
      {options.map((o) => {
        const on = value === o.v;
        return (
          <button key={o.v} onClick={() => onChange(o.v)} className={`rounded border px-4 text-left text-[14.5px] transition-colors ${big ? "py-6 text-center text-[16px] font-medium" : "py-4"} ${on ? "border-foreground/70 bg-foreground/[0.08]" : "border-border hover:bg-[var(--row-hover)]"}`}>
            {on && <Check className="mb-1 inline size-4" />} {o.label}
          </button>
        );
      })}
    </div>
  );
}

function TriChoice({ value, onChange }: { value: TriState; onChange: (v: TriState) => void }): React.JSX.Element {
  const opts: { v: TriState; label: string }[] = [{ v: "yes", label: "Yes" }, { v: "no", label: "No" }, { v: "not_sure", label: "Not sure" }];
  return (
    <div className="grid grid-cols-3 gap-2.5">
      {opts.map((o) => {
        const on = value === o.v;
        return <button key={o.v} onClick={() => onChange(o.v)} className={`rounded border py-6 text-center text-[15px] font-medium transition-colors ${on ? "border-foreground/70 bg-foreground/[0.08]" : "border-border hover:bg-[var(--row-hover)]"}`}>{o.label}</button>;
      })}
    </div>
  );
}

function MiniTri({ label, value, onChange }: { label: string; value: TriState; onChange: (v: TriState) => void }): React.JSX.Element {
  const opts: { v: TriState; label: string }[] = [{ v: "yes", label: "Yes" }, { v: "no", label: "No" }, { v: "not_sure", label: "Not sure" }];
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-[13.5px]">{label}</span>
      <div className="flex gap-1.5">
        {opts.map((o) => { const on = value === o.v; return <button key={o.v} onClick={() => onChange(o.v)} className={`rounded border px-3 py-1.5 text-[12.5px] transition-colors ${on ? "border-foreground/70 bg-foreground/[0.08]" : "border-border text-tertiary-text hover:bg-[var(--row-hover)]"}`}>{o.label}</button>; })}
      </div>
    </div>
  );
}

function triLabel(v: TriState): string { return v === "yes" ? "Yes" : v === "no" ? "No" : v === "not_sure" ? "Not sure" : "Not asked"; }

// HH:MM (24h) → 12-hour clock ("14:00" → "2:00 PM"). Blank if unparseable.
function to12(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
  if (!m) return "";
  let h = Number(m[1]);
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ap}`;
}
// A same-day delivery window from a START time + duration (minutes): "10:00 AM – 12:00 PM". Wraps at midnight.
function windowLabel(start: string, mins: number): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(start || "");
  if (!m) return "";
  let t = (Number(m[1]) * 60 + Number(m[2]) + mins) % 1440;
  if (t < 0) t += 1440;
  const end = `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  return `${to12(start)} – ${to12(end)}`;
}

// Review-row summary of the chosen delivery type (+ computed windows for same-day options).
function deliveryTimingSummary(i: Intake): string {
  const t = DELIVERY_TYPES.find((x) => x.v === i.deliveryTier);
  if (!t) return "—";
  if (i.deliveryTier === "standard") return `${t.label} (${t.window}, ${t.price})`;
  const mins = i.deliveryTier === "exact" ? 30 : 120;
  const parts: string[] = [];
  if (i.dropoffTime) parts.push(`drop-off ${windowLabel(i.dropoffTime, mins)}`);
  if (i.pickupTime) parts.push(`pick-up ${windowLabel(i.pickupTime, mins)}`);
  const times = parts.length ? `, ${parts.join(" / ")}` : "";
  return `${t.label} (${t.window}, ${t.price}${times})`;
}
