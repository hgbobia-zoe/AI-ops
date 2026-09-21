// Post-Event engine smoke test. DATABASE_PATH is ":memory:" (vitest.config.ts), so this seeds a
// throwaway DB, drives one completed event through the whole funnel, and asserts the deterministic
// metrics move correctly at each stage. Also checks the cancelled-exclusion edge case.

import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "../db/index";
import { syncPostEvent, buildBoard, buildTimeline } from "./engine";
import { getProject, addContact, setState, setDisposition, addReview, closeProject } from "./store";
import { computeMetrics } from "./metrics";

function ymd(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}
function iso(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString();
}

beforeAll(() => {
  const db = getDb();
  // PE-1: an eligible completed event — route closed (all_completed), no separate pickup stop → the
  // fallback anchors eligibility to the route close time.
  db.prepare("INSERT INTO bookings (booking_id, event_name, event_date, status_label, client_name, venue, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run("PE-1", "Sarah Johnson Wedding", ymd(3), "Signed", "Sarah Johnson", "The Estate at River Run", iso(0));
  db.prepare("INSERT INTO event_outcomes (event_id, route_id, date, total_stops, completed_stops, all_completed, closed_at) VALUES (?,?,?,?,?,?,?)")
    .run("PE-1", "R-1", ymd(3), 2, 2, 1, iso(2));
  // PE-2: a cancelled booking that is also route-closed — must NEVER become a post-event project.
  db.prepare("INSERT INTO bookings (booking_id, event_name, event_date, status_label, client_name, venue, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run("PE-2", "Cancelled Gala", ymd(4), "Lost", "No Show", "Nowhere", iso(0));
  db.prepare("INSERT INTO event_outcomes (event_id, route_id, date, total_stops, completed_stops, all_completed, closed_at) VALUES (?,?,?,?,?,?,?)")
    .run("PE-2", "R-2", ymd(4), 1, 1, 1, iso(2));
});

describe("Post-Event engine", () => {
  it("makes a completed+picked-up event eligible and excludes cancelled ones", () => {
    const res = syncPostEvent();
    expect(res.newlyEligible).toBe(1); // only PE-1
    const p = getProject("PE-1");
    expect(p).not.toBeNull();
    expect(p!.state).toBe("needs_follow_up");
    expect(p!.pickupAt).toBeTruthy();
    expect(getProject("PE-2")).toBeNull(); // cancelled → never entered the workflow
  });

  it("keeps attempted / reached / confirmed / requested / received as distinct funnel steps", () => {
    // Baseline: 1 completed, nothing else yet.
    let m = computeMetrics();
    expect(m.counts.completed).toBe(1);
    expect(m.counts.followUpInitiated).toBe(0);
    expect(m.counts.customerReached).toBe(0);
    expect(m.counts.reviewsReceived).toBe(0);
    expect(m.rates.overallReviewRate).toEqual({ num: 0, den: 1, pct: 0 });

    // A no-answer attempt = follow-up initiated, but NOT reached.
    addContact("PE-1", { channel: "phone", outcome: "no_answer" }, "Lisa");
    m = computeMetrics();
    expect(m.counts.followUpInitiated).toBe(1);
    expect(m.counts.customerReached).toBe(0);

    // Customer responds (inbound) = reached. Human sets state + a positive disposition = confirmed+positive.
    addContact("PE-1", { channel: "sms", outcome: "customer_responded", direction: "inbound" }, "Lisa");
    setState("PE-1", "customer_responded", "Lisa");
    setDisposition("PE-1", "positive");
    setState("PE-1", "experience_confirmed", "Lisa");
    m = computeMetrics();
    expect(m.counts.customerReached).toBe(1);
    expect(m.counts.experienceConfirmed).toBe(1);
    expect(m.counts.positiveExperiences).toBe(1);
    expect(m.counts.reviewRequestsSent).toBe(0); // requested != confirmed

    // Review requested (recorded, human-triggered) — still not received.
    addReview({ bookingId: "PE-1", kind: "requested", employee: "Lisa", channel: "sms" });
    setState("PE-1", "review_requested", "Lisa");
    m = computeMetrics();
    expect(m.counts.reviewRequestsSent).toBe(1);
    expect(m.counts.reviewsReceived).toBe(0);
    expect(m.rates.reviewRequestRate).toEqual({ num: 1, den: 1, pct: 100 }); // 1 request / 1 positive

    // Review received — the terminal win.
    addReview({ bookingId: "PE-1", kind: "received", employee: "Lisa", rating: 5 });
    setState("PE-1", "review_completed", "Lisa");
    m = computeMetrics();
    expect(m.counts.reviewsReceived).toBe(1);
    expect(m.rates.reviewConversion).toEqual({ num: 1, den: 1, pct: 100 }); // 1 received / 1 request
    expect(m.rates.overallReviewRate).toEqual({ num: 1, den: 1, pct: 100 });
  });

  it("renders a rate as Unavailable (pct null) when its denominator is 0", () => {
    // issueRate = issues / experienceConfirmed; there are 0 issues but 1 confirmed → 0/1 = 0 (not null).
    // contactRate den is followUpInitiated (>0 here). Construct a true 0-denominator: reviewConversion is
    // 1/1 now; instead assert the shape guarantee via a fresh future-dated period with no projects.
    const empty = computeMetrics({ start: "2999-01-01", end: "2999-12-31" });
    expect(empty.counts.completed).toBe(0);
    expect(empty.rates.overallReviewRate.pct).toBeNull(); // 0/0 → Unavailable, never a fabricated %
  });

  it("builds a timeline and a board, and closing requires a structured reason", () => {
    const timeline = buildTimeline("PE-1");
    expect(timeline.length).toBeGreaterThan(0);

    closeProject("PE-1", "review_completed", null, "Lisa");
    const closed = getProject("PE-1");
    expect(closed!.state).toBe("closed");
    expect(closed!.closureReason).toBe("review_completed");
    expect(closed!.closedAt).toBeTruthy();

    const board = buildBoard();
    expect(board.columns.closed.some((c) => c.bookingId === "PE-1")).toBe(true);
    expect(board.columns.needs_follow_up.length).toBe(0);
  });
});
