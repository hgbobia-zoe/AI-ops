"use client";

// First-class dispatcher OVERRIDE (opened from a route card). The optimizer's plan is a recommendation;
// the dispatcher can override it explicitly here with a MANDATORY reason, which the backend records on every
// live internal row + an audit event (manual always wins; nothing re-runs to fight the change). Actions:
//   - Remove (leave open): drop a worker from a route seat (the seat stays open for Instawork / a later fill)
//   - Replace: swap one worker for another free, role-matched worker
//   - Move: relocate a worker to another route, with deterministic eligibility labels (good fit /
//     exceeds availability / qualification mismatch) from the SAME predicates the optimizer uses
//   - Assign specific: place a specific worker onto a route role
// Every action hits PATCH /api/scheduling/shift/[id] with overrideReason; the server recomputes coverage,
// readiness and cost on the next render. Comms style: no em-dashes, no emoji.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { X, Trash2, Repeat, ArrowRight, UserPlus2, Truck as TruckIcon } from "lucide-react";
import type { CrewMember } from "@/lib/connecteam";
import type { CrewRecommendation } from "@/lib/scheduling/availability";
import { moveEligibility, type MoveFit } from "@/lib/scheduling/planView";
import { type ShiftRole, type StaffShift } from "@/lib/scheduling/types";
import { NotifyConfirm } from "@/components/scheduling/NotifyConfirm";
import type { NotifyNotice } from "@/lib/scheduling/assignNotify";
import { ROLE_LABEL, type RouteCardData } from "@/components/scheduling/RouteStaffBoard";

const BTN =
  "inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[12px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50 disabled:pointer-events-none";
const PRIMARY =
  "inline-flex items-center gap-1.5 rounded border border-foreground px-3 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-foreground/[0.08] disabled:opacity-50 disabled:pointer-events-none";
const LABEL = "text-[11px] uppercase tracking-[0.08em] text-meta";
const ROLES: ShiftRole[] = ["driver", "field", "prep"];

const FIT_TONE: Record<MoveFit, string> = {
  "good-fit": "text-positive",
  "exceeds-availability": "text-attention",
  "qualification-mismatch": "text-meta",
};

interface CrewEntry {
  uid: number;
  name: string;
  role: ShiftRole;
  shift: StaffShift;
}

