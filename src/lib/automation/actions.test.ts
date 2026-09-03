import { describe, it, expect } from "vitest";
import { proposeFromRisks, proposeFromGaps, orderProposals, type RiskLike } from "./actions";

const risk = (over: Partial<RiskLike>): RiskLike => ({
  signature: "sig",
  riskType: "route_no_driver",
  severity: "CRITICAL",
  title: "No driver",
  description: "Route has no driver",
  recommendedAction: "Assign a driver to this route.",
  actionTarget: "dispatch",
  ...over,
});

describe("automation — proposing actions from risks", () => {
  it("wraps a risk's recommended action with the target's intended tier + reversibility", () => {
    const [p] = proposeFromRisks([risk({})]);
    expect(p.key).toBe("risk|sig");
    expect(p.target).toBe("dispatch");
    expect(p.tier).toBe("approve"); // dispatch = consequential → human approves
    expect(p.actionType).toBe("assign_driver");
    expect(p.reversible).toBe(true);
    expect(p.outward).toBe(false);
    expect(p.title).toBe("Assign a driver to this route.");
  });

  it("marks a Goodshuffle action as outward", () => {
    const [p] = proposeFromRisks([risk({ signature: "gs", riskType: "route_schedule_unverified", actionTarget: "goodshuffle", recommendedAction: "Add windows." })]);
    expect(p.target).toBe("goodshuffle");
    expect(p.outward).toBe(true);
    expect(p.actionType).toBe("add_windows");
  });

  it("routes staffing_unverified to a safe internal refresh regardless of stated target", () => {
    const [p] = proposeFromRisks([risk({ signature: "sv", riskType: "staffing_unverified", actionTarget: "connecteam", recommendedAction: "Re-check staffing." })]);
    expect(p.target).toBe("internal");
    expect(p.tier).toBe("observe");
    expect(p.outward).toBe(false);
    expect(p.actionType).toBe("recheck_connecteam");
  });

  it("skips risks that carry no recommended action", () => {
    expect(proposeFromRisks([risk({ recommendedAction: undefined })])).toHaveLength(0);
  });

  it("proposes a review action per booking gap (internal, non-outward)", () => {
    const [p] = proposeFromGaps([{ label: "Sep 6 – 12" }]);
    expect(p.key).toBe("gap|Sep 6 – 12");
    expect(p.target).toBe("internal");
    expect(p.outward).toBe(false);
    expect(p.tier).toBe("recommend");
  });

  it("orders approve-tier items ahead of observe-tier, criticals first", () => {
    const props = [
      ...proposeFromGaps([{ label: "wk" }]), // recommend
      ...proposeFromRisks([
        risk({ signature: "a", severity: "HIGH" }), // approve/dispatch
        risk({ signature: "b", riskType: "staffing_unverified", actionTarget: "connecteam", recommendedAction: "x" }), // observe
      ]),
    ];
    const ordered = orderProposals(props);
    expect(ordered[0].tier).toBe("approve");
    expect(ordered[ordered.length - 1].tier).toBe("observe");
  });
});
