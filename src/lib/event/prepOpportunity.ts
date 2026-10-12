// Operational Opportunity detection — the PREP WINDOW rule. PURE (no DB/network/AI), mirrors the shape
// of src/lib/risk/engine.ts `assessDay`: given a snapshot of resolved facts + config + the real clock, it
// returns RiskFinding[]. The caller (risk/scan.ts) resolves every fact from existing readers and never
// fetches inside this function, so the whole rule is deterministic and exhaustively unit-testable.
//
// GOVERNING LAW: RULES CALCULATE, AI INTERPRETS — and here, HONESTY ABOUT WHAT IS UNKNOWN.
//
// The incident this closes: today's drivers finished and left while next-day trucks sat un-loaded, even
// though trucks, crew and a feasible window still existed, and nothing surfaced it. The crux is that there
// is NO truck-loading/picking/staging telemetry and NO server-side "truck returned" signal (only the
// manual ARRIVED_WAREHOUSE tap). So this rule can NEVER assert "the trucks are unloaded" — it flags an
// UNVERIFIED prep WINDOW: an opportunity to pull tomorrow's loading forward while resources and time remain.
// Every finding carries `unverified: true` and a plain statement of what is unknown.
//
// Feasibility is arithmetic, not assumption:
//   estimatedLoadDuration = base + perStop·stops + perItem·items           (minutes)
//   cutoff                = min(relevant crew shift-ends today, warehouse close)
//   latestSafeStart       = cutoff − estimatedLoadDuration
//   remaining             = latestSafeStart − now
// SHIFT-LIMIT / OT POLICY (safe default): the cutoff is the SCHEDULED shift-end (and any unavailability
// is already removed from the crew the caller passes). We NEVER recommend work that would run past it — if
// it would need OT, the finding downgrades to `prep_window_threatened`/`prep_window_missed` (informational),
// never an actionable "load it now".

import type { RiskFinding, RiskSeverity } from "@/lib/risk/types";

const MIN = 60; // seconds

// ── Config (admin-tunable; see src/lib/settings.ts prepOpportunity) ──────────────────────────────────
export interface PrepOppConfig {
  /** Base minutes to prep & load ANY delivery truck, before size scaling. */
  loadBaseMinutes: number;
  /** Added minutes per stop on the route (size proxy). */
  loadMinutesPerStop: number;
  /** Added minutes per line-item across the route (finer size proxy). */
  loadMinutesPerItem: number;
  /** When the remaining window is at or below this many minutes, the window is THREATENED (closing),
   *  not a comfortable "do it now" — it becomes informational, not an actionable recommendation. */
  threatenedMinutes: number;
  /** Local hour (0–23) the warehouse hard-closes, as a backstop cutoff; null = rely on crew shift-ends
   *  only (no artificial cap). Resolved to a real instant by the caller. */
  warehouseCloseHour: number | null;
  /** OT policy. "in_shift_only" (safe default) = never recommend loading past scheduled shift-end. */
  otPolicy: "in_shift_only";
}

export const DEFAULT_PREP_OPP_CONFIG: PrepOppConfig = {
  loadBaseMinutes: 45,
  loadMinutesPerStop: 10,
  loadMinutesPerItem: 1,
  threatenedMinutes: 45,
  warehouseCloseHour: null,
  otPolicy: "in_shift_only",
};

// ── Resolved facts (gathered by the caller from existing readers) ────────────────────────────────────

/** Today's state of one truck. `freeToday` and `returnVerified` are resolved honestly by the caller:
 *  there is NO reliable server-side return signal, so when a truck DID run today, `returnVerified` is
 *  false and `freeToday` is INFERRED from route status + stop times — reflected in the confidence. */
export interface PrepTruckState {
  truckId: string;
  /** True when ALL of today's routes for this truck are done AND there is no later open route today
   *  (multi-route-per-truck honored). A truck with no route today is also free (never dispatched). */
  freeToday: boolean;
  /** Why it is / isn't free (surfaced in the description + used for confidence). */
  freeReason: string;
  /** True only when the truck's return is VERIFIED (never dispatched today, or an ARRIVED_WAREHOUSE tap).
   *  False = "free" was inferred from route status, which is softer. */
  returnVerified: boolean;
}

