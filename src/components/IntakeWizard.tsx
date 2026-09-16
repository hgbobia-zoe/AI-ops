"use client";

// Guided Sales Intake — the on-the-phone wizard. One question at a time, large tap targets, autosave,
// back navigation, branching, then a review and the Goodshuffle create. Deterministic: the salesperson
// supplies every fact; the wizard only decides which question comes next and what's required. UNKNOWN /
// "Not sure" are first-class, never inferred to No. Inventory is intentionally NOT here — it's added in
// Goodshuffle after the shell is created.

import { useEffect, useRef, useState, useCallback } from "react";
import { Phone, ArrowLeft, ArrowRight, Check, ExternalLink, Loader2, AlertTriangle, RefreshCw, UserPlus } from "lucide-react";
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
const LOCATION_TYPES: { v: Intake["locationType"]; label: string }[] = [
  { v: "residential", label: "Residential" },
  { v: "venue", label: "Event venue" },
  { v: "hotel", label: "Hotel" },
  { v: "corporate", label: "Corporate / Office" },
  { v: "school", label: "School" },
  { v: "park", label: "Park / Public space" },
  { v: "other", label: "Other" },
];

// ── Step registry (branching via `when`) ───────────────────────────────────────
type StepId =
  | "customer" | "eventType" | "customerType" | "guests" | "date" | "times"
  | "location" | "locationType" | "delivery" | "setup" | "pickup" | "access" | "notes";

interface StepDef {
  id: StepId;
  title: string;
  subtitle?: string;
  when?: (i: Intake) => boolean;
  canNext: (i: Intake) => boolean;
}

const STEPS: StepDef[] = [
  { id: "customer", title: "Who are we helping?", subtitle: "Capture this while you have them on the line.", canNext: (i) => !!i.firstName.trim() && !!i.lastName.trim() && phoneOk(i.phone) && EMAIL_RE.test(i.email) },
  { id: "eventType", title: "What type of event is this?", canNext: (i) => !!i.eventType && (i.eventType !== "other" || !!i.eventTypeOther.trim()) },
  { id: "customerType", title: "Commercial or residential?", canNext: (i) => !!i.customerType },
  { id: "guests", title: "About how many guests?", subtitle: "A rough number is fine.", canNext: (i) => i.guestCount != null || i.guestCountUnknown },
  { id: "date", title: "What's the event date?", canNext: (i) => !!i.eventDate },
  { id: "times", title: "What time does it start and end?", canNext: (i) => !i.eventStartTime || !i.eventEndTime || i.eventEndTime > i.eventStartTime },
  { id: "location", title: "Where's the event?", canNext: () => true },
  { id: "locationType", title: "What kind of location?", canNext: () => true },
  { id: "delivery", title: "Will they need delivery?", canNext: () => true },
  { id: "setup", title: "Will we set anything up?", canNext: () => true },
  { id: "pickup", title: "Will we pick everything up after?", canNext: () => true },
  { id: "access", title: "A quick logistics check", subtitle: "Just the basics — the full survey happens later.", when: (i) => i.deliveryRequired !== "no" || i.setupRequired !== "no" || i.pickupRequired !== "no", canNext: () => true },
  { id: "notes", title: "Anything else worth noting?", subtitle: "Free-form. Keep facts in the fields above; put color here.", canNext: () => true },
];

