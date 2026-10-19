import { describe, it, expect, afterEach } from "vitest";
import { isForbiddenActionType } from "@/lib/aiorg/approvals";
import {
  escalationTier,
  normalizeRiskSeverity,
  ownerRoleFor,
  planResolution,
  resolutionConfig,
} from "./policy";
import type { CanonicalException, EscalationTier, ResolutionStatus } from "./types";

function risk(over: Partial<CanonicalException> = {}): CanonicalException {
  return {
    source: "risk",
    sourceId: "sig-1",
    type: "route_no_driver",
    severity: "high",
    title: "t",
    detail: "d",
    actionTarget: "goodshuffle",
    transactionId: "555",
    deadline: null,
    recommendedAction: "do the thing",
    ownerHint: null,
    firstDetectedAt: null,
    ...over,
  };
}

afterEach(() => {
  delete process.env.EXCEPTION_ESCALATE_AFTER_HOURS;
  delete process.env.EXCEPTION_MAX_RESOLVE_ATTEMPTS;
  delete process.env.EXCEPTION_OWNER_SEVERITIES;
});

describe("severity normalization", () => {
  it("maps risk severities onto the four-level scale", () => {
    expect(normalizeRiskSeverity("CRITICAL")).toBe("critical");
    expect(normalizeRiskSeverity("HIGH")).toBe("high");
    expect(normalizeRiskSeverity("MEDIUM")).toBe("medium");
    expect(normalizeRiskSeverity("LOW")).toBe("low");
    expect(normalizeRiskSeverity("weird")).toBe("low");
  });
});

describe("owner-role routing", () => {
  it("routes by actionTarget then finer type", () => {
    expect(ownerRoleFor(risk({ actionTarget: "connecteam" }))).toBe("scheduling");
    expect(ownerRoleFor(risk({ actionTarget: "dispatch" }))).toBe("dispatch");
    expect(ownerRoleFor(risk({ actionTarget: "goodshuffle", type: "warehouse_short" }))).toBe("warehouse");
    expect(ownerRoleFor(risk({ actionTarget: "goodshuffle", type: "payment_overdue" }))).toBe("finance");
    expect(ownerRoleFor(risk({ actionTarget: "goodshuffle", type: "customer_communication_gap" }))).toBe("sales");
    expect(ownerRoleFor(risk({ actionTarget: "goodshuffle", type: "something_else" }))).toBe("ops");
    expect(ownerRoleFor({ ...risk(), source: "dead_letter" })).toBe("ops");
  });
});

describe("resolution routing (authorized vs delegate vs escalate)", () => {
  it("proposes a create_gs_task for a Goodshuffle-writable risk with a transactionID", () => {
    const plan = planResolution(risk());
    expect(plan.kind).toBe("propose");
    expect(plan.actionType).toBe("create_gs_task");
  });

  it("the proposed action is NEVER a forbidden (money/schedule/hiring) action type", () => {
    const plan = planResolution(risk());
    expect(plan.kind).toBe("propose");
    expect(isForbiddenActionType(plan.actionType!)).toBe(false);
  });

  it("delegates a Goodshuffle risk that has no transactionID (missing data, nothing to write to)", () => {
    const plan = planResolution(risk({ transactionId: null }));
    expect(plan.kind).toBe("delegate");
    expect(plan.role).toBe("ops");
  });

  it("delegates staffing/crew (connecteam) and routing (dispatch) — never auto-executes them", () => {
    expect(planResolution(risk({ actionTarget: "connecteam" })).kind).toBe("delegate");
    expect(planResolution(risk({ actionTarget: "connecteam" })).role).toBe("scheduling");
    expect(planResolution(risk({ actionTarget: "dispatch" })).kind).toBe("delegate");
  });

  it("escalates a dead-lettered write-back (its action already failed)", () => {
    const plan = planResolution({ ...risk(), source: "dead_letter", type: "dead_letter:email_send" });
    expect(plan.kind).toBe("escalate");
  });
});

describe("config parsing", () => {
  it("uses safe defaults", () => {
    const c = resolutionConfig();
    expect(c.escalateAfterHours).toBe(24);
    expect(c.maxResolveAttempts).toBe(2);
    expect(c.ownerSeverities.has("critical")).toBe(true);
    expect(c.ownerSeverities.has("high")).toBe(false);
  });
  it("honors env overrides", () => {
    process.env.EXCEPTION_ESCALATE_AFTER_HOURS = "4";
    process.env.EXCEPTION_MAX_RESOLVE_ATTEMPTS = "3";
    process.env.EXCEPTION_OWNER_SEVERITIES = "high,critical";
    const c = resolutionConfig();
    expect(c.escalateAfterHours).toBe(4);
    expect(c.maxResolveAttempts).toBe(3);
    expect(c.ownerSeverities.has("high")).toBe(true);
  });
  it("ignores a garbage severity list and falls back", () => {
    process.env.EXCEPTION_OWNER_SEVERITIES = "nonsense,bogus";
    expect(resolutionConfig().ownerSeverities.has("critical")).toBe(true);
  });
});

describe("escalation tier (team before owner)", () => {
  const T0 = Date.parse("2026-10-19T12:00:00.000Z");
  const base = {
    severity: "medium" as const,
    status: "active" as ResolutionStatus,
    resolveAttempts: 0,
    firstDetectedAt: new Date(T0).toISOString(),
    deadline: null as string | null,
    currentTier: "none" as EscalationTier,
    now: T0 + 60_000,
  };

  it("a fresh, on-time, non-critical exception needs no escalation", () => {
    expect(escalationTier(base)).toBe("none");
  });

  it("owner tier for a critical exception (high impact)", () => {
    expect(escalationTier({ ...base, severity: "critical" })).toBe("owner");
  });

  it("owner tier when repeatedly failing (attempts ≥ budget)", () => {
    expect(escalationTier({ ...base, resolveAttempts: 2 })).toBe("owner");
  });

  it("team tier for a failed resolution that is not yet owner-grade", () => {
    expect(escalationTier({ ...base, status: "failed" })).toBe("team");
  });

  it("team tier when overdue by age", () => {
    const old = new Date(T0 - 48 * 3_600_000).toISOString();
    expect(escalationTier({ ...base, firstDetectedAt: old })).toBe("team");
  });

  it("team tier when past a hard deadline", () => {
    expect(escalationTier({ ...base, deadline: new Date(T0 - 1000).toISOString() })).toBe("team");
  });

  it("owner tier when ALREADY at team AND now overdue", () => {
    const old = new Date(T0 - 48 * 3_600_000).toISOString();
    expect(escalationTier({ ...base, currentTier: "team", firstDetectedAt: old })).toBe("owner");
  });

  it("never regresses below the tier already reached (monotonic)", () => {
    expect(escalationTier({ ...base, currentTier: "owner" })).toBe("owner");
  });
});
