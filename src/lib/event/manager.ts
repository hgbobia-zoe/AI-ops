// AI Event Manager — the INTERPRETATION layer over the deterministic Event Lifecycle Engine (P1-P4).
//
// Governing law: RULES CALCULATE, AI INTERPRETS. This module READS the engine's outputs and INTERPRETS
// them into an honest, cited Event Briefing. It NEVER:
//   • asserts operational state the engine didn't compute (it reports exactly deriveLifecycle's state and
//     computeEventReadiness's condition — it can't say "ready" unless the lifecycle is READY, can't say
//     "driver assigned" unless the requirement/fact confirms it),
//   • moves lifecycle state or writes anything (it does not call the machine's transition()),
//   • fabricates a metric, a record, or an outcome (every recommendation is phrased "I recommend X",
//     never "X is done").
// Everything it states is grounded in — and CITES — the underlying records (requirement ids, risk
// findings, the EventView slices). The deterministic FLOOR is complete on its own: a briefing with NO AI
// provider available is still correct.
//
// Precedents mirrored (compose, don't duplicate):
//   • src/lib/salesos/state.ts + outreachService.ts — "FACT base, AI may only REFINE, FACT always wins",
//     with a deterministic template floor that works with no LLM. Here: buildBriefing() is the FACT floor;
//     the optional AI pass only rephrases the `summary` string, never a fact/state/number/recommendation.
//   • src/lib/salesos/bidReview.ts — a pure, total deterministic core taking resolved facts.
//   • src/lib/ai/provider.ts runAi — the ONE interpretation seam (session-bridge default, no hardcoded
//     key). An unavailable provider returns `skipped`; we fall back to the deterministic text, exactly
//     like quoteReview's Tier-1 fallback.
//   • src/lib/llm.ts COMMS_STYLE (prepended by the provider for prose) + salesos/outreach.ts humanize()
//     — the house voice (no dashes, no emoji), applied to any generated prose.
//
// Composition (the engine, assembled by the resolver): getEventReadiness(id) → EventView + lifecycle +
// readiness + requirements (+ weather); canAdvance()/unmetDependencies() for the primary blocker;
// generateTimeline()/withDeadlines() for milestone deadlines on the recommendations.

import { humanize } from "@/lib/salesos/outreach";
import { runAi } from "@/lib/ai/provider";
import { todayInOpsTz } from "@/lib/dates";
import { eventWeather } from "@/lib/weather";
import type { WeatherResult } from "@/lib/weather/types";

import { getEventReadiness, type EventReadinessBundle, type GetEventReadinessDeps } from "./resolvers";
import { listEventRefs } from "./adapter";
import { canAdvance } from "./dependencies";
import { generateTimeline, withDeadlines, type TimelineMilestone } from "./timeline";
import type { EventCondition, EventView, Requirement } from "./types";
import type { LifecycleState } from "./machine";

// ── The Event Briefing shape ──────────────────────────────────────────────────────────────────────────

/** A single recommended action. It is ALWAYS a recommendation ("I recommend X"), never an assertion that
 *  X happened. Derived from an unmet, data-backed requirement/dependency; it cites the record it came
 *  from so a human can verify. The Event Manager PROPOSES; it never executes. */
export interface RecommendedAction {
  /** Stable key (usually the backing requirement id). */
  id: string;
  /** Imperative recommendation, e.g. "Assign a driver". */
  label: string;
  /** Why it is recommended, cited from the requirement's own resolution text. */
  reason: string;
  /** The responsible department / lead (from the requirement owner). */
  owner: string;
  /** The real record that backs this recommendation (requirement id + source). */
  source: string;
  /** blocking = it gates the event's forward progress; advisory = worth doing, not a hard gate. */
  priority: "blocking" | "advisory";
  /** The timeline deadline for the backing requirement, when the timeline supplies one; else null. */
  deadline: string | null;
}

/** A traceable citation: a human label and the record/function it refers to. */
export interface Citation {
  label: string;
  ref: string;
}

