// SEO Growth Engine — shared types. FACTS ONLY: an Ubersuggest metric is a third-party ESTIMATE and
// is always kept apart from internal workflow state and business outcomes. Absent = UNKNOWN, never 0.

/** Search intent for a keyword (as Ubersuggest classifies it, or "unknown" when not provided). */
export type SeoIntent = "informational" | "commercial" | "transactional" | "navigational" | "unknown";

/** The recommended editorial action for an opportunity (derived in Phase 2 — null until analyzed). */
export type SeoAction = "CREATE" | "IMPROVE" | "CONSOLIDATE" | "SKIP";

/** How the opportunity was discovered. `serp` = a live Google SERP read (the office runner, current source);
 *  `ubersuggest` is retained for back-compat with rows pulled before the SERP pivot. */
export type SeoSource = "serp" | "ubersuggest" | "manual" | "derived";

/** Where the attached metrics came from (provenance of the `metrics` blob). A SERP read gives rankings, NOT
 *  volume/difficulty, so a SERP-sourced opportunity keeps `metricsSource: "none"` (those stay honest UNKNOWN);
 *  `"serp"`/`"ubersuggest"` exist for a future metrics provider + back-compat. */
export type SeoMetricsSource = "serp" | "ubersuggest" | "none";

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

/** One organic result on a read SERP: the ranking domain, its 1-based position, the URL and the title. FACTS
 *  ONLY — these are positions actually observed on the page, never estimated. */
export interface SerpResultEntry {
  domain: string;
  /** 1-based organic position as observed on the SERP. */
  rank: number;
  url: string;
  title: string | null;
}

/**
 * A live Google SERP read for a keyword — the current data source (office runner). Everything here is OBSERVED
 * on the page, never estimated: who ranks, whether Zoe appears and where. Volume/difficulty are NOT part of a
 * SERP read and stay UNKNOWN in `metrics` (that is honest, not a gap in the data). null `zoeRank` = Zoe did not
 * appear in the read organic results (the competitive gap signal).
 */
export interface SerpData {
  /** ISO time the SERP was read. */
  retrievedAt: string;
  /** Zoe's 1-based organic position, or null when Zoe does not appear in the read results. */
  zoeRank: number | null;
  /** True iff Zoe appears in the read organic results. */
  zoePresent: boolean;
  /** The organic results read, best-first (capped). */
  topDomains: SerpResultEntry[];
  /** "People also ask" questions observed, if any. */
  peopleAlsoAsk: string[];
  /** "Related searches" observed, if any. */
  relatedSearches: string[];
  /** Locale the SERP was read for (e.g. "US"). */
  locale: string;
}

/**
 * Market-level rollup: a competitor domain and how often/where it ranks across Zoe's tracked keywords. Derived
 * purely from the stored SERP reads (see serp.ts aggregateCompetitorDomains) — nothing fabricated. Zoe's own
 * domain and known directories/aggregators are excluded.
 */
export interface SeoCompetitorDomain {
  domain: string;
  /** How many tracked keywords this domain ranks for (on the read SERPs). */
  appearances: number;
  /** Mean 1-based rank across those appearances (lower = stronger). */
  avgRank: number;
  /** The keywords it ranks for (capped for display). */
  keywords: string[];
  firstSeen: string;
  lastSeen: string;
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
  /** Third-party ESTIMATE blob (volume/difficulty/cpc). null when never fetched. A SERP read does not populate
   *  this — those metrics stay UNKNOWN until a metrics provider is wired. */
  metrics: SeoMetrics | null;
  metricsSource: SeoMetricsSource;
  /** The latest live SERP read for this keyword (positions actually observed), or null when never read. The
   *  competitive-gap engine reads this; absent = UNKNOWN, never assumed. */
  serp: SerpData | null;
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

// ── Phase 4: landing-page production (draft → quality → review → approval) ───────────────────────────
//
// A page DRAFT is the structured landing-page proposal the engine produces for an APPROVED opportunity,
// reusing an existing Zoe page as the structural template. HONESTY LAW: the scaffolder NEVER invents
// pricing, inventory, service areas, guarantees or testimonials — anywhere a business-specific fact is
// needed it inserts an explicit "[NEEDS REVIEW: …]" marker that the quality checker flags for a human.
// Publishing is a SEPARATE authorized step (not in this engine); the furthest the engine goes on its own
// is APPROVED (a human-approved draft), never a live page.

/** Review lifecycle of a single page draft (distinct from the opportunity's Kanban stage). */
export type SeoDraftReviewState = "DRAFT" | "IN_REVIEW" | "APPROVED" | "REJECTED";

export const SEO_DRAFT_REVIEW_STATES: SeoDraftReviewState[] = ["DRAFT", "IN_REVIEW", "APPROVED", "REJECTED"];

/** Where a draft's copy came from — deterministic scaffold (facts + review markers) or an LLM enrichment pass. */
export type SeoDraftSource = "deterministic" | "llm";

/** One section of body copy. `sourced` = rests only on approved/known facts (no review markers). */
export interface PageDraftBodyBlock {
  heading: string;
  level: 2 | 3;
  paragraphs: string[];
  /** True when every paragraph rests on approved facts; false when it carries a [NEEDS REVIEW] marker. */
  sourced: boolean;
}

export interface PageDraftInternalLink {
  anchor: string;
  path: string;
}

/** The research provenance behind a draft — kept explicit so sourced facts are never confused with copy. */
export interface PageDraftSources {
  keyword: string;
  intent: SeoIntent;
  location: string | null;
  category: string | null;
  relatedKeywords: string[];
  competitorRefs: string[];
  /** Third-party ESTIMATE (Ubersuggest), null when none pulled. */
  metrics: SeoMetrics | null;
  metricsSource: SeoMetricsSource;
  researchAt: string | null;
  templatePath: string | null;
  /** Honest note about how complete the research behind this draft is. */
  researchNote: string;
}

export interface PageDraft {
  id: string;
  opportunityId: string;
  /** Target URL path (also the idempotency key with opportunityId). */
  slug: string;
  /** CREATE | IMPROVE | CONSOLIDATE — a SKIP opportunity is never drafted. */
  action: SeoAction;
  templatePath: string | null;
  title: string;
  metaDescription: string;
  h1: string;
  canonicalUrl: string;
  /** Section headings (H2s) in order. */
  outline: string[];
  body: PageDraftBodyBlock[];
  /** JSON-LD structured data, or null. Only known fields — never a fabricated price/rating. */
  schema: Record<string, unknown> | null;
  internalLinks: PageDraftInternalLink[];
  sources: PageDraftSources;
  /** Quality findings snapshot at draft time (the live checker re-runs on every read). */
  flags: SeoQualityFinding[];
  draftSource: SeoDraftSource;
  reviewState: SeoDraftReviewState;
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── deterministic quality checks ────────────────────────────────────────────────────────────────────

export type SeoQualitySeverity = "error" | "warn" | "info";

export interface SeoQualityFinding {
  /** Stable check id, e.g. "title.length". */
  id: string;
  /** Human bucket: Title | Meta | Headings | URL | Schema | Internal links | Factual claims | Duplication | Accessibility. */
  category: string;
  severity: SeoQualitySeverity;
  message: string;
  /** Where it applies (field/section), when useful. */
  field?: string;
}

export interface SeoQualityReport {
  findings: SeoQualityFinding[];
  errors: number;
  warnings: number;
  /** True when there are zero error-severity findings. A reviewer gate — NOT an auto-publish signal. */
  passedStructural: boolean;
  /** Count of claims / missing business details flagged for human verification. */
  unsupportedClaims: number;
}