export function OverridePanel({
  date,
  card,
  shifts,
  roster,
  recsByRole,
  routeOptions,
  onClose,
}: {
  date: string;
  card: RouteCardData;
  shifts: StaffShift[]; // this route's shifts
  roster: CrewMember[];
  recsByRole: Partial<Record<ShiftRole, CrewRecommendation[]>>;
  routeOptions: RouteCardData[]; // other routes (move targets)
  onClose: () => void;
}): React.JSX.Element {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<{ kind: "replace" | "move"; entry: CrewEntry } | null>(null);
  const [assignRole, setAssignRole] = useState<ShiftRole>("field");
  // Pending notices to confirm + send after an override (removed worker → "removed"; any added → "assigned").
  const [notices, setNotices] = useState<NotifyNotice[] | null>(null);

  const reasonOk = reason.trim().length > 0;
  const nameOf = (uid: number): string => roster.find((m) => m.userId === uid)?.name ?? `#${uid}`;
  const roleOf = (uid: number): CrewMember["role"] => roster.find((m) => m.userId === uid)?.role ?? "other";

  const crew = useMemo<CrewEntry[]>(() => {
    const seen = new Set<number>();
    const out: CrewEntry[] = [];
    for (const s of shifts) {
      for (const uid of s.assignees) {
        if (seen.has(uid)) continue;
        seen.add(uid);
        out.push({ uid, name: nameOf(uid), role: s.role, shift: s });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shifts, roster]);

  async function patchShift(shiftId: string, body: Record<string, unknown>): Promise<boolean> {
    const res = await fetch(`/api/scheduling/shift/${shiftId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, overrideReason: reason.trim() }),
    });
    return res.ok;
  }

  async function ensureShift(route: RouteCardData, role: ShiftRole, existing: StaffShift[]): Promise<StaffShift | null> {
    const found = existing.find((s) => s.routeId === route.routeId && s.role === role);
    if (found) return found;
    const res = await fetch("/api/scheduling/shift", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date, role, headcount: 1,
        startTime: route.startTime, endTime: route.endTime, windowKnown: route.windowKnown,
        location: null, routeId: route.routeId, truckId: route.truckId, eventLabel: route.eventLabel, source: "manual",
      }),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { shift?: StaffShift }).shift ?? null;
  }

  async function run(fn: () => Promise<boolean>, successMsg: string, noticesFor?: () => NotifyNotice[]): Promise<void> {
    if (!reasonOk) { setError("Enter a reason first (required for an override)."); return; }
    setWorking(true);
    setError(null);
    try {
      const ok = await fn();
      if (!ok) { setError("Couldn't apply the override. Try again."); return; }
      toast.success(successMsg);
      setPanel(null);
      // The override already committed; texting the affected worker(s) is the dispatcher's explicit confirm.
      if (noticesFor) {
        const n = noticesFor();
        if (n.length) setNotices(n);
      }
      router.refresh();
    } catch {
      setError("Couldn't apply the override. Try again.");
    } finally {
      setWorking(false);
    }
  }

  function remove(e: CrewEntry): void {
    void run(
      () => patchShift(e.shift.id, { assignees: e.shift.assignees.filter((u) => u !== e.uid) }),
      `${e.name} removed; seat left open.`,
      () => [{ shiftId: e.shift.id, userId: e.uid, kind: "removed" }],
    );
  }

  function replace(e: CrewEntry, newUid: number): void {
    const next = e.shift.assignees.map((u) => (u === e.uid ? newUid : u));
    const deduped = [...new Set(next)];
    void run(
      () => patchShift(e.shift.id, { assignees: deduped, headcount: Math.max(e.shift.headcount, deduped.length) }),
      `${e.name} replaced with ${nameOf(newUid)}.`,
      () => [
        { shiftId: e.shift.id, userId: e.uid, kind: "removed" },
        { shiftId: e.shift.id, userId: newUid, kind: "assigned" },
      ],
    );
  }

  function move(e: CrewEntry, toRoute: RouteCardData): void {
    let targetShiftId: string | null = null;
    void run(
      async () => {
        const removed = await patchShift(e.shift.id, { assignees: e.shift.assignees.filter((u) => u !== e.uid) });
        if (!removed) return false;
        const target = await ensureShift(toRoute, e.role, shifts);
        if (!target) return false;
        targetShiftId = target.id;
        const nextAssignees = target.assignees.includes(e.uid) ? target.assignees : [...target.assignees, e.uid];
        return patchShift(target.id, { assignees: nextAssignees, headcount: Math.max(target.headcount, nextAssignees.length) });
      },
      `${e.name} moved to ${toRoute.truckName}.`,
      () => {
        const n: NotifyNotice[] = [{ shiftId: e.shift.id, userId: e.uid, kind: "removed" }];
        if (targetShiftId) n.push({ shiftId: targetShiftId, userId: e.uid, kind: "assigned" });
        return n;
      },
    );
  }

  function assignSpecific(uid: number): void {
    let targetShiftId: string | null = null;
    void run(
      async () => {
        const target = await ensureShift(card, assignRole, shifts);
        if (!target) return false;
        targetShiftId = target.id;
        const nextAssignees = target.assignees.includes(uid) ? target.assignees : [...target.assignees, uid];
        return patchShift(target.id, { assignees: nextAssignees, headcount: Math.max(target.headcount, nextAssignees.length) });
      },
      `${nameOf(uid)} assigned to ${card.truckName}.`,
      () => (targetShiftId ? [{ shiftId: targetShiftId, userId: uid, kind: "assigned" }] : []),
    );
  }

  // Candidates for replace/assign: free crew for the role (recommendCrew), then the role roster, minus
  // anyone already on this route.
  const onRoute = new Set(crew.map((c) => c.uid));
  function candidatesFor(role: ShiftRole): CrewMember[] {
    const rec = (recsByRole[role] ?? []).map((r) => roster.find((m) => m.userId === r.userId)).filter((m): m is CrewMember => Boolean(m));
    const rosterForRole = roster.filter((m) => (role === "driver" ? m.role === "driver" : m.role === "prep" || m.role === "other"));
    const merged = [...rec, ...rosterForRole];
    const seen = new Set<number>();
    return merged.filter((m) => !onRoute.has(m.userId) && !seen.has(m.userId) && (seen.add(m.userId), true));
  }

  return (
    <>
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-medium text-foreground">Override · {card.truckName}</h2>
          <p className="truncate text-[12px] text-meta">{card.eventLabel || `${card.stopCount} stops`}</p>
        </div>
        <button onClick={onClose} aria-label="Close" className="flex size-8 items-center justify-center rounded border border-border text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {/* Mandatory reason */}
        <label className="mb-4 block space-y-1">
          <span className={LABEL}>Reason (required)</span>
          <textarea
            className="w-full rounded border border-border bg-background px-2.5 py-1.5 text-[13px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            rows={2}
            value={reason}
            onChange={(ev) => setReason(ev.target.value)}
            placeholder="Why are you overriding the plan? Recorded on the audit trail."
          />
          {!reasonOk && <span className="text-[11px] text-meta">An override needs a reason before any action is allowed.</span>}
        </label>

        {/* Current crew */}
        <div className="mb-4">
          <span className={LABEL}>Current crew</span>
          {crew.length === 0 ? (
            <p className="mt-1 text-[12.5px] text-meta">No internal crew assigned to this route yet.</p>
          ) : (
            <div className="mt-1.5 space-y-2">
              {crew.map((e) => (
                <div key={e.uid} className="rounded border border-border p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-[13px]">
                      <span className="font-medium text-foreground">{e.name}</span>
                      <span className="ml-1.5 text-[11px] uppercase tracking-[0.05em] text-meta">{ROLE_LABEL[e.role]}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <button disabled={working || !reasonOk} onClick={() => remove(e)} className={BTN} title="Remove and leave the seat open">
                        <Trash2 className="size-3" /> Remove
                      </button>
                      <button disabled={working || !reasonOk} onClick={() => setPanel(panel?.entry.uid === e.uid && panel.kind === "replace" ? null : { kind: "replace", entry: e })} className={BTN}>
                        <Repeat className="size-3" /> Replace
                      </button>
                      <button disabled={working || !reasonOk} onClick={() => setPanel(panel?.entry.uid === e.uid && panel.kind === "move" ? null : { kind: "move", entry: e })} className={BTN}>
                        <ArrowRight className="size-3" /> Move
                      </button>
                    </span>
                  </div>

                  {/* Replace candidate list */}
                  {panel?.kind === "replace" && panel.entry.uid === e.uid && (
                    <div className="mt-2 rounded border border-border bg-[var(--row-hover)]/40 p-2">
                      <p className="mb-1.5 text-[11px] uppercase tracking-[0.06em] text-meta">Replace {e.name} with</p>
                      {candidatesFor(e.role).length === 0 ? (
                        <p className="text-[12px] text-meta">No free role-matched crew. Use Instawork from the route card.</p>
                      ) : (
                        <div className="max-h-48 space-y-0.5 overflow-y-auto">
                          {candidatesFor(e.role).map((m) => (
                            <button key={m.userId} disabled={working} onClick={() => replace(e, m.userId)} className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-[12.5px] transition-colors hover:bg-[var(--row-hover)] disabled:opacity-60">
                              <span className="truncate text-foreground">{m.name}</span>
                              <span className="text-[10.5px] uppercase tracking-[0.05em] text-meta">{m.role}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Move route list with eligibility labels */}
                  {panel?.kind === "move" && panel.entry.uid === e.uid && (
                    <div className="mt-2 rounded border border-border bg-[var(--row-hover)]/40 p-2">
                      <p className="mb-1.5 text-[11px] uppercase tracking-[0.06em] text-meta">Move {e.name} to (by route windows)</p>
                      {routeOptions.length === 0 ? (
                        <p className="text-[12px] text-meta">No other routes to move to.</p>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {routeOptions.map((r) => {
                            const srcWin = card.windowKnown && card.startTime && card.endTime ? [[Date.parse(card.startTime), Date.parse(card.endTime)]] as Array<[number, number]> : [];
                            const tgtWin = r.windowKnown && r.startTime && r.endTime ? { startMs: Date.parse(r.startTime), endMs: Date.parse(r.endTime) } : null;
                            const elig = moveEligibility({ workerRole: roleOf(e.uid), targetRole: e.role, routeWindow: tgtWin, workerBusyWindows: srcWin });
                            const ok = elig.fit === "good-fit";
                            return (
                              <button
                                key={r.routeId}
                                disabled={working || !ok}
                                title={elig.label}
                                onClick={() => move(e, r)}
                                className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[12px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                <TruckIcon className="size-3" /> {r.truckName}
                                <span className={FIT_TONE[elig.fit]}>{elig.label}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Assign a specific worker */}
        <div className="mb-2 border-t border-border pt-3">
          <span className={LABEL}>Assign a specific worker</span>
          <div className="mt-1.5 mb-2 flex flex-wrap gap-1.5">
            {ROLES.map((r) => (
              <button key={r} onClick={() => setAssignRole(r)} className={`rounded border px-2.5 py-1 text-[12px] transition-colors ${assignRole === r ? "border-foreground bg-foreground/[0.08] text-foreground" : "border-border text-tertiary-text hover:bg-[var(--row-hover)]"}`}>
                {ROLE_LABEL[r]}
              </button>
            ))}
          </div>
          {candidatesFor(assignRole).length === 0 ? (
            <p className="text-[12px] text-meta">No free role-matched crew for {ROLE_LABEL[assignRole]}.</p>
          ) : (
            <div className="max-h-44 space-y-0.5 overflow-y-auto rounded border border-border p-1.5">
              {candidatesFor(assignRole).map((m) => (
                <button key={m.userId} disabled={working || !reasonOk} onClick={() => assignSpecific(m.userId)} className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-[13px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] disabled:opacity-60">
                  <span className="inline-flex items-center gap-1.5 truncate"><UserPlus2 className="size-3.5" /> {m.name}</span>
                  <span className="text-[10.5px] uppercase tracking-[0.05em] text-meta">{m.role}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {error && <p className="mt-3 text-[12.5px] text-critical">{error}</p>}
      </div>

      <div className="border-t border-border px-5 py-3">
        <button onClick={onClose} className={PRIMARY}>Done</button>
        <p className="mt-1.5 text-[11px] text-meta">Manual overrides always win. Each action is recorded with your reason on the audit trail.</p>
      </div>
    </div>
    {notices && <NotifyConfirm notices={notices} title="Notify affected crew" onClose={() => setNotices(null)} />}
    </>
  );
}
