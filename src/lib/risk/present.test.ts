import { describe, it, expect } from "vitest";
import {
  severityTone,
  statusTone,
  isUnverified,
  affectedScope,
  scopeKindLabel,
  sourceLabel,
  resolutionTarget,
  nextAction,
  overflowActions,
  filterRisks,
  DEFAULT_FILTERS,
  daysUntilLabel,
} from "./present";
import type { StoredRisk } from "./store";
import type { RiskSeverity, RiskStatus } from "./types";

function risk(partial: Partial<StoredRisk>): StoredRisk {
  return {
    id: partial.id ?? "RK-1",
    signature: partial.signature ?? "sig",
    riskType: partial.riskType ?? "route_no_driver",
    category: partial.category ?? "DRIVER",
    severity: partial.severity ?? "HIGH",
    status: partial.status ?? "OPEN",
    title: partial.title ?? "Risk",
    description: partial.description ?? "desc",
    date: partial.date,
    eventId: partial.eventId,
    routeId: partial.routeId,
    truckId: partial.truckId,
    affectedEntity: partial.affectedEntity,
    recommendedAction: partial.recommendedAction,
    actionTarget: partial.actionTarget,
    owner: partial.owner,
    deadline: partial.deadline,
    metadata: partial.metadata,
    firstDetectedAt: partial.firstDetectedAt ?? "2026-10-01T00:00:00Z",
    lastSeenAt: partial.lastSeenAt ?? "2026-10-01T00:00:00Z",
    resolvedAt: partial.resolvedAt,
  };
}

describe("severity + state tone (restrained status model)", () => {
  it("maps severity to a Nocturne tone, never conflating medium with critical", () => {
    const expected: Record<RiskSeverity, string> = {
      CRITICAL: "critical",
      HIGH: "attention",
      MEDIUM: "attention",
      LOW: "neutral",
    };
    (Object.keys(expected) as RiskSeverity[]).forEach((s) => expect(severityTone(s)).toBe(expected[s]));
  });
  it("gives OPEN no status colour of its own (severity carries weight) and IN_PROGRESS the info tone", () => {
    expect(statusTone("OPEN")).toBe("neutral");
    expect(statusTone("IN_PROGRESS")).toBe("info");
    expect(statusTone("RESOLVED")).toBe("positive");
  });
});

describe("affected scope — day-level risks are operational dates, not events", () => {
  it("labels a risk with no event/route as an Operational date, not a specific event", () => {
    const s = affectedScope(risk({ riskType: "driver_shortage", date: "2026-11-01" }));
    expect(s.tier).toBe("day");
    expect(scopeKindLabel(s)).toBe("Operational date");
  });
  it("labels an event-tied risk as an Event", () => {
    const s = affectedScope(risk({ eventId: "TX123", date: "2026-11-01" }));
    expect(s.tier).toBe("event");
    expect(scopeKindLabel(s)).toBe("Event");
  });
  it("labels a route-tied risk with its truck", () => {
    const s = affectedScope(risk({ routeId: "R1", truckId: "Truck 7", date: "2026-11-01" }));
    expect(s.tier).toBe("route");
    expect(scopeKindLabel(s)).toBe("Route · Truck 7");
  });
  it("event identity takes precedence over route when both are present", () => {
    expect(affectedScope(risk({ eventId: "TX1", routeId: "R1" })).tier).toBe("event");
  });
});

describe("unverified / stale source", () => {
  it("flags the staffing_unverified type as an unknown (not a confirmed deficiency)", () => {
    expect(isUnverified(risk({ riskType: "staffing_unverified" }))).toBe(true);
    expect(isUnverified(risk({ riskType: "route_schedule_unverified" }))).toBe(true);
    expect(isUnverified(risk({ riskType: "route_no_driver" }))).toBe(false);
  });
});

