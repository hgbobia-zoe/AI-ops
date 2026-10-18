// Shared assembly of the PacketContext + per-worker dispatch inputs (phone + delivery-route link) for a
// shift's live assignments. Extracted from the manual packet route so BOTH the human "Send packet"
// endpoint (app/api/scheduling/shift/[id]/packet) and the unattended auto-trigger job
// (scheduling/workerPackets) build the EXACT same context from the EXACT same readers — no duplication,
// no drift. Pure data gathering (truck/route/supervisor/coworkers/Instawork clock codes/phone/link); the
// gated send itself stays in packetSend.dispatchPacketTouch.

import { getActiveVehicles } from "@/lib/vehicles";
import { getRoutesForDate, createShiftPass, listShiftPasses } from "@/lib/db/repo";
import { newPassToken } from "@/lib/auth/pass";
import { readInstaworkSnapshot } from "@/lib/instawork/store";
import { findGigForWorker } from "@/lib/instawork/reconcile";
import { findInstaworkPhone } from "@/lib/instawork/contacts";
import { getSettings, DEFAULT_PREMIUM_WINDOW_KEYWORDS, DEFAULT_EVENT_READINESS_KEYWORDS } from "@/lib/settings";
import type { CrewMember } from "@/lib/connecteam";
import type { PacketContext, PacketCoworker } from "./packet";
import type { ShiftAssignment, StaffShift } from "./types";

/** The app's public origin for links built OUTSIDE a request (the runtime job has no Request). Mirrors
 *  http/origin.ts's env branch: PUBLIC_BASE_URL only (no host headers available), else "" → links drop. */
export function packetOriginFromEnv(): string {
  return process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
}

/** The per-gig Instawork clock codes for one assignee that day (null when the worker can't be tied to a
 *  gig or Instawork sent no codes). Internal workers never carry codes. Match is by name/id + date. */
export function instaworkCodes(a: ShiftAssignment, date: string): { clockInCode: string | null; clockOutCode: string | null } {
  if (a.workerKind !== "instawork") return { clockInCode: null, clockOutCode: null };
  const snap = readInstaworkSnapshot();
  if (!snap) return { clockInCode: null, clockOutCode: null };
  const gig = findGigForWorker(snap.shifts, date, { workerName: a.instaworkWorker ?? a.displayName, workerId: null });
  return { clockInCode: gig?.clockInCode ?? null, clockOutCode: gig?.clockOutCode ?? null };
}

/** The worker's delivery-route link for the refresher: a scoped, self-expiring Shift Pass. We REUSE the
 *  existing pass minting (auth/pass + repo). Driver scope with a pre-assigned truck opens straight to the
 *  route checklist; with no truck we fall back to a board (dispatch) view. To avoid a fresh token on every
 *  preview/tick, we reuse a still-live pass already minted for this worker + truck + scope. Returns null
 *  only when we cannot build an absolute origin. */
export function mintRoutePass(
  worker: { name: string },
  shift: Pick<StaffShift, "endTime">,
  truck: { id: string; name: string } | null,
  origin: string,
  actor: string,
): string | null {
  if (!origin) return null;
  const scope = truck ? "driver" : "board";
  const truckId = truck?.id ?? null;
  const name = worker.name.trim() || "Worker";

  // Reuse an existing live pass for the same worker + truck + scope (keeps repeated previews idempotent).
  const now = Date.now();
  const existing = listShiftPasses().find(
    (p) => !p.revokedAt && Date.parse(p.expiresAt) > now && p.name === name && p.scope === scope && (p.truckId ?? null) === truckId,
  );
  if (existing) return `${origin}/pass/${existing.id}`;

  // Expiry: the shift's end (+3h cushion) when known, else 18h out. Pass self-destructs at that time.
  const endMs = shift.endTime ? Date.parse(shift.endTime) : NaN;
  const expiresMs = Number.isFinite(endMs) ? endMs + 3 * 3_600_000 : now + 18 * 3_600_000;
  const pass = createShiftPass({
    id: newPassToken(),
    name,
    scope,
    truckId,
    truckName: truck?.name ?? null,
    createdBy: actor,
    expiresAt: new Date(expiresMs).toISOString(),
  });
  return `${origin}/pass/${pass.id}`;
}

// A stop is "premium / time-sensitive" when the CONTRACT bought a tight arrival window. Goodshuffle shows
// this as a line item on the quote — the real Zoe products are "Premium Time (2 Hours - Delivery Arrival
// Window)", "Exact Time (30 mins - Delivery Arrival Window)" and their Pickup / Elite Hour variants. Every
// one carries the phrase "Arrival Window", which NO ordinary rental item does, so that is the primary match.
// "Event Readiness Service" is the booked setup service (same item that drives the min-2-crew rule); a stop
// with it gets named in the debrief so the crew plans setup time. BOTH are matched from line-item NAMES
// (not plannedWindow — real pulls set that to the single scheduled arrival time, not a window width),
// substring + case-insensitive, against the team's editable keyword lists in /admin (settings). The defaults
// live in settings.ts (DEFAULT_PREMIUM_WINDOW_KEYWORDS / DEFAULT_EVENT_READINESS_KEYWORDS).

