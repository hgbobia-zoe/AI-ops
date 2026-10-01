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
  explanation: string | null;
  owner: string | null;
  status: SeoStatus;
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