/** One of tomorrow's routes that may need its truck loaded today. */
export interface PrepTomorrowRoute {
  routeId: string;
  truckId: string;
  eventId?: string;
  eventLabel?: string;
  /** Tomorrow (YYYY-MM-DD) — the date the finding is filed under. */
  date: string;
  /** Earliest planned stop window (ISO) ≈ dispatch time; null when untimed. */
  dispatchWindow: string | null;
  /** Size proxies from the EventView/logistics. */
  stopCount: number;
  itemCount: number;
  /** Delivery routes need the truck pre-loaded; a pickup-only route goes out empty, so it needs no load. */
  needsLoad: boolean;
  /** A real, data-backed dependency that makes loading impossible right now (e.g. route not built,
   *  inventory not allocatable). When present, we surface the blocker — NOT a load rec that can't happen. */
  blocker?: { label: string; detail: string } | null;
}

/** Today's crew availability. Resolved from Connecteam (prep + driver shifts), with unavailability blocks
 *  already removed by the caller. `verified` is false when Connecteam was unreachable (availability UNKNOWN). */
export interface PrepCrew {
  verified: boolean;
  /** Distinct prep/driver crew still on-shift NOW (shift not yet ended, not in an unavailability block). */
  availableCount: number;
  /** Their shift-end instants (Unix seconds), only those after `now`. The MIN of these is the human cutoff. */
  shiftEndUnix: number[];
}

export interface PrepFacts {
  tomorrowDate: string;
  /** Warehouse hard-close instant (Unix seconds) from config, or null when not configured. */
  warehouseCloseUnix: number | null;
  /** Display timezone for formatting the deadline clock in human text (deterministic given tz). */
  displayTz: string;
  trucks: Map<string, PrepTruckState>;
  routes: PrepTomorrowRoute[];
  crew: PrepCrew;
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────
function estimateLoadMinutes(r: PrepTomorrowRoute, cfg: PrepOppConfig): number {
  return Math.round(cfg.loadBaseMinutes + cfg.loadMinutesPerStop * Math.max(0, r.stopCount) + cfg.loadMinutesPerItem * Math.max(0, r.itemCount));
}

function clockIn(tz: string, unix: number): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(unix * 1000));
  } catch {
    return new Date(unix * 1000).toISOString();
  }
}
function windowLabel(iso: string | null, tz: string): string {
  if (!iso) return "no set time";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return clockIn(tz, Math.floor(t / 1000));
}

/** The honest "what is unknown" note — ALWAYS states the loading-telemetry gap, plus any softer inputs. */
function buildWhatsUnknown(truck: PrepTruckState, crew: PrepCrew): string {
  const parts = ["No loading telemetry exists, so this flags the UNVERIFIED prep window — it does not assert the truck is unloaded."];
  if (!truck.returnVerified) parts.push("Truck return is not confirmed (no warehouse-arrival tap); availability is inferred from route status and stop times.");
  if (!crew.verified) parts.push("Crew availability could not be verified (Connecteam unreachable).");
  return parts.join(" ");
}

function consequenceFor(label: string): string {
  return `If it is not loaded today, tomorrow's dispatch for ${label} carries added risk.`;
}

function eventLabelOf(r: PrepTomorrowRoute): string {
  return r.eventLabel || r.eventId || `${r.truckId} route`;
}

interface Emit {
  r: PrepTomorrowRoute;
  riskType: "prep_window_open" | "prep_window_threatened" | "prep_window_missed";
  severity: RiskSeverity;
  confidence: "low" | "moderate";
  whatsUnknown: string;
  loadMinutes: number;
  /** latest safe start instant (Unix s), or null when not computable / not applicable. */
  latestSafeStartUnix: number | null;
  remainingMin: number | null;
  recommendedAction: string;
  reason: string; // a short "why this bucket" note for the description
  extraMeta?: Record<string, unknown>;
}