/** PURE: does any of a stop's line items match one of `keywords` (lowercased substrings)? */
function itemNameMatches(items: { name?: string }[] | undefined, keywords: string[]): boolean {
  if (!items?.length) return false;
  const kw = keywords.map((k) => k.toLowerCase()).filter(Boolean);
  return items.some((it) => {
    const n = (it.name || "").toLowerCase();
    return kw.some((k) => n.includes(k));
  });
}

/** PURE: does a stop carry a premium / exact-time arrival window (delivery or pickup)? */
export function isPremiumWindowStop(items: { name?: string }[] | undefined, keywords: string[] = DEFAULT_PREMIUM_WINDOW_KEYWORDS): boolean {
  return itemNameMatches(items, keywords);
}

/** PURE: does a stop carry the Event Readiness Service? */
export function isEventReadinessStop(items: { name?: string }[] | undefined, keywords: string[] = DEFAULT_EVENT_READINESS_KEYWORDS): boolean {
  return itemNameMatches(items, keywords);
}

/** The parts of a PacketContext shared by every assignee on a shift (truck, route summary, supervisor). */
export interface SharedPacketContext {
  truck: { id: string; name: string } | null;
  route: PacketContext["route"];
  supervisor: PacketContext["supervisor"];
}

/** Resolve the shared (per-shift) context once: the assigned truck, the route-stops summary, and the
 *  supervisor. Pure readers (vehicles + routes + the passed Connecteam roster) — no sends. */
export function buildSharedPacketContext(shift: StaffShift, users: Map<number, CrewMember>): SharedPacketContext {
  const truckName = shift.truckId ? getActiveVehicles().find((v) => v.truckId === shift.truckId)?.name ?? shift.truckId : null;
  const truck = shift.truckId ? { id: shift.truckId, name: truckName as string } : null;
  let route: PacketContext["route"] = null;
  if (shift.routeId && shift.truckId) {
    const r = getRoutesForDate(shift.truckId, shift.date).find((x) => x.routeId === shift.routeId);
    // premiumStops = stops whose quote carries a premium / exact-time arrival window. >0 flips on the "mind the
    // stop timings" reminder. eventReadinessCustomers = the customers on this route with Event Readiness
    // Service, named in the debrief so the crew plans setup time. Both match line items against the team's
    // editable keyword lists (/admin settings).
    const settings = getSettings();
    const premiumKw = settings.premiumWindowKeywords ?? DEFAULT_PREMIUM_WINDOW_KEYWORDS;
    const readinessKw = settings.eventReadinessKeywords ?? DEFAULT_EVENT_READINESS_KEYWORDS;
    if (r)
      route = {
        stops: r.stops.length,
        firstStop: r.stops[0]?.custName ?? null,
        premiumStops: r.stops.filter((s) => isPremiumWindowStop(s.items, premiumKw)).length,
        eventReadinessCustomers: [...new Set(r.stops.filter((s) => isEventReadinessStop(s.items, readinessKw)).map((s) => s.custName).filter((n): n is string => !!n))],
      };
  }
  const supUser = shift.supervisorUserId != null ? users.get(shift.supervisorUserId) : undefined;
  const supervisor = supUser ? { name: supUser.name, phone: supUser.phone ?? null } : null;
  return { truck, route, supervisor };
}

/** Per-assignment dispatch inputs: the full PacketContext (coworkers computed from the OTHER live
 *  assignees), the worker's phone (internal → Connecteam; Instawork → the CAPTURED booked-pro phone, if the
 *  Auto-Pull extension has scraped it from the timesheet view — else null → honest skip downstream), and the
 *  refresher's delivery-route link. Identical for the manual send and the auto-trigger. */
export function assignmentPacketInputs(
  shift: StaffShift,
  a: ShiftAssignment,
  live: ShiftAssignment[],
  shared: SharedPacketContext,
  users: Map<number, CrewMember>,
  origin: string,
  actor: string,
): { ctx: PacketContext; workerPhone: string | null; link: string | null } {
  // Each coworker is the OTHER live assignees, carrying THEIR OWN duty (so a helper sees the driver as a driver).
  const coworkers: PacketCoworker[] = live
    .filter((x) => x.id !== a.id)
    .map((x) => ({ name: x.displayName ?? x.instaworkWorker ?? "Worker", role: x.role }));
  const { clockInCode, clockOutCode } = instaworkCodes(a, shift.date);
  const ctx: PacketContext = { truck: shared.truck, supervisor: shared.supervisor, coworkers, route: shared.route, mapUrl: null, equipment: shift.equipment, clockInCode, clockOutCode };
  // Internal → the Connecteam roster phone. Instawork → the captured booked-pro phone (extension-scraped),
  // matched by name/id against the contacts store; null when not captured yet (downstream skips honestly).
  const workerPhone =
    a.workerKind === "internal"
      ? a.connecteamUserId != null
        ? users.get(a.connecteamUserId)?.phone ?? null
        : null
      : findInstaworkPhone({ workerName: a.instaworkWorker ?? a.displayName, workerId: null });
  const link = mintRoutePass({ name: a.displayName ?? a.instaworkWorker ?? "Worker" }, shift, shared.truck, origin, actor);
  return { ctx, workerPhone, link };
}
