import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  selectQuoteReviewTargets,
  selectHotLeads,
  decideSignatureAlert,
  decideThrottle,
  salesAiEnabled,
  runSalesAiJob,
  SALES_AI_ALERT_COOLOFF_MS,
  type QuoteCandidate,
  type LeadCandidate,
} from "./salesAiJob";
import { foldInsight, summarize, type QuoteInsight } from "./quoteInsights";

const qc = (over: Partial<QuoteCandidate> = {}): QuoteCandidate => ({
  id: "P1",
  value: 8000,
  quoteAgeDays: 10,
  stage: "follow_up",
  itemCount: 3,
  ...over,
});

describe("selectQuoteReviewTargets", () => {
  const opts = { minValue: 5000, minAgeDays: 7, topN: 5 };

  it("keeps quotes over the value floor, with items, and aged past the floor", () => {
    const out = selectQuoteReviewTargets([qc()], opts);
    expect(out.map((x) => x.id)).toEqual(["P1"]);
  });

  it("drops quotes below the value floor", () => {
    expect(selectQuoteReviewTargets([qc({ value: 4999 })], opts)).toEqual([]);
  });

  it("drops quotes with no line items (nothing to review)", () => {
    expect(selectQuoteReviewTargets([qc({ itemCount: 0 })], opts)).toEqual([]);
  });

  it("drops a fresh, non-closing quote but keeps a closing one regardless of age", () => {
    expect(selectQuoteReviewTargets([qc({ quoteAgeDays: 1, stage: "awaiting" })], opts)).toEqual([]);
    const closing = selectQuoteReviewTargets([qc({ quoteAgeDays: 0, stage: "closing" })], opts);
    expect(closing.map((x) => x.id)).toEqual(["P1"]);
  });

  it("handles a null age (unknown) by requiring the closing window", () => {
    expect(selectQuoteReviewTargets([qc({ quoteAgeDays: null, stage: "follow_up" })], opts)).toEqual([]);
    expect(selectQuoteReviewTargets([qc({ quoteAgeDays: null, stage: "closing" })], opts)).toHaveLength(1);
  });

  it("sorts by value desc and caps at topN", () => {
    const cands = [qc({ id: "a", value: 6000 }), qc({ id: "b", value: 20000 }), qc({ id: "c", value: 9000 })];
    const out = selectQuoteReviewTargets(cands, { ...opts, topN: 2 });
    expect(out.map((x) => x.id)).toEqual(["b", "c"]);
  });
});

describe("selectHotLeads", () => {
  const lc = (over: Partial<LeadCandidate> = {}): LeadCandidate => ({ id: "L1", clientName: "Acme", value: 12000, urgency: "now", quoteAgeDays: 5, stage: "closing", ...over });
  const opts = { minValue: 10000, topN: 5 };

  it("keeps act-now leads over the value floor", () => {
    expect(selectHotLeads([lc()], opts).map((x) => x.id)).toEqual(["L1"]);
  });
  it("drops non-now urgencies and below-floor values", () => {
    expect(selectHotLeads([lc({ urgency: "today" })], opts)).toEqual([]);
    expect(selectHotLeads([lc({ value: 9000 })], opts)).toEqual([]);
  });
  it("sorts by value desc and caps", () => {
    const out = selectHotLeads([lc({ id: "a", value: 11000 }), lc({ id: "b", value: 50000 })], { ...opts, topN: 1 });
    expect(out.map((x) => x.id)).toEqual(["b"]);
  });
});