function toFinding(e: Emit, tz: string): RiskFinding {
  const { r } = e;
  const label = eventLabelOf(r);
  const deadline = e.latestSafeStartUnix != null ? new Date(e.latestSafeStartUnix * 1000).toISOString() : undefined;
  const deadlineClock = e.latestSafeStartUnix != null ? clockIn(tz, e.latestSafeStartUnix) : null;
  const dispatch = windowLabel(r.dispatchWindow, tz);
  const titlePrefix =
    e.riskType === "prep_window_open" ? "Prep window open" : e.riskType === "prep_window_threatened" ? "Prep window closing" : "Prep window missed";
  const description =
    `${label} dispatches tomorrow (${dispatch}) on ${r.truckId}` +
    (r.needsLoad ? ` and needs ~${e.loadMinutes} min to prep & load.` : ".") +
    ` ${e.reason}` +
    (deadlineClock ? ` Latest safe start today: ${deadlineClock}.` : "") +
    ` ${consequenceFor(label)}` +
    ` (Confidence: ${e.confidence}. ${e.whatsUnknown})`;
  return {
    signature: `prep_window|${r.date}|${r.truckId}`,
    riskType: e.riskType,
    category: "OPPORTUNITY",
    severity: e.severity,
    title: `${titlePrefix} — ${label}`,
    description,
    date: r.date,
    eventId: r.eventId,
    routeId: r.routeId,
    truckId: r.truckId,
    affectedEntity: label,
    recommendedAction: e.recommendedAction,
    actionTarget: "dispatch",
    owner: "Warehouse / Ops",
    deadline,
    unverified: true, // ALWAYS — there is no loading telemetry to verify against.
    metadata: {
      confidence: e.confidence,
      whatsUnknown: e.whatsUnknown,
      consequence: consequenceFor(label),
      loadMinutes: e.loadMinutes,
      dispatchWindow: r.dispatchWindow,
      latestSafeStartUnix: e.latestSafeStartUnix,
      remainingMin: e.remainingMin != null ? Math.round(e.remainingMin) : null,
      stopCount: r.stopCount,
      itemCount: r.itemCount,
      ...(e.extraMeta ?? {}),
    },
  };
}

/**
 * Assess tomorrow's prep windows. PURE + TOTAL. Returns one finding per tomorrow truck that is worth
 * surfacing; emits nothing for a truck that is NOT free today (its route started / not done / has a later
 * route) or for a route that needs no load. See the 12 cases in prepOpportunity.test.ts.
 */