/** The honest, composed Event Briefing. Every field is grounded in the engine; nothing is fabricated. */
export interface EventBriefing {
  eventId: string;
  headline: string;
  /** The lifecycle state EXACTLY as deriveLifecycle computed it (never asserted beyond that). */
  lifecycle: LifecycleState;
  /** The independent readiness axis EXACTLY as computeEventReadiness computed it. */
  condition: EventCondition;
  /** Plain-language summary. Deterministic floor by default; optionally AI-REFINED prose (facts unchanged). */
  summary: string;
  /** Whether `summary` is the deterministic floor or an AI rephrase of it. Honest provenance. */
  summarySource: "deterministic" | "ai";
  /** Each entry cites a requirement or a risk finding. Empty when nothing is at risk (condition NORMAL). */
  whyAtRisk: string[];
  /** The single highest-priority unmet BLOCKING dependency/requirement standing in the way, or null. */
  primaryBlocker: { label: string; source: string } | null;
  /** Recommendations derived from unmet items — each a recommendation, never represented as done. */
  recommendedActions: RecommendedAction[];
  /** Every record the briefing stands on (requirement ids, risk level, lifecycle + readiness functions). */
  citations: Citation[];
}

export interface EventBriefingDeps extends GetEventReadinessDeps {
  /** Turn the optional AI-refine pass off (tests / when a pure floor is wanted). Default: attempt it. */
  refine?: boolean;
}

// ── Display label maps (presentation only — never change a computed value) ──────────────────────────────
const LIFECYCLE_PHRASE: Record<LifecycleState, string> = {
  OPPORTUNITY: "an open opportunity (no quote sent yet)",
  QUOTED: "quoted and awaiting a signature",
  BOOKED: "booked (contract signed), not yet in planning",
  PLANNING: "booked and being planned",
  READY: "ready to dispatch",
  DISPATCHED: "dispatched (a truck is on the way)",
  SETUP: "in setup on-site",
  LIVE: "live (delivered, event underway)",
  PICKUP: "in pickup / teardown",
  CLOSEOUT: "in closeout",
  CLOSED: "closed",
  CANCELLED: "cancelled",
  LOST: "a lost quote",
};

const CONDITION_PHRASE: Record<EventCondition, string> = {
  NORMAL: "on track",
  WATCH: "worth watching",
  AT_RISK: "at risk",
  BLOCKED: "blocked",
  ESCALATED: "escalated (critical and imminent)",
};

/** Imperative recommendation labels per backing requirement id. Falls back to the requirement label. */
const ACTION_LABEL: Record<string, string> = {
  contract_signed: "Get the contract signed",
  payment_deposit: "Request the deposit",
  route_exists: "Plan a route",
  delivery_window: "Set the delivery and pickup windows",
  driver_assigned: "Assign a driver",
  crew_sufficient: "Staff the crew",
  tent_crew: "Staff the tent crew",
  inventory_concurrency: "Review inventory concurrency",
  weather_reviewed: "Review the weather plan",
};

// ── The DETERMINISTIC core (pure) — the FACT floor. No DB, no net, no AI. ────────────────────────────────

/**
 * Build the Event Briefing from the already-resolved engine bundle. PURE and TOTAL. This is the honest
 * floor: correct with no LLM. `summarySource` is always "deterministic" here; the AI pass (eventBriefing)
 * only ever swaps the `summary` string and flips the source, leaving every other field untouched.
 */
export function buildBriefing(bundle: EventReadinessBundle, opts: { today?: string | Date } = {}): EventBriefing {
  const { view, requirements, readiness } = bundle;
  const lifecycle = bundle.lifecycleState;
  const condition = readiness.condition;

  // Timeline deadlines fed back onto the requirements (P4), so recommendations can carry a real deadline.
  const timeline = generateTimeline(view, { requirements, today: opts.today });
  const dated = withDeadlines(requirements, timeline);
  const deadlineById = new Map(dated.map((r) => [r.id, r.deadline] as const));

  // Unmet, data-backed requirements (BLOCKED or WARNING — UNVERIFIED is an unknown, never an action/risk).
  const unmet = requirements.filter((r) => r.status === "BLOCKED" || r.status === "WARNING");

  // ── recommendedActions — each a RECOMMENDATION, cited, never "done" ──
  const recommendedActions: RecommendedAction[] = unmet.map((r) => ({
    id: r.id,
    label: ACTION_LABEL[r.id] ?? r.label,
    reason: r.resolution,
    owner: r.owner,
    source: `${r.id} (${r.source})`,
    priority: r.blocking ? "blocking" : "advisory",
    deadline: deadlineById.get(r.id) ?? null,
  }));

  // ── primaryBlocker — the highest-priority unmet BLOCKING gate on the NEXT forward step ──
  const primaryBlocker = resolvePrimaryBlocker(view, requirements, unmet);

  // ── whyAtRisk — each entry cites a requirement or a risk finding; empty when NORMAL ──
  const whyAtRisk = buildWhyAtRisk(requirements, readiness.reasons, condition);

  // ── citations — every record the briefing stands on ──
  const citations = buildCitations(bundle);

  // ── summary — deterministic plain-language floor (house voice) ──
  const summary = humanize(buildSummary(view, lifecycle, condition, primaryBlocker, recommendedActions, requirements));

  return {
    eventId: String(view.ref.id),
    headline: buildHeadline(view, lifecycle, condition),
    lifecycle,
    condition,
    summary,
    summarySource: "deterministic",
    whyAtRisk,
    primaryBlocker,
    recommendedActions,
    citations,
  };
}

