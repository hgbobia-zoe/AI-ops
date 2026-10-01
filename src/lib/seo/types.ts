// SEO Growth Engine — shared types. FACTS ONLY: an Ubersuggest metric is a third-party ESTIMATE and
// is always kept apart from internal workflow state and business outcomes. Absent = UNKNOWN, never 0.

/** Search intent for a keyword (as Ubersuggest classifies it, or "unknown" when not provided). */
export type SeoIntent = "informational" | "commercial" | "transactional" | "navigational" | "unknown";

/** The recommended editorial action for an opportunity (derived in Phase 2 — null until analyzed). */
export type SeoAction = "CREATE" | "IMPROVE" | "CONSOLIDATE" | "SKIP";

/** How the opportunity was discovered. */
export type SeoSource = "ubersuggest" | "manual" | "derived";

/** Where the attached metrics came from (provenance of the `metrics` blob). */
export type SeoMetricsSource = "ubersuggest" | "none";

/**
 * Operational workflow state. Phase 1 only ever creates `new`; the rest exist so the Overview counts and
 * the (later) approval workflow have a stable vocabulary.
 */
export type SeoStatus =
  | "new" // awaiting analysis
  | "awaiting_approval" // analyzed, needs a human go/no-go
  | "approved" // approved to work
  | "in_progress" // content being produced
  | "drafted" // a draft exists, awaiting review
  | "published" // live
  | "deferred" // parked
  | "rejected"; // declined (SKIP acted on)

export const SEO_STATUSES: SeoStatus[] = [
  "new",
  "awaiting_approval",
  "approved",
  "in_progress",
  "drafted",
  "published",
  "deferred",
  "rejected",
];

/**
 * The available Ubersuggest metrics for a keyword. EVERY field is optional: a field is present only when
 * Ubersuggest actually returned it. Never default a missing field to 0 — absent means UNKNOWN. These are
 * third-party estimates, not internal facts or business outcomes.
 */
export interface SeoMetrics {
  /** Monthly search volume estimate. */
  volume?: number;
  /** SEO difficulty (0–100). */
  difficulty?: number;
  /** Paid difficulty (0–100). */
  paidDifficulty?: number;
  /** Cost per click, USD. */
  cpc?: number;
  /** Country/locale the metrics were pulled for. */
  locale?: string;
}