describe("source + resolution target (never invent a deep link)", () => {
  it("names the signal source from the action target", () => {
    expect(sourceLabel("connecteam")).toMatch(/Connecteam/);
    expect(sourceLabel(undefined)).toMatch(/engine/i);
  });
  it("only maps the three engine-emitted targets, nothing invented", () => {
    expect(resolutionTarget("connecteam")?.external).toBe(true);
    expect(resolutionTarget("dispatch")?.external).toBe(false);
    expect(resolutionTarget("made_up")).toBeUndefined();
    expect(resolutionTarget(undefined)).toBeUndefined();
  });
});

describe("lifecycle actions — one promoted next action, rest in overflow", () => {
  it("promotes the single next valid step forward", () => {
    expect(nextAction("OPEN")?.status).toBe("ACKNOWLEDGED");
    expect(nextAction("ACKNOWLEDGED")?.status).toBe("IN_PROGRESS");
    expect(nextAction("IN_PROGRESS")?.status).toBe("RESOLVED");
    expect(nextAction("RESOLVED")).toBeUndefined();
    expect(nextAction("DISMISSED")).toBeUndefined();
  });
  it("keeps the remaining valid actions in overflow, never duplicating the promoted one", () => {
    const states: RiskStatus[] = ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"];
    for (const s of states) {
      const next = nextAction(s);
      const overflow = overflowActions(s);
      expect(overflow.some((a) => a.status === next?.status)).toBe(false);
      // Dismiss is always available as a secondary action on an active risk.
      expect(overflow.some((a) => a.status === "DISMISSED")).toBe(true);
    }
  });
  it("marks Resolve and Dismiss as needing confirmation; Acknowledge/Start do not", () => {
    expect(nextAction("IN_PROGRESS")?.confirm).toBe(true); // Resolve
    expect(nextAction("OPEN")?.confirm).toBe(false); // Acknowledge
    const dismiss = overflowActions("OPEN").find((a) => a.status === "DISMISSED");
    expect(dismiss?.confirm).toBe(true);
  });
});

describe("filters — severity / state / freshness", () => {
  const queue = [
    risk({ id: "a", severity: "CRITICAL", status: "OPEN", riskType: "route_no_driver" }),
    risk({ id: "b", severity: "MEDIUM", status: "ACKNOWLEDGED", riskType: "staffing_unverified" }),
    risk({ id: "c", severity: "LOW", status: "IN_PROGRESS", riskType: "driver_shortage" }),
  ];
  it("ALL filters return everything", () => {
    expect(filterRisks(queue, DEFAULT_FILTERS)).toHaveLength(3);
  });
  it("severity filter narrows to one level", () => {
    expect(filterRisks(queue, { ...DEFAULT_FILTERS, severity: "CRITICAL" }).map((r) => r.id)).toEqual(["a"]);
  });
  it("state filter narrows to one lifecycle state", () => {
    expect(filterRisks(queue, { ...DEFAULT_FILTERS, state: "IN_PROGRESS" }).map((r) => r.id)).toEqual(["c"]);
  });
  it("freshness isolates unverified from verified", () => {
    expect(filterRisks(queue, { ...DEFAULT_FILTERS, freshness: "UNVERIFIED" }).map((r) => r.id)).toEqual(["b"]);
    expect(filterRisks(queue, { ...DEFAULT_FILTERS, freshness: "VERIFIED" }).map((r) => r.id)).toEqual(["a", "c"]);
  });
  it("combines filters", () => {
    expect(filterRisks(queue, { severity: "MEDIUM", state: "ACKNOWLEDGED", freshness: "UNVERIFIED" })).toHaveLength(1);
  });
});

describe("daysUntilLabel", () => {
  const today = "2026-11-01";
  it("renders today / tomorrow / in Nd / Nd ago", () => {
    expect(daysUntilLabel("2026-11-01", today)).toBe("today");
    expect(daysUntilLabel("2026-11-02", today)).toBe("tomorrow");
    expect(daysUntilLabel("2026-11-05", today)).toBe("in 4d");
    expect(daysUntilLabel("2026-10-30", today)).toBe("2d ago");
  });
});