export function IntakeWizard(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>("start");
  const [intake, setIntake] = useState<Intake | null>(null);
  const [stepIdx, setStepIdx] = useState(0);
  const [starting, setStarting] = useState(false);
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
    setStarting(true); setError(null);
    try {
      const r = await fetch("/api/intake", { method: "POST" });
      const j = (await r.json()) as { intake?: Intake };
      if (j.intake) { setIntake(j.intake); setStepIdx(0); setPhase("wizard"); }
      else setError("Couldn't start a call. Try again.");
    } catch { setError("Couldn't start a call. Try again."); }
    finally { setStarting(false); }
  }

  function next(): void { flushNow(); if (stepIdx < steps.length - 1) setStepIdx((n) => n + 1); else setPhase("review"); }
  function back(): void { flushNow(); if (stepIdx > 0) setStepIdx((n) => n - 1); else setPhase("start"); }
  function jumpTo(id: StepId): void { const idx = steps.findIndex((s) => s.id === id); if (idx >= 0) { setStepIdx(idx); setPhase("wizard"); } }

  if (phase === "start") return <StartScreen onStart={start} starting={starting} error={error} />;
  if (!intake) return <div className="p-8 text-[13px] text-meta">Loading…</div>;
  if (phase === "review") return <ReviewScreen intake={intake} onEdit={jumpTo} onBack={() => { setPhase("wizard"); setStepIdx(steps.length - 1); }} onCreate={() => submit(intake, setPhase, setError, setIntake)} error={error} />;
  if (phase === "submitting" || phase === "creating") return <CreatingScreen intake={intake} setIntake={setIntake} setPhase={setPhase} />;
  if (phase === "done") return <DoneScreen intake={intake} onNew={() => { setIntake(null); setPhase("start"); }} />;
  if (phase === "failed") return <FailedScreen intake={intake} onRetry={() => submit(intake, setPhase, setError, setIntake)} onBackToReview={() => setPhase("review")} />;

  // wizard
  return (
    <div className="mx-auto flex min-h-[calc(100dvh-8rem)] max-w-2xl flex-col px-4 py-5">
      <ProgressBar current={stepIdx} total={steps.length} />
      <div className="mt-5 flex-1">
        <h2 className="text-[22px] font-medium tracking-tight">{step.title}</h2>
        {step.subtitle && <p className="mt-1 text-[13.5px] text-meta">{step.subtitle}</p>}
        <div className="mt-5">
          <StepBody step={step} intake={intake} set={set} />
        </div>
      </div>
      <div className="mt-6 flex items-center justify-between gap-3">
        <button onClick={back} className="flex items-center gap-1.5 rounded border border-border px-3 py-2 text-[13.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)]"><ArrowLeft className="size-4" /> Back</button>
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

function StartScreen({ onStart, starting, error }: { onStart: () => void; starting: boolean; error: string | null }): React.JSX.Element {
  return (
    <div className="mx-auto flex min-h-[calc(100dvh-8rem)] max-w-2xl flex-col items-center justify-center px-4 text-center">
      <div className="flex size-14 items-center justify-center rounded-full border border-border bg-panel"><Phone className="size-6 text-foreground" /></div>
      <h1 className="mt-5 text-[26px] font-medium tracking-tight">Guided sales intake</h1>
      <p className="mt-2 max-w-md text-[14px] text-meta">Follow the same discovery on every call. Capture the customer and event, then create the Goodshuffle quote shell. You add the rental inventory in Goodshuffle after.</p>
      <button onClick={onStart} disabled={starting} className="mt-7 flex items-center gap-2 rounded border border-foreground/70 bg-foreground/[0.06] px-6 py-3 text-[15px] font-medium transition-colors hover:bg-[var(--row-hover)] disabled:opacity-50">
        {starting ? <Loader2 className="size-4 animate-spin" /> : <Phone className="size-4" />} Start new call
      </button>
      {error && <p className="mt-3 text-[13px] text-critical">{error}</p>}
    </div>
  );
}

function ProgressBar({ current, total }: { current: number; total: number }): React.JSX.Element {
  const pct = Math.round(((current + 1) / total) * 100);
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] text-meta"><span>Step {current + 1} of {total}</span><span className="tabular-nums">{pct}%</span></div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--row)]"><div className="h-full bg-foreground/70 transition-all" style={{ width: `${pct}%` }} /></div>
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
    case "customerType": return <ChoiceGrid options={[{ v: "commercial", label: "Commercial" }, { v: "residential", label: "Residential" }]} value={intake.customerType} onChange={(v) => set({ customerType: v })} cols={2} big />;
    case "guests": return <GuestsStep intake={intake} set={set} />;
    case "date": return <DateStep intake={intake} set={set} />;
    case "times": return <TimesStep intake={intake} set={set} />;
    case "location": return <LocationStep intake={intake} set={set} />;
    case "locationType": return <ChoiceGrid options={LOCATION_TYPES} value={intake.locationType} onChange={(v) => set({ locationType: v })} cols={2} />;
    case "delivery": return <TriChoice value={intake.deliveryRequired} onChange={(v) => set({ deliveryRequired: v })} />;
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
      <TextField label="Street address" value={intake.streetAddress} onChange={(v) => set({ streetAddress: v })} />
      <div className="grid grid-cols-[1fr_88px_110px] gap-3">
        <TextField label="City" value={intake.city} onChange={(v) => set({ city: v })} />
        <TextField label="State" value={intake.state} onChange={(v) => set({ state: v })} />
        <TextField label="ZIP" value={intake.zip} onChange={(v) => set({ zip: v })} />
      </div>
      <p className="text-[11px] text-meta">Don&apos;t infer the address — capture only what the customer gives you.</p>
    </div>
  );
}