function resolvePrimaryBlocker(
  view: EventView,
  requirements: Requirement[],
  unmet: Requirement[],
): { label: string; source: string } | null {
  // Prefer the engine's own gate on the next forward step (dependencies.canAdvance reuses deriveLifecycle).
  const { blockedBy } = canAdvance(view, { requirements });
  if (blockedBy.length > 0) {
    const b = blockedBy[0];
    return { label: b.label, source: b.id };
  }
  // Fall back to the first blocking requirement that is a real deficiency (BLOCKED first, then WARNING).
  const blockingBlocked = unmet.find((r) => r.blocking && r.status === "BLOCKED");
  const blockingWarning = unmet.find((r) => r.blocking && r.status === "WARNING");
  const pick = blockingBlocked ?? blockingWarning ?? null;
  return pick ? { label: pick.label, source: pick.id } : null;
}

function buildWhyAtRisk(requirements: Requirement[], readinessReasons: string[], condition: EventCondition): string[] {
  if (condition === "NORMAL") return [];
  const out: string[] = [];
  // Data-backed blocking deficiencies, each citing its requirement id.
  for (const r of requirements) {
    if (!r.blocking) continue;
    if (r.status === "BLOCKED") out.push(`${r.label} is blocked: ${r.resolution} (requirement: ${r.id})`);
    else if (r.status === "WARNING") out.push(`${r.label} needs attention: ${r.resolution} (requirement: ${r.id})`);
  }
  // Risk-engine findings (the readiness axis already cited them with a RISK: prefix).
  for (const reason of readinessReasons) {
    if (/^RISK:/.test(reason)) out.push(reason.replace(/^RISK:\s*/, "") + " (source: risk engine)");
  }
  // Non-blocking warnings that pushed the condition to WATCH, each cited.
  if (out.length === 0) {
    for (const r of requirements) {
      if (!r.blocking && r.status === "WARNING") out.push(`${r.label}: ${r.resolution} (requirement: ${r.id})`);
    }
  }
  return out;
}

function buildCitations(bundle: EventReadinessBundle): Citation[] {
  const { requirements, readiness, lifecycleState } = bundle;
  const out: Citation[] = [
    { label: `Lifecycle: ${lifecycleState}`, ref: "event/lifecycle.ts:deriveLifecycle" },
    {
      label: `Condition: ${readiness.condition}${readiness.score != null ? ` (readiness ${readiness.score})` : ""}`,
      ref: "event/readiness.ts:computeEventReadiness",
    },
    { label: `Risk level: ${readiness.riskLevel ?? "READY"}`, ref: "risk/engine.ts + risk/store.ts:getRiskQueue" },
  ];
  for (const r of requirements) out.push({ label: `${r.label} (${r.status})`, ref: r.source });
  return out;
}

function buildHeadline(view: EventView, lifecycle: LifecycleState, condition: EventCondition): string {
  const name = view.ref.displayName || view.ref.customer || `Event ${view.ref.id}`;
  const on = view.ref.date ? ` on ${view.ref.date}` : "";
  return humanize(`${name}${on}: ${titleCase(lifecycle)}, ${CONDITION_PHRASE[condition]}`);
}

