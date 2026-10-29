// Reviews & reputation — PURE derivations for the /marketing/reviews blade. Rules calculate here; the
// UI just renders. No DB import, no fabrication. The one thing this module is strict about is SCOPE:
// everything it computes describes reviews the team has LOGGED in this workspace. It never claims to
// know anything about external published reviews (Google / The Knot / WeddingWire / Yelp / Facebook),
// because the app has no connection that pulls them in. A low "logged" count means few have been
// entered here — NOT that few exist out in the world.

import type { Tone } from "@/lib/tone";
import {
  type Review,
  type ReviewSource,
  REVIEW_SOURCE_LABEL,
  REVIEW_SOURCES,
} from "./types";

// ── The four distinct things this surface must never merge into one metric ──────────────────────────
// Each is a separate concept with a separate source of truth. The blade keeps them visually apart.
export type ReviewKind = "logged" | "external" | "request" | "feedback";
export const REVIEW_KIND: Record<
  ReviewKind,
  { label: string; note: string }
> = {
  logged: {
    label: "Logged reviews",
    note: "Reviews the team has recorded here. Everything on this page counts only these.",
  },
  external: {
    label: "External published reviews",
    note: "Live on Google, The Knot, WeddingWire, Yelp and Facebook. Not pulled in — no connection exists — so counts here do not reflect them.",
  },
  request: {
    label: "Review requests",
    note: "Asking a past client to leave a review. Handled by the Post-Event service-first follow-up, not here.",
  },
  feedback: {
    label: "Customer feedback",
    note: "Private feedback captured in the Post-Event funnel. Distinct from a public review.",
  },
};

// All logged sources map to a platform where the review is published externally; "other" is anything
// off those platforms (a direct email, a referral note, a planner shout-out).
export const EXTERNAL_PLATFORM_SOURCES: ReviewSource[] = [
  "google",
  "the_knot",
  "wedding_wire",
  "yelp",
  "facebook",
];
export function isExternalPlatform(source: ReviewSource): boolean {
  return EXTERNAL_PLATFORM_SOURCES.includes(source);
}

// ── Rating ──────────────────────────────────────────────────────────────────────────────────────────
export const MAX_RATING = 5;

/** Accessible label for a rating — spoken by screen readers, and the clear "unknown" value when null. */
export function ratingLabel(rating: number | null): string {
  if (rating == null) return "No rating recorded";
  return `${rating} out of ${MAX_RATING} stars`;
}

/** Filled/empty star flags left→right, for the visual star row (paired with ratingLabel for a11y). */
export function starFills(rating: number | null): boolean[] {
  const r = rating == null ? 0 : Math.max(0, Math.min(MAX_RATING, Math.round(rating)));
  return Array.from({ length: MAX_RATING }, (_, i) => i < r);
}

// ── Response state + next action (deterministic, per logged review) ─────────────────────────────────
export interface ResponseState {
  tone: Tone;
  label: string;
}
/** Whether a logged review still needs a reply. Positive = replied, attention = still open. */
export function responseState(r: Pick<Review, "responded">): ResponseState {
  return r.responded
    ? { tone: "positive", label: "Replied" }
    : { tone: "attention", label: "Needs reply" };
}

export interface NextAction {
  /** "" when there is nothing to do (already replied). */
  label: string;
  tone: Tone;
}
/**
 * The concrete next step for a logged review. For an unanswered one the action names WHERE to respond
 * (on the source platform) — the app does not post replies itself, so this is guidance, not a button.
 */
export function nextAction(r: Pick<Review, "responded" | "source">): NextAction {
  if (r.responded) return { label: "", tone: "neutral" };
  const where = isExternalPlatform(r.source) ? `on ${REVIEW_SOURCE_LABEL[r.source]}` : "to the reviewer";
  return { label: `Respond ${where}`, tone: "attention" };
}

// ── Scope summary (logged only — labelled as such everywhere it is shown) ───────────────────────────
export interface ReviewSummary {
  logged: number;
  rated: number;
  avgRating: number | null; // across RATED logged reviews only, 1dp
  unresponded: number;
  replied: number;
  bySource: Record<ReviewSource, number>;
  sourcesUsed: ReviewSource[];
}

export function summarizeReviews(reviews: Review[]): ReviewSummary {
  const bySource = Object.fromEntries(REVIEW_SOURCES.map((s) => [s, 0])) as Record<ReviewSource, number>;
  let ratedSum = 0;
  let rated = 0;
  let unresponded = 0;
  for (const r of reviews) {
    bySource[r.source] = (bySource[r.source] ?? 0) + 1;
    if (r.rating != null) {
      rated += 1;
      ratedSum += r.rating;
    }
    if (!r.responded) unresponded += 1;
  }
  return {
    logged: reviews.length,
    rated,
    avgRating: rated ? Math.round((ratedSum / rated) * 10) / 10 : null,
    unresponded,
    replied: reviews.length - unresponded,
    bySource,
    sourcesUsed: REVIEW_SOURCES.filter((s) => bySource[s] > 0),
  };
}

// ── Filtering + search ──────────────────────────────────────────────────────────────────────────────
export type SourceFilter = ReviewSource | "all";
export type RatingFilter = number | "all" | "unrated";

export interface ReviewFilter {
  query?: string;
  source?: SourceFilter;
  rating?: RatingFilter;
  onlyUnanswered?: boolean;
}

function matchesRating(r: Review, rating: RatingFilter | undefined): boolean {
  if (rating == null || rating === "all") return true;
  if (rating === "unrated") return r.rating == null;
  return r.rating === rating;
}

/** Deterministic filter over LOGGED reviews. Query matches reviewer name + review text, case-insensitive. */
export function filterReviews(reviews: Review[], filter: ReviewFilter = {}): Review[] {
  const q = (filter.query ?? "").trim().toLowerCase();
  return reviews.filter((r) => {
    if (filter.onlyUnanswered && r.responded) return false;
    if (filter.source && filter.source !== "all" && r.source !== filter.source) return false;
    if (!matchesRating(r, filter.rating)) return false;
    if (q) {
      const hay = `${r.reviewer} ${r.text}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
