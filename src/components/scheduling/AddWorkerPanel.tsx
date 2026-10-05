"use client";

// Add-worker flow — the new per-route assignment path (opened from a route card's "Add worker"). Three
// steps: pick a Title (role), pick a source (Connecteam | Instawork), then act.
//   • Connecteam → shows who's actually FREE for the route window + role (recommendCrew, computed on the
//     server and passed in), least-loaded first, then the full roster. Picking someone assigns them to
//     that route+role StaffShift (creating the shift if that role has none yet), then offers a Connecteam
//     publish (notifies the crew).
//   • Instawork → if a gig already covers this role+day it says so (already posted — N booked). If none,
//     it lets the dispatcher PROPOSE a gig (position + window + pay + headcount) which is RECORDED on the
//     shift (instaworkHeadcount + payRate + a note) — it is NOT posted to Instawork (the write endpoint
//     isn't captured yet), mirroring the ShiftEditor's "wired next" pattern. Honest: no fabricated gig.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Check, X, ChevronLeft, Send } from "lucide-react";
import type { CrewMember } from "@/lib/connecteam";
import type { CrewRecommendation } from "@/lib/scheduling/availability";
import { shiftGap, type ShiftRole, type StaffShift } from "@/lib/scheduling/types";
import {
  classifyWorkerFor,
  eligibilityView,
  dayTz,
  type EligibilityTone,
  type WorkerDayEligibilityData,
} from "@/lib/scheduling/eligibilityLabel";
import { instaworkCoversRole, type InstaworkRoleSummary } from "@/lib/instawork/reconcile";
import { ROLE_LABEL, type MatchedGig, type RouteCardData } from "@/components/scheduling/RouteStaffBoard";

/** Tone → badge classes, shared by the eligibility labels. */
export const ELIG_BADGE: Record<EligibilityTone, string> = {
  preferred: "border-positive/40 text-positive",
  available: "border-border text-meta",
  conflict: "border-attention/40 text-attention",
  assigned: "border-border text-meta",
  unavailable: "border-critical/50 text-critical",
  unknown: "border-attention/40 text-attention",
};

const BTN =
  "inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50 disabled:pointer-events-none";
const INPUT =
  "w-full rounded border border-border bg-background px-2.5 py-1.5 text-[13px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const LABEL = "text-[11px] uppercase tracking-[0.08em] text-meta";

const ROLES: ShiftRole[] = ["driver", "field", "prep"];
// Instawork position proposed per role (Field → General Labor, Driver → Driver). Prep tops up with labor.
const IW_POSITION: Record<ShiftRole, string> = { driver: "Driver", field: "General Labor", prep: "General Labor" };

type Source = "connecteam" | "instawork";