function buildSummary(
  view: EventView,
  lifecycle: LifecycleState,
  condition: EventCondition,
  primaryBlocker: { label: string; source: string } | null,
  actions: RecommendedAction[],
  requirements: Requirement[],
): string {
  const name = view.ref.displayName || view.ref.customer || `This event`;
  const parts: string[] = [];
  parts.push(`${name} is ${LIFECYCLE_PHRASE[lifecycle]}, and readiness is ${CONDITION_PHRASE[condition]}.`);

  if (primaryBlocker) {
    parts.push(`The main thing in the way is ${lower(primaryBlocker.label)}.`);
  } else if (condition === "NORMAL") {
    parts.push("No blocking issues are open.");
  }

  const blocking = actions.filter((a) => a.priority === "blocking");
  const advisory = actions.filter((a) => a.priority === "advisory");
  if (blocking.length > 0) {
    parts.push(`I recommend ${joinList(blocking.map((a) => lower(a.label)))} before this can move forward.`);
  }
  if (advisory.length > 0) {
    parts.push(`Worth doing too: ${joinList(advisory.map((a) => lower(a.label)))}.`);
  }
  if (blocking.length === 0 && advisory.length === 0) {
    parts.push("Nothing is recommended right now.");
  }

  // An honest note where a core fact is unverified (not a deficiency, just unknown).
  const unverified = requirements.filter((r) => r.status === "UNVERIFIED").map((r) => lower(r.label));
  if (unverified.length > 0) parts.push(`Still unverified from data: ${joinList(unverified)}.`);

  return parts.join(" ");
}

// ── Async composition — resolve the engine, build the floor, OPTIONALLY refine the prose ─────────────────

/**
 * Produce the honest Event Briefing for an event id. Returns null when the id doesn't resolve to a real
 * event. The deterministic floor is built first (correct on its own); then, when a provider is available,
 * an OPTIONAL pass rephrases ONLY the `summary` string into natural prose. FACT WINS: the AI is handed the
 * already-computed facts and asked only to rephrase the summary — every other field (lifecycle, condition,
 * whyAtRisk, primaryBlocker, recommendedActions, citations) is untouched, and any failure/empty/oversized
 * result falls back to the deterministic summary.
 */
export async function eventBriefing(
  input: number | string,
  deps: EventBriefingDeps = {},
): Promise<EventBriefing | null> {
  const bundle = await getEventReadiness(input, deps);
  if (!bundle) return null;

  const today = deps.now ?? undefined;
  const floor = buildBriefing(bundle, { today });

  if (deps.refine === false) return floor;
  return refineSummary(floor);
}

/** The AI-refine seam. Rephrases ONLY `floor.summary`; returns the floor unchanged when the provider is
 *  unavailable or the result is unusable. Never changes a fact, state, number, or recommendation. */
async function refineSummary(floor: EventBriefing): Promise<EventBriefing> {
  // The provider is asked ONLY to rephrase the already-true summary; the facts are context it must not
  // recompute. session-bridge (default) returns skipped → we keep the deterministic floor.
  const res = await runAi({
    system:
      "You are an operations coordinator for an event rental company. Rephrase the given event summary " +
      "into one short, natural paragraph for a busy operator. Do NOT add, remove, or change any fact, " +
      "status, number, blocker, or recommendation. Do not invent anything. If nothing reads better, " +
      "return the summary unchanged. Plain text only.",
    prompt: `Rephrase this event summary without changing any fact:\n\n${floor.summary}`,
    context: {
      lifecycle: floor.lifecycle,
      condition: floor.condition,
      primaryBlocker: floor.primaryBlocker,
      recommendedActions: floor.recommendedActions.map((a) => a.label),
    },
    maxTokens: 300,
    temperature: 0.2,
    timeoutMs: 20000,
  }).catch(() => null);

  if (!res || !res.ok || res.skipped || !res.text) return floor;
  const refined = humanize(res.text.trim());
  // Guardrails: a usable rephrase is non-empty and not wildly longer than the floor (anti-hallucination).
  if (refined.length === 0 || refined.length > floor.summary.length * 3 + 200) return floor;
  return { ...floor, summary: refined, summarySource: "ai" };
}

// ── Bounded Q&A — answers ONLY from the engine facts, cites them, says "unknown" otherwise ───────────────

export interface EventAnswer {
  answer: string;
  /** True when the answer is grounded in a resolved fact; false when the data can't support it. */
  grounded: boolean;
  citations: Citation[];
}

/**
 * Answer a bounded question about one event STRICTLY from the engine facts, citing them. Deterministic
 * (no LLM): it recognizes a small set of operational intents and answers each from the resolved records.
 * When the question maps to nothing the data can support, it says so ("unknown") rather than guessing —
 * it never asserts state the engine didn't compute. Returns null when the id doesn't resolve.
 */