export interface SeoOpportunity {
  id: string;
  dedupeKey: string;
  keyword: string;
  relatedKeywords: string[];
  intent: SeoIntent;
  location: string | null;
  category: string | null;
  competitorRefs: string[];
  /** Third-party ESTIMATE blob (Ubersuggest). null when never fetched. */
  metrics: SeoMetrics | null;
  metricsSource: SeoMetricsSource;
  source: SeoSource;
  /** ISO retrieval timestamp of `metrics`; null = never fetched. */
  researchAt: string | null;
  matchedUrl: string | null;
  recommendedAction: SeoAction | null;
  priority: number | null;
  /** The explainable priority breakdown (sub-scores + evidence). null until analyzed. */
  priorityBreakdown: SeoPriorityBreakdown | null;
  explanation: string | null;
  owner: string | null;
  /** Phase-1 workflow status (preserved for the Overview + back-compat). */
  status: SeoStatus;
  /** Phase-2 Kanban lifecycle stage — the canonical workflow state the board drives. */
  stage: SeoStage;
  isSeed: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One lifecycle transition (append-only decision history). */
export interface SeoStatusEvent {
  id: string;
  opportunityId: string;
  fromStatus: SeoStatus | null;
  toStatus: SeoStatus;
  actor: string | null;
  note: string | null;
  ts: string;
}

// ── Integration health ──────────────────────────────────────────────────────────────────────────

/** The boundary's configuration/health state. "not_configured" is a first-class, honest state. */
export type SeoHealthStatus = "not_configured" | "ok" | "error" | "stale" | "never";

export interface SeoDiagnostic {
  id: string;
  ts: string;
  operation: string;
  tool: string | null;
  ok: boolean;
  statusCode: number | null;
  rateLimited: boolean;
  durationMs: number | null;
  detail: string | null;
}

/** What the Overview's integration-health card renders. Never fabricated. */
export interface SeoHealth {
  status: SeoHealthStatus;
  /** True when an MCP credential is present (secret or env). */
  configured: boolean;
  /** 1–3 word state, e.g. "Connected", "Not configured". */
  headline: string;
  /** One line explaining the state / how to fix it. */
  detail: string;
  /** ISO of the last SUCCESSFUL retrieval, or null. */
  lastSuccessAt: string | null;
  /** ISO of the most recent attempt (success or failure), or null. */
  lastAttemptAt: string | null;
  /** Most recent error detail, when the last attempt failed. */
  lastError: string | null;
  /** True when the newest data we have is older than the staleness threshold. */
  stale: boolean;
}

/** Hours after which the last successful retrieval is considered stale. */
export const SEO_STALE_HOURS = 24 * 7;

// ── Phase 2: Kanban lifecycle (stage) ─────────────────────────────────────────────────────────────
//
// The Phase-1 `status` vocabulary (above) is preserved untouched for backward compatibility and the
// Overview counts. Phase 2 introduces a richer, EXPLICIT Kanban lifecycle — `stage` — as the canonical
// workflow state the board drives. It lives in its own column so nothing in Phase 1 changes. The main
// flow is DISCOVERED → ANALYZING → APPROVED → DRAFTING → REVIEW → APPROVED_FOR_PUBLISHING → PUBLISHED →
// MONITORING; REJECTED / DEFERRED / CONSOLIDATED / BLOCKED are off-flow states reachable from the active
// stages. Every transition is recorded (seo_status_history) and guarded by a transition map (stages.ts).
export type SeoStage =
  | "DISCOVERED" // freshly discovered, not yet reviewed
  | "ANALYZING" // matched + scored, awaiting the human go/no-go (approval gate #1)
  | "APPROVED" // approved to produce content
  | "DRAFTING" // content being written
  | "REVIEW" // a draft exists, awaiting editorial review
  | "APPROVED_FOR_PUBLISHING" // review passed, cleared to publish (gate #3)
  | "PUBLISHED" // live
  | "MONITORING" // live and being tracked
  | "REJECTED" // declined (SKIP acted on)
  | "DEFERRED" // parked for later
  | "CONSOLIDATED" // folded into another page/opportunity (CONSOLIDATE acted on)
  | "BLOCKED"; // stuck on a dependency

export const SEO_STAGES: SeoStage[] = [
  "DISCOVERED",
  "ANALYZING",
  "APPROVED",
  "DRAFTING",
  "REVIEW",
  "APPROVED_FOR_PUBLISHING",
  "PUBLISHED",
  "MONITORING",
  "REJECTED",
  "DEFERRED",
  "CONSOLIDATED",
  "BLOCKED",
];

/** One sub-score of the explainable priority — its weighted contribution plus the evidence it rests on. */
export interface SeoScoreComponent {
  key: string;
  label: string;
  /** 0–100 for this dimension. */
  score: number;
  /** Relative weight in the overall blend. */
  weight: number;
  /** Plain-English evidence. Honest about unknowns — never invents rankings/traffic/revenue. */
  evidence: string;
  /** True when the dimension had no hard data and a neutral placeholder was used. */
  unknown: boolean;
}

/** The explainable priority score: an overall 0–100 plus the sub-scores and a one-line summary. */
export interface SeoPriorityBreakdown {
  score: number; // 0–100 overall
  components: SeoScoreComponent[];
  summary: string;
}

/** The matcher's decision for an opportunity against the Zoe page inventory. Pure output. */
export interface SeoMatchResult {
  action: SeoAction; // CREATE | IMPROVE | CONSOLIDATE | SKIP
  matchedUrl: string | null;
  matchedPath: string | null;
  /** 0–1 confidence in the match/decision. */
  confidence: number;
  /** Plain-English reason for the decision. */
  reason: string;
  /** The pages considered, best first, with why each scored as it did. */
  candidates: { path: string; url: string; score: number; why: string }[];
}

/**
 * One page in Zoe's committed site inventory (built from the website repo by scripts/seo/build-zoe-pages.mts).
 * The matcher reads this to decide CREATE / IMPROVE / CONSOLIDATE / SKIP. FACTS ONLY — these are the pages
 * that actually exist; nothing here is a metric or an estimate.
 */
export interface ZoePage {
  path: string; // "/weddings"
  url: string; // absolute URL
  title: string | null;
  h1: string | null;
  headings: string[];
  /** Canonical Zoe service category (tents, tables, chairs, …) or null for non-category pages. */
  category: string | null;
  /** Short topic/section label (e.g. "weddings", "inventory"). */
  topic: string;
  intent: SeoIntent;
  /** Geography the page targets, or null for site-wide/DMV-general. */
  location: string | null;
  excerpt: string | null;
  /** Page role, for match weighting. */
  kind: "home" | "service" | "category" | "blog" | "info" | "other";
}