export function AddWorkerPanel({
  date,
  card,
  shifts,
  roster,
  eligibilityData,
  recsByRole,
  instawork,
  iwConfigured,
  onClose,
}: {
  date: string;
  card: RouteCardData;
  shifts: StaffShift[]; // this route's existing shifts
  roster: CrewMember[];
  eligibilityData: WorkerDayEligibilityData;
  recsByRole: Partial<Record<ShiftRole, CrewRecommendation[]>>;
  instawork: Record<ShiftRole, InstaworkRoleSummary> | null;
  iwConfigured: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const router = useRouter();
  // The route window (Unix seconds) the eligibility classifier reasons about for THIS card.
  const routeWindow = useMemo(() => {
    const s = card.windowKnown && card.startTime ? Math.floor(Date.parse(card.startTime) / 1000) : null;
    const e = card.windowKnown && card.endTime ? Math.floor(Date.parse(card.endTime) / 1000) : null;
    return s != null && e != null && !Number.isNaN(s) && !Number.isNaN(e) ? { start: s, end: e } : null;
  }, [card.windowKnown, card.startTime, card.endTime]);
  const tz = useMemo(() => dayTz(eligibilityData), [eligibilityData]);
  // Default to the first role on the route that still has a gap, else driver.
  const defaultRole: ShiftRole =
    ROLES.find((r) => {
      const rs = shifts.filter((s) => s.role === r);
      return rs.length > 0 && rs.some((s) => shiftGap(s) > 0);
    }) ?? "driver";

  const [role, setRole] = useState<ShiftRole>(defaultRole);
  const [source, setSource] = useState<Source | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The shift we just assigned to (so we can offer a publish). Null until an assign happens.
  const [assignedShiftId, setAssignedShiftId] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState<string[]>([]); // names added this session

  const roleShifts = shifts.filter((s) => s.role === role);
  const existingAssignees = new Set<number>(roleShifts.flatMap((s) => s.assignees));
  const roleGap = roleShifts.reduce((n, s) => n + shiftGap(s), 0);
  const recs = (recsByRole[role] ?? []).filter((r) => !existingAssignees.has(r.userId));
  const rosterForRole = roster.filter((m) => {
    if (role === "driver") return m.role === "driver";
    return m.role === "prep" || m.role === "other"; // field/prep: warehouse + general crew (office excluded by recommendCrew only)
  });

  // The route+role shift we'll attach to. Create one if the role has none yet.
  async function ensureShift(): Promise<StaffShift | null> {
    if (roleShifts.length > 0) return roleShifts[0];
    const res = await fetch("/api/scheduling/shift", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date,
        role,
        headcount: 1,
        startTime: card.startTime,
        endTime: card.endTime,
        windowKnown: card.windowKnown,
        location: null,
        routeId: card.routeId,
        truckId: card.truckId,
        eventLabel: card.eventLabel,
        source: "manual",
      }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { shift?: StaffShift };
    return j.shift ?? null;
  }

  async function assignConnecteam(userId: number, name: string): Promise<void> {
    setWorking(true);
    setError(null);
    try {
      const shift = await ensureShift();
      if (!shift) {
        setError("Couldn't create the shift. Try again.");
        return;
      }
      const nextAssignees = shift.assignees.includes(userId) ? shift.assignees : [...shift.assignees, userId];
      const nextHeadcount = Math.max(shift.headcount, nextAssignees.length);
      const res = await fetch(`/api/scheduling/shift/${shift.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignees: nextAssignees, headcount: nextHeadcount }),
      });
      if (!res.ok) {
        setError("Couldn't assign — try again.");
        return;
      }
      setAssignedShiftId(shift.id);
      setJustAdded((a) => (a.includes(name) ? a : [...a, name]));
      router.refresh();
    } catch {
      setError("Couldn't assign — try again.");
    } finally {
      setWorking(false);
    }
  }

  // Publish the assigned shift to Connecteam (confirm first, then publish — mirrors ShiftEditor).
  async function publish(): Promise<void> {
    if (!assignedShiftId) return;
    if (!card.windowKnown || !card.startTime || !card.endTime) {
      setError("Set a start and end time on the shift first (open it from the route card).");
      return;
    }
    if (!window.confirm(`Publish this ${ROLE_LABEL[role]} shift to Connecteam and notify the crew?`)) return;
    setWorking(true);
    setError(null);
    try {
      const confirmRes = await fetch(`/api/scheduling/shift/${assignedShiftId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "confirmed" }),
      });
      if (!confirmRes.ok) {
        setError("Couldn't confirm the shift before publishing.");
        return;
      }
      const res = await fetch(`/api/scheduling/shift/${assignedShiftId}/publish`, { method: "POST" });
      const j = (await res.json().catch(() => null)) as { message?: string; notified?: number } | null;
      if (!res.ok) {
        setError(j?.message || "Connecteam publish failed. Try again.");
        return;
      }
      toast.success(`Published to Connecteam — notified ${j?.notified ?? justAdded.length} crew`);
      onClose();
      router.refresh();
    } catch {
      setError("Connecteam publish failed. Try again.");
    } finally {
      setWorking(false);
    }
  }

  // ── Instawork gig proposal (recorded, NOT posted) ───────────────────────────
  const matchedGigs: MatchedGig[] = card.gigs.filter((g) => instaworkCoversRole(g.position, role));
  const gigBooked = matchedGigs.reduce((n, g) => n + g.filled, 0);
  const gigPending = matchedGigs.reduce((n, g) => n + g.pending, 0);
  const [gigHeadcount, setGigHeadcount] = useState<number>(Math.max(1, roleGap || 1));
  const [payRate, setPayRate] = useState<string>("");
  const [requested, setRequested] = useState(false);

  async function requestGig(): Promise<void> {
    setWorking(true);
    setError(null);
    try {
      const shift = await ensureShift();
      if (!shift) {
        setError("Couldn't create the shift to record the request. Try again.");
        return;
      }
      const pay = payRate.trim() === "" ? null : Number(payRate);
      const noteLine = `Instawork gig requested: ${gigHeadcount}× ${IW_POSITION[role]}${pay != null && Number.isFinite(pay) ? ` @ $${pay}/hr` : ""} (not yet posted — write endpoint pending).`;
      const notes = shift.notes ? `${shift.notes}\n${noteLine}` : noteLine;
      const res = await fetch(`/api/scheduling/shift/${shift.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instaworkHeadcount: gigHeadcount,
          payRate: pay != null && Number.isFinite(pay) ? pay : null,
          notes,
        }),
      });
      if (!res.ok) {
        setError("Couldn't record the gig request. Try again.");
        return;
      }
      setRequested(true);
      router.refresh();
    } catch {
      setError("Couldn't record the gig request. Try again.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-medium text-foreground">Add worker · {card.truckName}</h2>
          <p className="truncate text-[12px] text-meta">{card.eventLabel || `${card.stopCount} stops`}</p>
        </div>
        <button onClick={onClose} aria-label="Close" className="flex size-8 items-center justify-center rounded border border-border text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {/* Step 1 — Title (role) */}
        <div className="mb-4">
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className={LABEL}>1 · Title</span>
            {roleGap > 0 && <span className="text-[11.5px] text-attention">{roleGap} to fill</span>}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {ROLES.map((r) => (
              <button
                key={r}
                onClick={() => { setRole(r); setSource(null); setAssignedShiftId(null); setRequested(false); }}
                className={`rounded border px-3 py-1.5 text-[12.5px] transition-colors ${role === r ? "border-foreground bg-foreground/[0.08] text-foreground" : "border-border text-tertiary-text hover:bg-[var(--row-hover)]"}`}
              >
                {ROLE_LABEL[r]}
              </button>
            ))}
          </div>
        </div>

        {/* Step 2 — Source */}
        <div className="mb-4">
          <span className={LABEL}>2 · From where</span>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <button
              onClick={() => setSource("connecteam")}
              className={`rounded border px-3 py-1.5 text-[12.5px] transition-colors ${source === "connecteam" ? "border-foreground bg-foreground/[0.08] text-foreground" : "border-border text-tertiary-text hover:bg-[var(--row-hover)]"}`}
            >
              Connecteam (internal)
            </button>
            <button
              onClick={() => setSource("instawork")}
              className={`rounded border px-3 py-1.5 text-[12.5px] transition-colors ${source === "instawork" ? "border-foreground bg-foreground/[0.08] text-foreground" : "border-border text-tertiary-text hover:bg-[var(--row-hover)]"}`}
            >
              Instawork (temp)
            </button>
          </div>
        </div>

        {/* Step 3a — Connecteam availability */}
        {source === "connecteam" && (
          <div>
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-positive">
              <ChevronLeft className="hidden" /> Free this window · {ROLE_LABEL[role]}
            </div>
            {recs.length > 0 ? (
              <div className="mb-3 space-y-0.5 rounded border border-positive/30 bg-positive/[0.06] p-2">
                {recs.map((r) => {
                  const added = justAdded.includes(r.name);
                  return (
                    <button
                      key={r.userId}
                      type="button"
                      disabled={working || added}
                      onClick={() => assignConnecteam(r.userId, r.name)}
                      className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-[12.5px] transition-colors hover:bg-[var(--row-hover)] disabled:opacity-60"
                    >
                      <span className="min-w-0 truncate">
                        <span className="font-medium text-foreground">{r.name}</span>
                        <span className="ml-1.5 text-[11px] text-meta">{r.reason}</span>
                      </span>
                      <span className={`shrink-0 text-[11px] ${added ? "text-positive" : "text-tertiary-text"}`}>{added ? "Added ✓" : "+ Add"}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="mb-3 text-[11.5px] text-meta">
                {role === "field"
                  ? "No internal crew free for this window — post General Labor on Instawork for the gap."
                  : "No one free for this window — pick from the roster below, or try Instawork."}
              </p>
            )}

            <span className={LABEL}>Roster · {ROLE_LABEL[role]}</span>
            {rosterForRole.length === 0 ? (
              <p className="mt-1 text-[12.5px] text-meta">No Connecteam roster available.</p>
            ) : (
              <div className="mt-1 max-h-60 space-y-1 overflow-y-auto rounded border border-border p-1.5">
                {rosterForRole.map((m) => {
                  const added = justAdded.includes(m.name) || existingAssignees.has(m.userId);
                  const roleShiftId = roleShifts[0]?.id;
                  const view = eligibilityView(classifyWorkerFor(eligibilityData, m.userId, routeWindow, roleShiftId), tz);
                  return (
                    <button
                      key={m.userId}
                      type="button"
                      disabled={working || added}
                      onClick={() => assignConnecteam(m.userId, m.name)}
                      title={view.text}
                      className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-[13px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] disabled:opacity-60"
                    >
                      <span className="min-w-0 truncate">
                        <span>{m.name}</span>
                        {!added && <span className="ml-1.5 text-[11px] normal-case text-meta">{view.text}</span>}
                      </span>
                      <span className="flex shrink-0 items-center gap-2 text-[10.5px] uppercase tracking-[0.06em] text-meta">
                        {m.role}
                        {!added && <span className={`rounded border px-1 py-px normal-case ${ELIG_BADGE[view.tone]}`}>{view.state.replace("_", " ").toLowerCase()}</span>}
                        {added && <span className="text-positive">added ✓</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {assignedShiftId && (
              <div className="mt-4 border-t border-border pt-3">
                <button onClick={publish} disabled={working} className={BTN + " border-foreground text-foreground"}>
                  {working ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} Publish to Connecteam
                </button>
                <p className="mt-1.5 text-[11px] text-meta">
                  Confirms the shift and notifies the assigned crew. {card.windowKnown ? "" : "Set a start/end time on the shift first."}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Step 3b — Instawork */}
        {source === "instawork" && (
          <div>
            {!iwConfigured ? (
              <p className="text-[12.5px] text-meta">Instawork isn’t connected — add the session cookie in Settings to reconcile and request temp labor.</p>
            ) : matchedGigs.length > 0 ? (
              <div className="rounded border border-border bg-[var(--row-hover)]/40 p-3">
                <p className="text-[12.5px] text-foreground">
                  Already posted on Instawork for this {ROLE_LABEL[role]} window —{" "}
                  <span className="text-positive">{gigBooked} booked</span>
                  {gigPending > 0 && <span className="text-attention"> · {gigPending} pending</span>}
                  {" "}across {matchedGigs.length} gig{matchedGigs.length === 1 ? "" : "s"}.
                </p>
                {instawork && (
                  <p className="mt-1 text-[11px] text-meta">
                    Day total for {ROLE_LABEL[role]}: {instawork[role].booked} booked, {instawork[role].pending} pending.
                  </p>
                )}
                <p className="mt-1 text-[11px] text-meta">A gig isn’t truck-specific — it may also cover other routes in the same window.</p>
              </div>
            ) : requested ? (
              <div className="rounded border border-positive/30 bg-positive/[0.06] p-3">
                <p className="text-[12.5px] text-foreground">
                  <Check className="mr-1 inline size-3.5 text-positive" />
                  Gig requested — {gigHeadcount}× {IW_POSITION[role]}
                  {payRate.trim() ? ` @ $${payRate}/hr` : ""}.
                </p>
                <p className="mt-1 text-[11px] text-meta">Recorded on the shift. Posting to Instawork is wired after the Instawork write capture.</p>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-[12.5px] text-meta">
                  No matching Instawork gig for this {ROLE_LABEL[role]} window yet. Propose one — it’s recorded on the shift (not posted).
                </p>
                <div className="grid gap-3.5 sm:grid-cols-2">
                  <label className="space-y-1">
                    <span className={LABEL}>Position</span>
                    <input className={INPUT} value={IW_POSITION[role]} readOnly />
                  </label>
                  <label className="space-y-1">
                    <span className={LABEL}>Headcount</span>
                    <input className={INPUT} type="number" min={1} value={gigHeadcount} onChange={(e) => setGigHeadcount(Math.max(1, Number(e.target.value) || 1))} />
                  </label>
                  <label className="space-y-1">
                    <span className={LABEL}>Pay rate ($/hr)</span>
                    <input className={INPUT} inputMode="decimal" value={payRate} onChange={(e) => setPayRate(e.target.value)} placeholder="e.g. 22" />
                  </label>
                  <label className="space-y-1">
                    <span className={LABEL}>Window</span>
                    <input className={INPUT} value={card.windowKnown && card.startTime ? "route window" : "Set time on shift"} readOnly />
                  </label>
                </div>
                <button onClick={requestGig} disabled={working} className={BTN + " border-foreground text-foreground"}>
                  {working ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} Create Instawork gig
                </button>
                <p className="text-[11px] text-meta">
                  Records the request on the route’s {ROLE_LABEL[role]} shift. <span className="text-attention">Posting is wired after the Instawork write capture</span> — nothing is sent to Instawork yet.
                </p>
              </div>
            )}
          </div>
        )}

        {error && <p className="mt-3 text-[12.5px] text-critical">{error}</p>}
      </div>
    </div>
  );
}
