// Adapter honesty tests. mode() reports "automated" ONLY for the Zoe platform (our own DB); every external
// adapter stays manual/future with no scope verified — a key being present is never enough. And a verified
// scope assertion only promotes a manual adapter to "partial", never fabricates a real integration.

import { describe, it, expect, afterEach } from "vitest";
import { getDb } from "@/lib/db";
import { allAdapters, getAdapter, hasVerifiedProvisioningScope } from "./index";
import { setSecret } from "@/lib/secrets";

afterEach(() => {
  getDb().prepare("DELETE FROM secrets").run();
});

describe("adapter mode() honesty", () => {
  it("only the Zoe platform is automated; every external adapter is manual/future", () => {
    expect(getAdapter("zoe_platform").mode()).toBe("automated");
    for (const a of allAdapters()) {
      if (a.id === "zoe_platform") continue;
      expect(["manual", "future"]).toContain(a.mode());
    }
  });

  it("google + gusto are future (no integration exists at all)", () => {
    expect(getAdapter("google").mode()).toBe("future");
    expect(getAdapter("gusto").mode()).toBe("future");
  });

  it("a mere key present does NOT make an adapter automated — only a verified scope promotes it (to partial)", () => {
    // Simulate a stored API key WITHOUT a verified scope → still manual.
    setSecret("connecteam.apiKey", "some-key");
    expect(getAdapter("connecteam").mode()).toBe("manual");
    expect(hasVerifiedProvisioningScope("connecteam")).toBe(false);

    // Only an explicit verified-scope record promotes it — and only to "partial", never "automated".
    setSecret("connecteam.provisioningScope", "verified");
    expect(hasVerifiedProvisioningScope("connecteam")).toBe(true);
    expect(getAdapter("connecteam").mode()).toBe("partial");
  });
});

describe("adapter actions never fake a write", () => {
  it("a manual adapter returns manual_required with a human instruction (never ok)", async () => {
    const emp = {
      id: "E-1", displayName: "Pat", workEmail: null, lifecycleState: "ONBOARD" as const, role: "member" as const,
      department: "sales", startDate: null, endDate: null, userId: null, hrWorkerId: null, connecteamUserId: null,
      instaworkWorker: null, openphoneUserId: null, gustoId: null, aiOrgHumanName: null, createdAt: "", updatedAt: "",
    };
    const r = await getAdapter("goodshuffle").automate(emp);
    expect(r.ok).toBe(false);
    expect(r.status).toBe("manual_required");
    expect(r.detail).toMatch(/by hand/i);
  });

  it("the Zoe adapter revoke is honest manual_required when no login is linked", async () => {
    const emp = {
      id: "E-2", displayName: "Pat", workEmail: null, lifecycleState: "OFFBOARD" as const, role: "member" as const,
      department: "sales", startDate: null, endDate: null, userId: null, hrWorkerId: null, connecteamUserId: null,
      instaworkWorker: null, openphoneUserId: null, gustoId: null, aiOrgHumanName: null, createdAt: "", updatedAt: "",
    };
    const r = await getAdapter("zoe_platform").revoke(emp);
    expect(r.ok).toBe(false);
    expect(r.status).toBe("manual_required");
  });
});
