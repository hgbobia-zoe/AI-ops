import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeMercuryTxn,
  classifyWire,
  matchWireAmount,
  wireAlertCard,
  wireFailedCard,
  mergeWireRecord,
  readWireEvent,
  upsertWireEvent,
  listWireEvents,
  formatUsd,
  fmtDate,
  DEFAULT_WIRE_MATCH_PATTERN,
  wireMatchSource,
  type NormalizedTxn,
  type PeriodTotalCandidate,
  type WireEventRecord,
} from "./wireEvent";

function txn(over: Partial<Record<keyof NormalizedTxn, unknown>> = {}): NormalizedTxn {
  return normalizeMercuryTxn({
    amount: -5000,
    status: "sent",
    counterpartyName: "ZenPayroll",
    bankDescription: "ZenPayroll payroll wire",
    kind: "wireTransaction",
    createdAt: "2026-10-27T14:00:00.000Z",
    estimatedDeliveryDate: "2026-10-28T14:00:00.000Z",
    dashboardLink: "https://mercury.com/transactions/abc123",
    transactionId: "tx_abc123",
    ...over,
  });
}

const period = (label = "Oct 20 – Oct 26"): PeriodTotalCandidate["period"] => ({ start: "2026-10-20", end: "2026-10-26", label });
const noDash = (s: string) => expect(s).not.toMatch(/[—–]|\s-\s/); // no em/en dash, no spaced-hyphen dash
const noEmoji = (s: string) => expect(s).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u);

afterEach(() => {
  delete process.env.PAYROLL_WIRE_MATCH_PATTERN;
  delete process.env.PAYROLL_WIRE_MATCH_TOLERANCE_PCT;
});

describe("normalizeMercuryTxn (tolerant coercion)", () => {
  it("coerces types and lowercases status; unknowns become null", () => {
    const n = normalizeMercuryTxn({ amount: "-1234.5", status: "SENT", counterpartyName: "  Gusto  ", transactionId: 99 as unknown });
    expect(n.amount).toBe(-1234.5);
    expect(n.status).toBe("sent");
    expect(n.counterpartyName).toBe("Gusto");
    expect(n.transactionId).toBeNull(); // a number id is not accepted as a string id
    expect(n.bankDescription).toBeNull();
  });
  it("never throws on garbage / partial bodies", () => {
    expect(() => normalizeMercuryTxn(null)).not.toThrow();
    expect(() => normalizeMercuryTxn("nope")).not.toThrow();
    expect(normalizeMercuryTxn({}).amount).toBeNull();
  });
});

describe("classifyWire", () => {
  it("accepts an outgoing ZenPayroll wire", () => {
    const c = classifyWire(txn());
    expect(c.isPayrollWire).toBe(true);
    expect(c.amountAbs).toBe(5000);
  });
  it("accepts an outgoing wire named Gusto", () => {
    expect(classifyWire(txn({ counterpartyName: "Gusto", bankDescription: null })).isPayrollWire).toBe(true);
  });
  it("matches on bankDescription when the counterparty is blank", () => {
    expect(classifyWire(txn({ counterpartyName: null, bankDescription: "ACH debit ZENPAYROLL INC" })).isPayrollWire).toBe(true);
  });
  it("rejects an outgoing debit-card charge to Google", () => {
    const c = classifyWire(txn({ counterpartyName: "Google", bankDescription: "Google Workspace", kind: "debitCardTransaction" }));
    expect(c.isPayrollWire).toBe(false);
    expect(c.reason).toMatch(/did not match/);
  });
  it("rejects an outgoing Instawork transfer (not payroll)", () => {
    expect(classifyWire(txn({ counterpartyName: "Instawork.com", bankDescription: "Instawork", kind: "internalTransfer" })).isPayrollWire).toBe(false);
  });
  it("rejects an INCOMING ZenPayroll amount (money in, not a wire out)", () => {
    const c = classifyWire(txn({ amount: 5000 }));
    expect(c.isPayrollWire).toBe(false);
    expect(c.reason).toBe("not an outgoing debit");
  });
  it("honors an env-configured pattern and falls back safely on a bad one", () => {
    process.env.PAYROLL_WIRE_MATCH_PATTERN = "acmepay";
    expect(wireMatchSource()).toBe("acmepay");
    expect(classifyWire(txn({ counterpartyName: "AcmePay", bankDescription: null })).isPayrollWire).toBe(true);
    expect(classifyWire(txn()).isPayrollWire).toBe(false); // ZenPayroll no longer matches
    process.env.PAYROLL_WIRE_MATCH_PATTERN = "([bad"; // invalid regex
    expect(classifyWire(txn()).isPayrollWire).toBe(true); // falls back to the default pattern
    expect(wireMatchSource()).toBe("([bad");
    expect(DEFAULT_WIRE_MATCH_PATTERN).toBe("gusto|zenpayroll");
  });
});