function AccessStep({ intake, set }: { intake: Intake; set: (p: IntakePatch) => void }): React.JSX.Element {
  const a = intake.accessNotes;
  const setA = (patch: Partial<Intake["accessNotes"]>): void => set({ accessNotes: { ...a, ...patch } });
  const residential = intake.locationType === "residential" || intake.customerType === "residential";
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
      <h1 className="text-[22px] font-medium tracking-tight">Review the intake</h1>
      <p className="mt-1 text-[13px] text-meta">Check each section, then create the Goodshuffle quote shell.</p>

      <div className="mt-4 space-y-3">
        <ReviewSection title="Customer" onEdit={() => onEdit("customer")} rows={[["Name", [intake.firstName, intake.lastName].filter(Boolean).join(" ")], ["Phone", intake.phone], ["Email", intake.email]]} />
        <ReviewSection title="Event" onEdit={() => onEdit("eventType")} rows={[["Type", intake.eventType === "other" ? intake.eventTypeOther || "Other" : intake.eventType || "—"], ["Setting", intake.customerType || "—"], ["Guests", intake.guestCount != null ? String(intake.guestCount) : intake.guestCountUnknown ? "Unknown" : "Not asked"], ["Date", intake.eventDate || "—"], ["Time", intake.eventStartTime ? `${intake.eventStartTime}${intake.eventEndTime ? ` – ${intake.eventEndTime}` : ""}` : "—"]]} />
        <ReviewSection title="Location" onEdit={() => onEdit("location")} rows={[["Venue", intake.venueName || "—"], ["Address", [intake.streetAddress, intake.city, intake.state, intake.zip].filter(Boolean).join(", ") || "—"], ["Type", intake.locationType || "—"]]} />
        <ReviewSection title="Logistics" onEdit={() => onEdit("delivery")} rows={[["Delivery", triLabel(intake.deliveryRequired)], ["Setup", triLabel(intake.setupRequired)], ["Pickup", triLabel(intake.pickupRequired)]]} />
        <ReviewSection title="Notes" onEdit={() => onEdit("notes")} rows={[["Sales notes", intake.salesNotes || "—"]]} />
      </div>

      <div className="mt-5 rounded border border-sky-500/30 bg-sky-500/[0.06] p-3 text-[12.5px] text-sky-100">
        <div className="font-medium">Quote shell ready to create.</div>
        <div className="mt-0.5 text-sky-200/90">Rental inventory is added manually in Goodshuffle after the quote is created. This does not create a priced quote.</div>
      </div>

      {miss.length > 0 && <p className="mt-3 flex items-center gap-1.5 text-[13px] text-critical"><AlertTriangle className="size-4" /> Still missing: {miss.join(", ")}</p>}
      {error && <p className="mt-2 text-[13px] text-critical">{error}</p>}

      <div className="mt-5 flex items-center justify-between gap-3">
        <button onClick={onBack} className="flex items-center gap-1.5 rounded border border-border px-3 py-2 text-[13.5px] text-tertiary-text hover:bg-[var(--row-hover)]"><ArrowLeft className="size-4" /> Back</button>
        <button onClick={onCreate} disabled={miss.length > 0} className="flex items-center gap-2 rounded border border-emerald-500/50 bg-emerald-500/15 px-5 py-2.5 text-[14px] font-medium text-emerald-100 hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-40"><Check className="size-4" /> Create quote</button>
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
      <h1 className="mt-4 text-[20px] font-medium">Creating the quote in Goodshuffle…</h1>
      <p className="mt-2 max-w-sm text-[13px] text-meta">Your intake is saved. This runs through the logged-in office session, so it can take a moment.</p>
      {slow && <p className="mt-3 max-w-sm text-[12.5px] text-attention">Still working. If the office Auto-Pull isn&apos;t running, it will finish on the next pull cycle. You can safely leave this open.</p>}
    </div>
  );
}

