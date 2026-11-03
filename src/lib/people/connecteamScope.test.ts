// Connecteam write access record: set ONLY by a passing probe, cleared by a definite denial, and the open
// Connecteam checklist steps follow it.

import { describe, it, expect, vi, afterEach } from "vitest";
import { setSecret, getSecret } from "@/lib/secrets";
import { createEmployee, getTask, listTasks } from "./store";
import { startOnboarding } from "./lifecycle";
import { connecteamScopeStatus, verifyConnecteamScope } from "./connecteamScope";
import { getAdapter } from "./adapters";

function mockProbe(status: number): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status, headers: { "content-type": "application/json" } })));
}

const savedKey = process.env.CONNECTEAM_API_KEY;
afterEach(() => {
  vi.unstubAllGlobals();
  if (savedKey === undefined) delete process.env.CONNECTEAM_API_KEY;
  else process.env.CONNECTEAM_API_KEY = savedKey;
  setSecret("connecteam.provisioningScope", null);
});

describe("verifyConnecteamScope", () => {
  it("a passing probe verifies, flips the adapter to automated, and moves open steps to approval", async () => {
    process.env.CONNECTEAM_API_KEY = process.env.CONNECTEAM_API_KEY || "test-key";
    const e = createEmployee({ displayName: "Cam Crew", role: "member", department: "warehouse", phone: "+12025550100" });
    startOnboarding(e.id, "tester");
    const ct = listTasks(e.id, "provision").find((t) => t.adapterId === "connecteam")!;
    expect(ct.status).toBe("manual_required");

    mockProbe(400); // an empty create is rejected as "no users" but NOT scope-denied: write access present
    const r = await verifyConnecteamScope("Hermann");
    expect(r.ok).toBe(true);
    expect(getSecret("connecteam.provisioningScope")).toBe("verified");
    expect(getAdapter("connecteam").mode()).toBe("automated");
    expect(getTask(ct.id)!.status).toBe("pending");
    expect(getTask(ct.id)!.mode).toBe("automated");
    expect(connecteamScopeStatus().last?.by).toBe("Hermann");
  });

  it("a scope denial clears the record and puts open steps back to manual", async () => {
    process.env.CONNECTEAM_API_KEY = process.env.CONNECTEAM_API_KEY || "test-key";
    setSecret("connecteam.provisioningScope", "verified");
    const e = createEmployee({ displayName: "Dee Crew", role: "member", department: "warehouse", phone: "+12025550101" });
    startOnboarding(e.id, "tester");
    const ct = listTasks(e.id, "provision").find((t) => t.adapterId === "connecteam")!;
    expect(ct.status).toBe("pending");

    mockProbe(403);
    const r = await verifyConnecteamScope("Hermann");
    expect(r.ok).toBe(false);
    expect(getSecret("connecteam.provisioningScope")).toBeNull();
    expect(getTask(ct.id)!.status).toBe("manual_required");
  });
});