describe("matchWireAmount (best-effort period correlation, never fabricated)", () => {
  const cands: PeriodTotalCandidate[] = [
    { period: period("Oct 20 – Oct 26"), expectedTotal: 5000, source: "current" },
    { period: period("Oct 13 – Oct 19"), expectedTotal: 8000, source: "previous" },
  ];
  it("matches the closest period within tolerance", () => {
    const m = matchWireAmount(5100, cands); // 2% off 5000
    expect(m).not.toBeNull();
    expect(m!.periodLabel).toBe("Oct 20 – Oct 26");
    expect(m!.expectedTotal).toBe(5000);
  });
  it("returns null when nothing is within tolerance (does not guess)", () => {
    expect(matchWireAmount(6000, cands)).toBeNull(); // 20% off the nearest
  });
  it("returns null with no candidates or a missing amount", () => {
    expect(matchWireAmount(5000, [])).toBeNull();
    expect(matchWireAmount(null, cands)).toBeNull();
  });
  it("respects a configured tolerance", () => {
    process.env.PAYROLL_WIRE_MATCH_TOLERANCE_PCT = "25";
    expect(matchWireAmount(6000, cands)).not.toBeNull(); // now within 25%
  });
});

describe("wire alert messages (house COMMS_STYLE: no dashes, no emoji; Viktor voice)", () => {
  const baseRec: WireEventRecord = {
    transactionId: "tx_abc123",
    amount: -5000,
    amountAbs: 5000,
    counterpartyName: "ZenPayroll",
    bankDescription: null,
    kind: "wireTransaction",
    status: "sent",
    createdAt: "2026-10-27T14:00:00.000Z",
    estimatedDeliveryDate: null,
    dashboardLink: "https://mercury.com/transactions/abc123",
    matchedPeriod: null,
    postedToSlack: false,
    postedAt: null,
    failureNotified: false,
    statusHistory: ["sent"],
    firstSeenAt: "2026-10-27T14:01:00.000Z",
    updatedAt: "2026-10-27T14:01:00.000Z",
  };

  it("formats amount and date correctly", () => {
    expect(formatUsd(5000)).toBe("$5,000.00");
    expect(formatUsd(null)).toBe("an unknown amount");
    expect(fmtDate("2026-10-27T14:00:00.000Z")).toBe("Oct 27, 2026");
    expect(fmtDate(null)).toBeNull();
  });

  it("builds a sent-alert card with the Gusto confirm next step and no dashes/emoji", () => {
    const card = wireAlertCard(baseRec);
    expect(card.title).toBe("Wire to Gusto sent");
    expect(card.body).toContain("Wire to Gusto sent.");
    expect(card.body).toContain("$5,000.00");
    expect(card.body).toContain("on Oct 27, 2026");
    expect(card.body).toContain("tx_abc123");
    expect(card.body).toContain("confirm the wire inside Gusto");
    expect(card.body).toContain("unconfirmed"); // no match on this record
    expect(card.link?.url).toBe("https://mercury.com/transactions/abc123");
    noDash(card.body!);
    noEmoji(card.body!);
    noEmoji(card.title);
    expect(card.emoji).toBeUndefined(); // no emoji decoration
  });

  it("names the matched pay period when correlation succeeded", () => {
    const card = wireAlertCard({ ...baseRec, matchedPeriod: { periodStart: "2026-10-20", periodEnd: "2026-10-26", periodLabel: "Oct 20 to Oct 26", expectedTotal: 5000, source: "current", deltaPct: 0 } });
    expect(card.body).toContain("Oct 20 to Oct 26");
    expect(card.body).toContain("expected about $5,000.00");
    noDash(card.body!);
  });

  it("builds a failed-update card", () => {
    const card = wireFailedCard({ ...baseRec, status: "failed" });
    expect(card.title).toBe("Gusto payroll wire failed");
    expect(card.body).toContain("failed status");
    noDash(card.body!);
    noEmoji(card.body!);
  });
});

describe("mergeWireRecord + KV store (dedup seam)", () => {
  it("creates then merges without losing a found match or clobbering fields with null", () => {
    const pending = txn({ status: "pending" });
    const rec1 = mergeWireRecord(pending, classifyWire(pending), { periodStart: "a", periodEnd: "b", periodLabel: "L", expectedTotal: 5000, source: "s", deltaPct: 0 }, null, "2026-10-27T14:00:00.000Z");
    expect(rec1.status).toBe("pending");
    expect(rec1.matchedPeriod).not.toBeNull();
    upsertWireEvent(rec1);

    // A later delivery with status "sent" and NO fresh match must keep the earlier match + advance status.
    const sent = txn({ status: "sent" });
    const rec2 = mergeWireRecord(sent, classifyWire(sent), null, readWireEvent("tx_abc123"), "2026-10-27T15:00:00.000Z");
    expect(rec2.status).toBe("sent");
    expect(rec2.matchedPeriod).not.toBeNull(); // not clobbered
    expect(rec2.statusHistory).toEqual(["pending", "sent"]);
    expect(rec2.firstSeenAt).toBe("2026-10-27T14:00:00.000Z"); // preserved
    upsertWireEvent(rec2);

    expect(listWireEvents().some((r) => r.transactionId === "tx_abc123")).toBe(true);
  });
});