export async function answerEventQuestion(
  input: number | string,
  question: string,
  deps: GetEventReadinessDeps = {},
): Promise<EventAnswer | null> {
  const bundle = await getEventReadiness(input, deps);
  if (!bundle) return null;
  return answerFromFacts(bundle, question);
}

/** The pure grounding core for answerEventQuestion (unit-testable without a DB). */
export function answerFromFacts(bundle: EventReadinessBundle, question: string): EventAnswer {
  const q = (question || "").toLowerCase();
  const { view, requirements, readiness, lifecycleState } = bundle;
  const reqById = (id: string): Requirement | undefined => requirements.find((r) => r.id === id);
  const cite = (r: Requirement | undefined, fallback: Citation): Citation =>
    r ? { label: `${r.label} (${r.status})`, ref: r.source } : fallback;

  const has = (...k: string[]): boolean => k.some((w) => q.includes(w));

  // ready / can we dispatch / go
  if (has("ready", "dispatch", "go ahead", "good to go")) {
    const isReady = lifecycleState === "READY";
    const { blockedBy } = canAdvance(view, { requirements });
    const answer = isReady
      ? "Yes. The lifecycle is READY, which means every blocking requirement is satisfied."
      : blockedBy.length > 0
        ? `Not yet. The lifecycle is ${lifecycleState}. Still needed: ${blockedBy.map((b) => lower(b.label)).join(", ")}.`
        : `The lifecycle is ${lifecycleState}; it is not READY.`;
    return { answer, grounded: true, citations: [{ label: `Lifecycle: ${lifecycleState}`, ref: "event/lifecycle.ts:deriveLifecycle" }] };
  }

  // driver
  if (has("driver")) {
    const r = reqById("driver_assigned");
    if (!r) return unknown("No route exists yet for this event, so there is no driver to confirm.");
    const assigned = r.status === "OK";
    return { answer: assigned ? "Yes, a driver is assigned to the route." : `Not confirmed. ${r.resolution}`, grounded: true, citations: [cite(r, { label: "driver_assigned", ref: r.source })] };
  }

  // crew / staffing
  if (has("crew", "staff", "staffing")) {
    const r = reqById("crew_sufficient");
    if (!r) return unknown("There is no route to staff yet, so crew sufficiency cannot be answered.");
    return { answer: `${r.label}: ${r.status}. ${r.resolution}`, grounded: r.status !== "UNVERIFIED", citations: [cite(r, { label: "crew_sufficient", ref: r.source })] };
  }

  // weather
  if (has("weather", "rain", "forecast", "wind")) {
    const r = reqById("weather_reviewed");
    const w: WeatherResult | null = bundle.weather;
    if (!r) return unknown("This event has no date, so no weather can be reviewed.");
    const detail = w && w.status === "OK" ? "A real forecast was retrieved." : w ? `No forecast (${w.status}).` : "No forecast available.";
    return { answer: `${r.label}: ${r.status}. ${detail} ${r.resolution}`, grounded: r.status !== "UNVERIFIED", citations: [cite(r, { label: "weather_reviewed", ref: r.source })] };
  }

  // payment / deposit / balance
  if (has("paid", "payment", "deposit", "balance", "owe", "due")) {
    const r = reqById("payment_deposit");
    const c = view.commercial;
    if (!c.present) return unknown("There is no commercial record for this event, so payment cannot be answered.");
    const money = (n: number | null): string => (n == null ? "unknown" : `$${Math.round(n)}`);
    const detail = `Paid ${money(c.amountPaid)}, due ${money(c.amountDue)}, total ${money(c.grandTotal)}.`;
    return { answer: r ? `${r.label}: ${r.status}. ${detail} ${r.resolution}` : detail, grounded: true, citations: [cite(r, { label: "payment", ref: "db/repo.ts (bookings)" })] };
  }

  // blocker / why at risk / risk
  if (has("block", "risk", "why", "stuck", "wrong")) {
    const blocker = resolvePrimaryBlocker(view, requirements, requirements.filter((x) => x.status === "BLOCKED" || x.status === "WARNING"));
    const why = buildWhyAtRisk(requirements, readiness.reasons, readiness.condition);
    if (!blocker && why.length === 0) return { answer: `Nothing is blocking this event. Condition is ${readiness.condition}.`, grounded: true, citations: [{ label: `Condition: ${readiness.condition}`, ref: "event/readiness.ts:computeEventReadiness" }] };
    const answer = `${blocker ? `Main blocker: ${lower(blocker.label)}. ` : ""}${why.join(" ")}`.trim();
    return { answer, grounded: true, citations: [{ label: `Condition: ${readiness.condition}`, ref: "event/readiness.ts:computeEventReadiness" }] };
  }

  // date / when
  if (has("date", "when", "day")) {
    if (!view.ref.date) return unknown("This event has no date on record.");
    return { answer: `The event date is ${view.ref.date} (source: ${view.ref.dateSource ?? "unknown"}).`, grounded: true, citations: [{ label: "Event date", ref: "event/adapter.ts (bookings.event_date / earliest stop)" }] };
  }

  // state / status / lifecycle / condition
  if (has("state", "status", "lifecycle", "stage", "condition")) {
    return {
      answer: `Lifecycle ${lifecycleState}; readiness condition ${readiness.condition}${readiness.score != null ? ` (score ${readiness.score})` : ""}.`,
      grounded: true,
      citations: [
        { label: `Lifecycle: ${lifecycleState}`, ref: "event/lifecycle.ts:deriveLifecycle" },
        { label: `Condition: ${readiness.condition}`, ref: "event/readiness.ts:computeEventReadiness" },
      ],
    };
  }

  return unknown("I can only answer from this event's records, and I do not have enough to answer that.");
}