describe("decideSignatureAlert — dedupe", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");

  it("posts the first time there is something to say", () => {
    const { alert, next } = decideSignatureAlert(undefined, "a,b", now);
    expect(alert).toBe(true);
    expect(next.sig).toBe("a,b");
  });

  it("suppresses the same signature within the cool-off", () => {
    const prev = { sig: "a,b", lastAlertedAt: new Date(now).toISOString() };
    expect(decideSignatureAlert(prev, "a,b", now + SALES_AI_ALERT_COOLOFF_MS - 1).alert).toBe(false);
  });

  it("re-posts the same signature once the cool-off elapses", () => {
    const prev = { sig: "a,b", lastAlertedAt: new Date(now).toISOString() };
    expect(decideSignatureAlert(prev, "a,b", now + SALES_AI_ALERT_COOLOFF_MS + 1).alert).toBe(true);
  });

  it("re-posts immediately when the signature changes (new material)", () => {
    const prev = { sig: "a,b", lastAlertedAt: new Date(now).toISOString() };
    expect(decideSignatureAlert(prev, "a,b,c", now + 1).alert).toBe(true);
  });

  it("never posts when there is nothing to say", () => {
    expect(decideSignatureAlert(undefined, "", now).alert).toBe(false);
  });
});

describe("decideThrottle", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  const sixHours = 6 * 60 * 60 * 1000;
  it("runs when never run before", () => {
    expect(decideThrottle(undefined, now, sixHours)).toBe(true);
  });
  it("skips inside the interval, runs after it", () => {
    const last = new Date(now - sixHours + 1000).toISOString();
    expect(decideThrottle(last, now, sixHours)).toBe(false);
    const older = new Date(now - sixHours - 1000).toISOString();
    expect(decideThrottle(older, now, sixHours)).toBe(true);
  });
});

describe("SALES_AI_ENABLED master switch (default OFF)", () => {
  beforeEach(() => {
    delete process.env.SALES_AI_ENABLED;
  });
  afterEach(() => {
    delete process.env.SALES_AI_ENABLED;
  });

  it("is OFF by default", () => {
    expect(salesAiEnabled()).toBe(false);
  });

  it("only 'true' turns it on", () => {
    process.env.SALES_AI_ENABLED = "1";
    expect(salesAiEnabled()).toBe(false);
    process.env.SALES_AI_ENABLED = "true";
    expect(salesAiEnabled()).toBe(true);
  });

  it("the whole job is inert (no DB/LLM touched) when the switch is off", async () => {
    // With the switch off, runSalesAiJob returns the disabled no-op BEFORE reading leads, calling the LLM,
    // creating approvals, or posting to Slack — so it is safe to run unconfigured.
    const r = await runSalesAiJob();
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/disabled/i);
  });
});

describe("quoteInsights — fold + summarize (pure)", () => {
  const ins = (over: Partial<QuoteInsight> = {}): QuoteInsight => ({
    leadId: "P1",
    clientName: "Acme",
    eventName: "Gala",
    value: 8000,
    eventDate: "2026-11-01",
    quoteAgeDays: 10,
    stage: "follow_up",
    flagged: true,
    risks: ["tent with no sidewalls"],
    notes: "",
    crew: 4,
    model: "claude-haiku-4-5",
    at: "2026-10-15T12:00:00Z",
    ...over,
  });

  it("dedupes by lead (latest wins) and keeps newest first", () => {
    const a = ins({ leadId: "P1", at: "2026-10-15T10:00:00Z", flagged: false });
    const b = ins({ leadId: "P2", at: "2026-10-15T11:00:00Z" });
    const a2 = ins({ leadId: "P1", at: "2026-10-15T12:00:00Z", flagged: true });
    const list = foldInsight(foldInsight([a], b), a2);
    expect(list.map((x) => x.leadId)).toEqual(["P1", "P2"]);
    expect(list[0].flagged).toBe(true); // the later P1 replaced the earlier one
  });

  it("caps the retained window", () => {
    let list: QuoteInsight[] = [];
    for (let i = 0; i < 10; i++) list = foldInsight(list, ins({ leadId: `P${i}` }), 3);
    expect(list).toHaveLength(3);
  });

  it("summarize counts total + flagged and exposes the latest", () => {
    const s = summarize([ins({ leadId: "P1", flagged: true }), ins({ leadId: "P2", flagged: false })]);
    expect(s.total).toBe(2);
    expect(s.flagged).toBe(1);
    expect(s.latest?.leadId).toBe("P1");
  });
});
