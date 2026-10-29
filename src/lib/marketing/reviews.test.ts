// Tests for the pure reviews/reputation derivations. These lock the SCOPE honesty (logged-only
// metrics), the rating a11y labels, the response-state / next-action rules, and filtering/search.

import { describe, it, expect } from "vitest";
import {
  ratingLabel,
  starFills,
  responseState,
  nextAction,
  summarizeReviews,
  filterReviews,
  isExternalPlatform,
  REVIEW_KIND,
  MAX_RATING,
} from "./reviews";
import type { Review } from "./types";

function review(over: Partial<Review> = {}): Review {
  return {
    id: over.id ?? `MR-${Math.random().toString(36).slice(2)}`,
    source: over.source ?? "google",
    reviewer: over.reviewer ?? "Reviewer",
    rating: over.rating === undefined ? 5 : over.rating,
    reviewDate: over.reviewDate ?? "2026-10-01",
    text: over.text ?? "",
    responded: over.responded ?? false,
    responseNote: over.responseNote ?? "",
    link: over.link ?? "",
    createdAt: over.createdAt ?? "2026-10-01T00:00:00.000Z",
    updatedAt: over.updatedAt ?? "2026-10-01T00:00:00.000Z",
  };
}

describe("ratingLabel", () => {
  it("gives an accessible out-of-5 label for a rating", () => {
    expect(ratingLabel(5)).toBe("5 out of 5 stars");
    expect(ratingLabel(3)).toBe("3 out of 5 stars");
  });
  it("names a missing rating clearly rather than showing zero", () => {
    expect(ratingLabel(null)).toBe("No rating recorded");
  });
});

describe("starFills", () => {
  it("fills left-to-right for a rating", () => {
    expect(starFills(3)).toEqual([true, true, true, false, false]);
  });
  it("renders a null rating as all-empty (not a 1-star)", () => {
    expect(starFills(null)).toEqual([false, false, false, false, false]);
    expect(starFills(null)).toHaveLength(MAX_RATING);
  });
  it("clamps out-of-range values", () => {
    expect(starFills(9)).toEqual([true, true, true, true, true]);
  });
});

describe("responseState", () => {
  it("is attention + Needs reply when unresponded", () => {
    expect(responseState({ responded: false })).toEqual({ tone: "attention", label: "Needs reply" });
  });
  it("is positive + Replied when responded", () => {
    expect(responseState({ responded: true })).toEqual({ tone: "positive", label: "Replied" });
  });
});

describe("nextAction", () => {
  it("points to the external platform for an unanswered external review", () => {
    expect(nextAction({ responded: false, source: "the_knot" })).toEqual({
      label: "Respond on The Knot",
      tone: "attention",
    });
  });
  it("points to the reviewer for an unanswered off-platform (other) review", () => {
    expect(nextAction({ responded: false, source: "other" })).toEqual({
      label: "Respond to the reviewer",
      tone: "attention",
    });
  });
  it("has no action once replied", () => {
    expect(nextAction({ responded: true, source: "google" }).label).toBe("");
  });
});

describe("isExternalPlatform", () => {
  it("treats the review platforms as external but not 'other'", () => {
    expect(isExternalPlatform("google")).toBe(true);
    expect(isExternalPlatform("yelp")).toBe(true);
    expect(isExternalPlatform("other")).toBe(false);
  });
});

describe("summarizeReviews (logged-only scope)", () => {
  it("is all zeroes / null for an empty workspace — never a fabricated figure", () => {
    const s = summarizeReviews([]);
    expect(s).toMatchObject({ logged: 0, rated: 0, avgRating: null, unresponded: 0, replied: 0, sourcesUsed: [] });
  });
  it("averages ONLY rated reviews and rounds to 1dp; unrated don't drag it to zero", () => {
    const s = summarizeReviews([
      review({ rating: 5 }),
      review({ rating: 4 }),
      review({ rating: null }), // logged but unrated — counts toward logged, not toward avg
    ]);
    expect(s.logged).toBe(3);
    expect(s.rated).toBe(2);
    expect(s.avgRating).toBe(4.5);
  });
  it("counts replied vs awaiting-reply and splits by source", () => {
    const s = summarizeReviews([
      review({ source: "google", responded: true }),
      review({ source: "google", responded: false }),
      review({ source: "yelp", responded: false }),
    ]);
    expect(s.replied).toBe(1);
    expect(s.unresponded).toBe(2);
    expect(s.bySource.google).toBe(2);
    expect(s.bySource.yelp).toBe(1);
    expect(s.sourcesUsed).toEqual(["google", "yelp"]);
  });
});

describe("filterReviews", () => {
  const data: Review[] = [
    review({ id: "a", reviewer: "Alice", source: "google", rating: 5, responded: true, text: "Amazing tent setup" }),
    review({ id: "b", reviewer: "Bob", source: "yelp", rating: 2, responded: false, text: "Late delivery" }),
    review({ id: "c", reviewer: "Cara", source: "the_knot", rating: null, responded: false, text: "" }),
  ];

  it("returns everything with no filter", () => {
    expect(filterReviews(data)).toHaveLength(3);
  });
  it("filters to only-unanswered", () => {
    expect(filterReviews(data, { onlyUnanswered: true }).map((r) => r.id)).toEqual(["b", "c"]);
  });
  it("filters by source", () => {
    expect(filterReviews(data, { source: "yelp" }).map((r) => r.id)).toEqual(["b"]);
  });
  it("filters by a specific rating and by the explicit unrated bucket", () => {
    expect(filterReviews(data, { rating: 5 }).map((r) => r.id)).toEqual(["a"]);
    expect(filterReviews(data, { rating: "unrated" }).map((r) => r.id)).toEqual(["c"]);
  });
  it("searches reviewer name and review text case-insensitively", () => {
    expect(filterReviews(data, { query: "alice" }).map((r) => r.id)).toEqual(["a"]);
    expect(filterReviews(data, { query: "late" }).map((r) => r.id)).toEqual(["b"]);
  });
  it("combines filters (unanswered + source + search)", () => {
    expect(filterReviews(data, { onlyUnanswered: true, source: "yelp", query: "delivery" }).map((r) => r.id)).toEqual(["b"]);
  });
});

describe("REVIEW_KIND keeps the four concepts distinct", () => {
  it("has separate labels for logged / external / request / feedback", () => {
    const labels = new Set([
      REVIEW_KIND.logged.label,
      REVIEW_KIND.external.label,
      REVIEW_KIND.request.label,
      REVIEW_KIND.feedback.label,
    ]);
    expect(labels.size).toBe(4);
    expect(REVIEW_KIND.external.note).toMatch(/not pulled in|no connection/i);
  });
});