export function assessPrepOpportunities(facts: PrepFacts, config: Partial<PrepOppConfig>, now: Date): RiskFinding[] {
  const cfg = { ...DEFAULT_PREP_OPP_CONFIG, ...config };
  const nowUnix = Math.floor(now.getTime() / 1000);
  const { crew } = facts;

  // Human cutoff = the earliest of (crew shift-ends still ahead, warehouse close). In-shift-only: we only
  // ever consider shift-ends that are AFTER now, so a window that would need OT yields no cutoff ahead.
  const cutoffs = [...crew.shiftEndUnix.filter((t) => t > nowUnix)];
  if (facts.warehouseCloseUnix != null && facts.warehouseCloseUnix > nowUnix) cutoffs.push(facts.warehouseCloseUnix);
  const cutoff = cutoffs.length > 0 ? Math.min(...cutoffs) : null;

  // Only delivery routes need loading. Rank by dispatch time (earliest tomorrow dispatch first), then by
  // size (bigger loads first) so limited capacity goes to the most time-critical trucks (case 6).
  const loadRoutes = facts.routes
    .filter((r) => r.needsLoad && (facts.trucks.get(r.truckId)?.freeToday ?? false))
    .sort((a, b) => {
      const ta = a.dispatchWindow ? Date.parse(a.dispatchWindow) : Infinity;
      const tb = b.dispatchWindow ? Date.parse(b.dispatchWindow) : Infinity;
      if (ta !== tb) return ta - tb;
      return estimateLoadMinutes(b, cfg) - estimateLoadMinutes(a, cfg);
    });

  // Capacity: distinct available crew bound how many trucks can be loaded within the window (one crew can
  // meaningfully prep one truck at a time). Never assume unlimited capacity (case 6).
  const capacity = Math.max(0, crew.availableCount);

  const out: RiskFinding[] = [];
  let openSlots = capacity;

  for (const r of loadRoutes) {
    const truck = facts.trucks.get(r.truckId)!;
    const loadMinutes = estimateLoadMinutes(r, cfg);
    const whatsUnknown = buildWhatsUnknown(truck, crew);
    const confidence: "low" | "moderate" = truck.returnVerified && crew.verified ? "moderate" : "low";

    // (4) A real blocking dependency → surface it, never a load rec that can't happen.
    if (r.blocker) {
      out.push(
        toFinding(
          {
            r,
            riskType: "prep_window_threatened",
            severity: "MEDIUM",
            confidence,
            whatsUnknown,
            loadMinutes,
            latestSafeStartUnix: null,
            remainingMin: null,
            recommendedAction: `Resolve ${r.blocker.label} before loading ${r.truckId}.`,
            reason: `Cannot prep yet: ${r.blocker.label} — ${r.blocker.detail}.`,
            extraMeta: { blocker: r.blocker },
          },
          facts.displayTz,
        ),
      );
      continue;
    }

    // (12) Crew availability UNKNOWN (Connecteam unreachable) → communicate uncertainty, never invent
    // readiness or recommend "load now" on data we don't have.
    if (!crew.verified) {
      out.push(
        toFinding(
          {
            r,
            riskType: "prep_window_threatened",
            severity: "LOW",
            confidence: "low",
            whatsUnknown,
            loadMinutes,
            latestSafeStartUnix: null,
            remainingMin: null,
            recommendedAction: `Confirm crew is available, then load ${r.truckId} for tomorrow if time remains.`,
            reason: "Crew availability is unknown, so feasibility could not be computed.",
          },
          facts.displayTz,
        ),
      );
      continue;
    }

    // (2) No crew on-shift ahead / no cutoff within scheduled hours → no feasible in-shift window.
    if (capacity === 0 || cutoff == null) {
      out.push(
        toFinding(
          {
            r,
            riskType: "prep_window_missed",
            severity: "LOW",
            confidence,
            whatsUnknown,
            loadMinutes,
            latestSafeStartUnix: null,
            remainingMin: null,
            recommendedAction: `No in-shift crew window remains today. Plan an early start tomorrow or authorize OT (needs approval).`,
            reason: "No crew remains on-shift today to load within scheduled hours.",
          },
          facts.displayTz,
        ),
      );
      continue;
    }

    const latestSafeStartUnix = cutoff - loadMinutes * MIN;
    const remainingMin = (latestSafeStartUnix - nowUnix) / MIN;

    // (2) The in-shift window has already closed (loading would run past scheduled shift-end → OT).
    if (remainingMin < 0) {
      out.push(
        toFinding(
          {
            r,
            riskType: "prep_window_missed",
            severity: "LOW",
            confidence,
            whatsUnknown,
            loadMinutes,
            latestSafeStartUnix,
            remainingMin,
            recommendedAction: `No in-shift window remained today (loading would run past shift-end). Plan an early start tomorrow or authorize OT (needs approval).`,
            reason: `Loading now would finish after the crew's scheduled shift-end — no in-shift window remains.`,
          },
          facts.displayTz,
        ),
      );
      continue;
    }

    // (6) Capacity-limited: more free trucks than crew can load in the window → the overflow is flagged
    // THREATENED (informational), not an actionable "load it now", so we never assume unlimited capacity.
    if (openSlots <= 0) {
      out.push(
        toFinding(
          {
            r,
            riskType: "prep_window_threatened",
            severity: "MEDIUM",
            confidence,
            whatsUnknown,
            loadMinutes,
            latestSafeStartUnix,
            remainingMin,
            recommendedAction: `Crew is at capacity for other trucks first; sequence ${r.truckId} next or add crew.`,
            reason: `A feasible window exists, but today's crew is already committed to higher-priority trucks (capacity-limited).`,
            extraMeta: { capacityLimited: true },
          },
          facts.displayTz,
        ),
      );
      continue;
    }

    // Window closing (remaining small) → THREATENED, escalate as the cutoff nears.
    if (remainingMin <= cfg.threatenedMinutes) {
      out.push(
        toFinding(
          {
            r,
            riskType: "prep_window_threatened",
            severity: remainingMin <= cfg.threatenedMinutes / 2 ? "HIGH" : "MEDIUM",
            confidence,
            whatsUnknown,
            loadMinutes,
            latestSafeStartUnix,
            remainingMin,
            recommendedAction: `Window closing — load ${r.truckId} now (or confirm it can wait).`,
            reason: `Only ~${Math.round(remainingMin)} min of in-shift slack remains before the cutoff.`,
          },
          facts.displayTz,
        ),
      );
      openSlots -= 1; // a threatened-but-feasible truck still occupies crew capacity
      continue;
    }

    // (1) Actionable: truck free, crew available, comfortable in-shift window remains.
    out.push(
      toFinding(
        {
          r,
          riskType: "prep_window_open",
          // Advisory by default; nudges up as the window tightens.
          severity: remainingMin >= cfg.threatenedMinutes * 2 ? "LOW" : "MEDIUM",
          confidence,
          whatsUnknown,
          loadMinutes,
          latestSafeStartUnix,
          remainingMin,
          recommendedAction: `Load ${r.truckId} for ${eventLabelOf(r)} today (latest safe start ${clockIn(facts.displayTz, latestSafeStartUnix)}).`,
          reason: `A feasible in-shift window remains (~${Math.round(remainingMin)} min of slack).`,
        },
        facts.displayTz,
      ),
    );
    openSlots -= 1;
  }

  return out;
}
