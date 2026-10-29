import { describe, it, expect } from "vitest";
import { laneOf, pastEventRationale, type OpportunityView } from "./service";
import type { SignalMaturity, LifecycleStage, SalesStatus } from "./types";

// Minimal OpportunityView factory — laneOf / pastEventRationale only read stage, salesStatus,
// maturity.maturity, score.tier, primaryTarget and hasExistingRelationship. Everything else is stubbed.
function makeView(o: {
  maturity: SignalMaturity;
  tier?: "HIGH" | "MEDIUM" | "LOW" | "UNQUALIFIED";
  stage?: LifecycleStage;
  salesStatus?: SalesStatus;
  hasTarget?: boolean;
  hasRelationship?: boolean;
}): OpportunityView {
  return {
    opp: { salesStatus: o.salesStatus ?? "NONE" },
    score: { tier: o.tier ?? "MEDIUM" },
    maturity: { maturity: o.maturity },
    stage: o.stage ?? "DISCOVERED",
    entities: [],
    primaryTarget: o.hasTarget ? ({ edge: { entity: { name: "Target Co" } }, relationshipLabel: "Prime contractor" } as OpportunityView["primaryTarget"]) : null,
    hasExistingRelationship: o.hasRelationship ?? false,
    recommendedAction: "",
    value: null,
  } as unknown as OpportunityView;
}

describe("laneOf — past-event classification", () => {
  it("never puts a PAST opportunity in OUTREACH_READY even if a person left it at an outreach stage", () => {
    const v = makeView({ maturity: "PAST", tier: "HIGH", stage: "OUTREACH_READY", hasTarget: true });
    expect(laneOf(v)).not.toBe("OUTREACH_READY");
  });

  it("routes a PAST qualified opportunity with an existing Zoe relationship to EARLY_SIGNALS (repeat outreach)", () => {
    const v = makeView({ maturity: "PAST", tier: "HIGH", stage: "OUTREACH_READY", hasTarget: true, hasRelationship: true });
    expect(laneOf(v)).toBe("EARLY_SIGNALS");
  });

  it("routes a PAST opportunity with no relationship to NEW_SIGNALS for re-triage", () => {
    const v = makeView({ maturity: "PAST", tier: "MEDIUM", stage: "TARGET_IDENTIFIED", hasTarget: true, hasRelationship: false });
    expect(laneOf(v)).toBe("NEW_SIGNALS");
  });

  it("an active sales handoff still wins over PAST timing", () => {
    const v = makeView({ maturity: "PAST", salesStatus: "LINKED" });
    expect(laneOf(v)).toBe("ACTIVE");
  });
});

describe("laneOf — live (non-past) timing is preserved", () => {
  it("a qualified opportunity at an outreach stage is OUTREACH_READY", () => {
    const v = makeView({ maturity: "IMMEDIATE", tier: "HIGH", stage: "OUTREACH_READY", hasTarget: true });
    expect(laneOf(v)).toBe("OUTREACH_READY");
  });

  it("a qualified target in an actionable window is OUTREACH_READY", () => {
    const v = makeView({ maturity: "OPERATIONALLY_ACTIVE", tier: "MEDIUM", stage: "RESEARCHING", hasTarget: true });
    expect(laneOf(v)).toBe("OUTREACH_READY");
  });

  it("a long-lead planning signal is EARLY_SIGNALS", () => {
    const v = makeView({ maturity: "PLANNING", tier: "MEDIUM", stage: "DISCOVERED" });
    expect(laneOf(v)).toBe("EARLY_SIGNALS");
  });

  it("a date-unknown discovery is NEW_SIGNALS", () => {
    const v = makeView({ maturity: "DATE_UNKNOWN", tier: "LOW", stage: "DISCOVERED" });
    expect(laneOf(v)).toBe("NEW_SIGNALS");
  });
});

describe("pastEventRationale", () => {
  it("is null for a live opportunity", () => {
    expect(pastEventRationale(makeView({ maturity: "IMMEDIATE" }))).toBeNull();
  });
  it("explains a legitimate repeat/relationship lead for a past dated event with a relationship", () => {
    const note = pastEventRationale(makeView({ maturity: "PAST", hasRelationship: true }));
    expect(note).toMatch(/relationship/i);
    expect(note).toMatch(/passed/i);
  });
  it("flags a past event with no relationship for re-triage", () => {
    const note = pastEventRationale(makeView({ maturity: "PAST", hasRelationship: false }));
    expect(note).toMatch(/re-triage/i);
  });
});
