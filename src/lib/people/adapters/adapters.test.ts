// Adapter honesty + real-action tests.
//  • mode() is gated on a REAL capability: Connecteam = automated only once the write scope is verified;
//    the replay adapters (Goodshuffle/Quo/Slack) = automated only once their endpoint constant is captured;
//    Gusto/Google stay future. A key being present is never enough.
//  • The actions never fake a write: a not-yet-capable adapter returns a manual/blocked result, and a
//    capable one performs the real action (Connecteam REST create/archive, mocked) or enqueues the replay op.

import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db";
import { allAdapters, getAdapter, hasVerifiedProvisioningScope } from "./index";
import { setSecret } from "@/lib/secrets";
import { createEmployee, getEmployee } from "../store";
import { PROVISION_ENDPOINTS } from "../provisioningEndpoints";
import type { Employee } from "../types";

function fakeEmp(over: Partial<Employee> = {}): Employee {
  return {
    id: "E-1", displayName: "Pat Driver", workEmail: null, phone: null, lifecycleState: "ONBOARD", role: "member",
    department: "sales", startDate: null, endDate: null, userId: null, hrWorkerId: null, connecteamUserId: null,
    instaworkWorker: null, openphoneUserId: null, gustoId: null, aiOrgHumanName: null, createdAt: "", updatedAt: "",
    ...over,
  };
}

function mockFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as ReturnType<typeof vi.fn>;
  vi.stubGlobal("fetch", fn);
  return fn;
}

function pendingProvisionOps(): { op: string; payload: unknown }[] {
  return getDb().prepare("SELECT op, payload FROM gs_outbox WHERE op IN ('provision_user','revoke_user')").all() as { op: string; payload: unknown }[];
}

afterEach(() => {
  getDb().prepare("DELETE FROM secrets").run();
  getDb().prepare("DELETE FROM gs_outbox").run();
  // Restore any endpoint a test captured.
  PROVISION_ENDPOINTS.goodshuffle.provision = null;
  PROVISION_ENDPOINTS.goodshuffle.revoke = null;
  vi.restoreAllMocks();
  delete process.env.CONNECTEAM_API_KEY;
});

describe("mode() honesty", () => {
  it("only Zoe is automated by default; Connecteam + replay systems are manual; Gusto/Google are future", () => {
    expect(getAdapter("zoe_platform").mode()).toBe("automated");
    expect(getAdapter("connecteam").mode()).toBe("manual"); // no verified scope
    expect(getAdapter("goodshuffle").mode()).toBe("manual"); // endpoint capture-pending
    expect(getAdapter("quo").mode()).toBe("manual");
    expect(getAdapter("slack").mode()).toBe("manual");
    expect(getAdapter("gusto").mode()).toBe("future");
    expect(getAdapter("google").mode()).toBe("future");
    // No adapter is secretly automated beyond the ones we expect.
    const automated = allAdapters().filter((a) => a.mode() === "automated").map((a) => a.id);
    expect(automated).toEqual(["zoe_platform"]);
  });

  it("a mere Connecteam key does NOT promote the adapter — only a verified scope flips it to automated", () => {
    setSecret("connecteam.apiKey", "some-key");
    expect(getAdapter("connecteam").mode()).toBe("manual");
    expect(hasVerifiedProvisioningScope("connecteam")).toBe(false);

    setSecret("connecteam.provisioningScope", "verified");
    expect(hasVerifiedProvisioningScope("connecteam")).toBe(true);
    expect(getAdapter("connecteam").mode()).toBe("automated"); // REAL API + verified scope
  });

  it("a replay adapter is automated only once its endpoint constant is captured (non-null)", () => {
    expect(getAdapter("goodshuffle").mode()).toBe("manual");
    PROVISION_ENDPOINTS.goodshuffle.provision = { method: "POST", path: "/app/team/invite", bodyType: "form" };
    expect(getAdapter("goodshuffle").mode()).toBe("automated");
  });
});

describe("Connecteam adapter actions (real REST, mocked)", () => {
  it("automate creates the user, stores the link on the employee, and reports completed", async () => {
    process.env.CONNECTEAM_API_KEY = "test-key";
    setSecret("connecteam.provisioningScope", "verified");
    const emp = createEmployee({ displayName: "Pat Driver", role: "member", department: "driver", phone: "+12025550123" });
    mockFetch(200, { data: { results: [{ userId: 4242 }] } });

    const r = await getAdapter("connecteam").automate(getEmployee(emp.id)!);
    expect(r.ok).toBe(true);
    expect(r.status).toBe("completed");
    expect(r.externalRef).toBe("connecteam:4242");
    expect(getEmployee(emp.id)!.connecteamUserId).toBe(4242); // link stored
  });

  it("a 403 (missing write scope) at run time → manual_required, NOT a faked completion, no link stored", async () => {
    process.env.CONNECTEAM_API_KEY = "test-key";
    setSecret("connecteam.provisioningScope", "verified");
    const emp = createEmployee({ displayName: "Pat Driver", role: "member", department: "driver", phone: "+12025550123" });
    mockFetch(403, { message: "forbidden" });

    const r = await getAdapter("connecteam").automate(getEmployee(emp.id)!);
    expect(r.ok).toBe(false);
    expect(r.status).toBe("manual_required");
    expect(getEmployee(emp.id)!.connecteamUserId).toBeNull();
  });

  it("automate is honestly blocked when the employee has no phone", async () => {
    process.env.CONNECTEAM_API_KEY = "test-key";
    setSecret("connecteam.provisioningScope", "verified");
    const r = await getAdapter("connecteam").automate(fakeEmp({ phone: null }));
    expect(r.ok).toBe(false);
    expect(r.status).toBe("blocked");
    expect(r.detail).toMatch(/phone required/i);
  });

  it("revoke archives the linked Connecteam user", async () => {
    process.env.CONNECTEAM_API_KEY = "test-key";
    setSecret("connecteam.provisioningScope", "verified");
    const fn = mockFetch(200, {});
    const r = await getAdapter("connecteam").revoke(fakeEmp({ connecteamUserId: 4242 }));
    expect(r.ok).toBe(true);
    expect(r.status).toBe("completed");
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/users/v1/users/4242");
    expect(url).toContain("deletionType=archive");
    expect(init.method).toBe("DELETE");
  });
});

describe("Replay adapter actions never fake a write", () => {
  it("endpoint uncaptured → automate returns manual_required and enqueues NOTHING", async () => {
    const r = await getAdapter("goodshuffle").automate(fakeEmp());
    expect(r.ok).toBe(false);
    expect(r.status).toBe("manual_required");
    expect(r.detail).toMatch(/by hand/i);
    expect(pendingProvisionOps().length).toBe(0);
  });

  it("endpoint captured → automate enqueues a provision_user op (in_progress, awaiting the drainer)", async () => {
    PROVISION_ENDPOINTS.goodshuffle.provision = { method: "POST", path: "/app/team/invite", bodyType: "form" };
    const r = await getAdapter("goodshuffle").automate(fakeEmp({ id: "E-xyz" }));
    expect(r.ok).toBe(true);
    expect(r.status).toBe("in_progress");
    const ops = pendingProvisionOps();
    expect(ops.length).toBe(1);
    expect(ops[0].op).toBe("provision_user");
    const payload = JSON.parse(String(ops[0].payload)) as { system: string; employeeId: string };
    expect(payload.system).toBe("goodshuffle");
    expect(payload.employeeId).toBe("E-xyz");
  });
});
