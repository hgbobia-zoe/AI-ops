// Access-policy seed tests — the Sales policy yields exactly the six systems with the modes the audit
// proved, and no manual/future system is ever inflated to "automated". PURE (seed config only).

import { describe, it, expect } from "vitest";
import { SEED_POLICIES, seedPolicy } from "./policy";

describe("seed policies", () => {
  it("Sales yields the six systems with the audited modes", () => {
    const sales = seedPolicy("sales")!;
    expect(sales.name).toBe("Sales Rep");
    const byId = Object.fromEntries(sales.rules.map((r) => [r.adapterId, r]));
    expect(Object.keys(byId).sort()).toEqual(["connecteam", "goodshuffle", "google", "quo", "slack", "zoe_platform"].sort());
    expect(byId.zoe_platform.mode).toBe("automated");
    expect(byId.goodshuffle.mode).toBe("manual");
    expect(byId.quo.mode).toBe("manual");
    expect(byId.connecteam.mode).toBe("manual");
    expect(byId.slack.mode).toBe("manual");
    expect(byId.google.mode).toBe("future"); // SSO is not implemented anywhere — never "automated"
  });

  it("only the Zoe platform is automated anywhere in the seed", () => {
    for (const p of SEED_POLICIES) {
      for (const r of p.rules) {
        if (r.mode === "automated") expect(r.adapterId).toBe("zoe_platform");
      }
    }
  });

  it("Warehouse is Connecteam only; Driver is Connecteam + Zoe Dispatch", () => {
    expect(seedPolicy("warehouse")!.rules.map((r) => r.adapterId)).toEqual(["connecteam"]);
    expect(seedPolicy("driver")!.rules.map((r) => r.adapterId).sort()).toEqual(["connecteam", "zoe_platform"].sort());
  });

  it("every seed policy has at least one required rule (so READY is meaningful)", () => {
    for (const p of SEED_POLICIES) expect(p.rules.some((r) => r.required)).toBe(true);
  });

  it("an unknown policy id is null", () => {
    expect(seedPolicy("nope")).toBeNull();
  });
});

import { deriveWorkEmail, policyIssuesWorkEmail, revokeRank } from "./policy";

describe("Sales Associate policy", () => {
  it("covers the seven systems, all required, plus an optional Zoe login", () => {
    const p = seedPolicy("sales_associate")!;
    expect(p.name).toBe("Sales Associate");
    const req = p.rules.filter((r) => r.required).map((r) => r.adapterId).sort();
    expect(req).toEqual(["connecteam", "goodshuffle", "gusto", "lockly", "quo", "slack", "sop_ack", "squarespace_email", "weddingpro", "whimsical", "yelp"]);
    expect(p.rules.find((r) => r.adapterId === "zoe_platform")?.required).toBe(false);
    expect(policyIssuesWorkEmail(p)).toBe(true);
    expect(policyIssuesWorkEmail(seedPolicy("warehouse"))).toBe(false);
  });
  it("offboarding removes the Lockly door first", () => {
    const ids = seedPolicy("sales_associate")!.rules.map((r) => r.adapterId);
    const ordered = [...ids].sort((a, b) => revokeRank(a) - revokeRank(b));
    expect(ordered[0]).toBe("lockly");
    expect(revokeRank("something_new")).toBeGreaterThan(revokeRank("gusto"));
  });
});

describe("deriveWorkEmail", () => {
  it("is firstname.lastname at the Zoe domain", () => {
    expect(deriveWorkEmail("Jordan Rivera")).toBe("jordan.rivera@zoeeventsdmv.com");
  });
  it("uses the first and last word, strips accents and punctuation", () => {
    expect(deriveWorkEmail("  José  María O'Brien ")).toBe("jose.obrien@zoeeventsdmv.com");
  });
  it("one word or no name", () => {
    expect(deriveWorkEmail("Cher")).toBe("cher@zoeeventsdmv.com");
    expect(deriveWorkEmail("   ")).toBeNull();
  });
});