function unknown(msg: string): EventAnswer {
  return { answer: `Unknown. ${msg}`, grounded: false, citations: [] };
}

// ── Portfolio signal — a bounded, honest live metric for the AI Org card (service.ts) ───────────────────

export interface EventPortfolioSignal {
  /** Events resolved in the window (the denominator the card shows). */
  active: number;
  blocked: number;
  atRisk: number;
  escalated: number;
  watch: number;
  normal: number;
}

export interface EventPortfolioOpts {
  window?: { start: string; end: string };
  /** Hard cap on how many events are scored (bounded + guarded, like the other service signals). */
  cap?: number;
  now?: Date;
}

/** A weather resolver that makes NO network call — used by the portfolio signal so scoring many events
 *  never fans out to Open-Meteo. Weather is a NON-blocking requirement, so skipping it leaves the
 *  BLOCKED / AT_RISK / ESCALATED counts exactly correct (at most a weather WATCH is suppressed). */
const noNetworkWeather: typeof eventWeather = async () => ({ status: "UNAVAILABLE" });

/**
 * Score the active-event portfolio by readiness condition, honestly and boundedly. Reuses listEventRefs
 * (real bookings only) + the event resolver; caps the number scored and guards each, so one bad read
 * degrades a single event, never the signal. Weather is resolved with the no-network stub (see above).
 */
export async function eventPortfolioSignal(opts: EventPortfolioOpts = {}): Promise<EventPortfolioSignal> {
  const now = opts.now ?? new Date();
  const today = todayInOpsTz();
  const window = opts.window ?? { start: today, end: addDaysISO(today, 45) };
  const cap = opts.cap ?? 40;

  const out: EventPortfolioSignal = { active: 0, blocked: 0, atRisk: 0, escalated: 0, watch: 0, normal: 0 };
  let refs;
  try {
    refs = listEventRefs({ window });
  } catch {
    return out;
  }

  for (const ref of refs.slice(0, cap)) {
    try {
      const bundle = await getEventReadiness(ref.id, { now, weather: noNetworkWeather });
      if (!bundle) continue;
      out.active++;
      switch (bundle.readiness.condition) {
        case "ESCALATED":
          out.escalated++;
          break;
        case "BLOCKED":
          out.blocked++;
          break;
        case "AT_RISK":
          out.atRisk++;
          break;
        case "WATCH":
          out.watch++;
          break;
        default:
          out.normal++;
      }
    } catch {
      // Guarded: a single unreadable event never breaks the signal.
    }
  }
  return out;
}

// ── small pure helpers ──────────────────────────────────────────────────────────────────────────────────
function titleCase(s: string): string {
  return s.charAt(0) + s.slice(1).toLowerCase();
}
function lower(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
function joinList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}
function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Exposed for the timeline-aware tests / callers that already hold a resolved bundle. */
export type { EventReadinessBundle, TimelineMilestone };