function DoneScreen({ intake, onNew }: { intake: Intake; onNew: () => void }): React.JSX.Element {
  return (
    <div className="mx-auto max-w-xl px-4 py-8">
      <div className="flex items-center gap-2 text-emerald-300"><div className="flex size-9 items-center justify-center rounded-full border border-emerald-500/40 bg-emerald-500/15"><Check className="size-5" /></div><h1 className="text-[22px] font-medium tracking-tight text-foreground">Quote created</h1></div>
      <dl className="mt-5 space-y-2 rounded border border-border bg-panel p-4 text-[14px]">
        <Row k="Customer" v={[intake.firstName, intake.lastName].filter(Boolean).join(" ")} />
        <Row k="Event" v={intake.eventType === "other" ? intake.eventTypeOther || "Other" : intake.eventType} />
        <Row k="Date" v={intake.eventDate} />
        <Row k="Location" v={[intake.city, intake.state].filter(Boolean).join(", ") || intake.venueName || "—"} />
        <Row k="Goodshuffle" v="Created" tone="text-emerald-300" />
        <Row k="Inventory" v="Not yet added — add it in Goodshuffle" tone="text-attention" />
      </dl>
      <div className="mt-5 flex flex-wrap gap-3">
        {intake.gsProjectUrl && <a href={intake.gsProjectUrl} target="_blank" rel="noreferrer" onClick={() => { void fetch(`/api/intake/${intake.id}/opened`, { method: "POST" }).catch(() => {}); }} className="flex items-center gap-2 rounded border border-foreground/70 bg-foreground/[0.06] px-5 py-2.5 text-[14px] font-medium hover:bg-[var(--row-hover)]"><ExternalLink className="size-4" /> Open quote in Goodshuffle</a>}
        <button onClick={onNew} className="flex items-center gap-1.5 rounded border border-border px-4 py-2.5 text-[13.5px] text-tertiary-text hover:bg-[var(--row-hover)]"><UserPlus className="size-4" /> New call</button>
      </div>
      <p className="mt-3 text-[12px] text-meta">Now add the rental inventory in Goodshuffle to finish the quote.</p>
    </div>
  );
}

function FailedScreen({ intake, onRetry, onBackToReview }: { intake: Intake; onRetry: () => void; onBackToReview: () => void }): React.JSX.Element {
  return (
    <div className="mx-auto max-w-xl px-4 py-8">
      <div className="flex items-center gap-2 text-critical"><AlertTriangle className="size-6" /><h1 className="text-[20px] font-medium tracking-tight text-foreground">Quote not created</h1></div>
      <p className="mt-3 text-[13.5px] text-meta">Your sales intake was saved, but the Goodshuffle quote was not created. {intake.gsError ? `(${intake.gsError})` : ""}</p>
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
