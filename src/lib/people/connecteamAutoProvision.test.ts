// Connecteam onboarding runs on its own: the tick checks write access itself (the probe creates nobody),
// then runs the Connecteam step for everyone onboarding. The step links an account someone already made by
// hand and only creates one when none exists, so a hand-made account is never duplicated.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSecret, setSecret } from "@/lib/secrets";
import { setJson } from "@/lib/kv";
import { resetConnecteamReadCaches } from "@/lib/connecteam";
import { createEmployee, getEmployee, listTasks, setEmployeeConnecteamUserId } from "./store";
import { executeAutomatedTask, startOnboarding } from "./lifecycle";
import { runPeopleLifecycleTick } from "./lifecycleTick";

type CtUser = { userId: number; firstName: string; lastName: string; phoneNumber?: string; email?: string };
type Call = { method: string; url: string; body: unknown };

/** A fake Connecteam: GET users returns `users`, an empty POST is the write probe, a real POST creates. */
function fakeConnecteam(users: CtUser[], opts: { createId?: number; probeStatus?: number } = {}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url: String(url), body });
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      if (String(url).includes("/users/v1/users")) {
        if (method === "GET") return json({ data: { users } });
        if (method === "POST" && Array.isArray(body) && body.length === 0) return json({}, opts.probeStatus ?? 400);
        if (method === "POST") return json({ data: { results: [{ userId: opts.createId ?? 9100 }] } });
      }
      return json({ data: {} });
    }),
  );
  return calls;
}
const creates = (calls: Call[], phone?: string) =>
  calls.filter((c) => c.method === "POST" && Array.isArray(c.body) && c.body.length > 0 && (!phone || (c.body as Array<{ phoneNumber?: string }>)[0].phoneNumber === phone));

const OTHER: CtUser = { userId: 1, firstName: "Old", lastName: "Hand", phoneNumber: "+12025550000" };

beforeEach(() => {
  process.env.CONNECTEAM_API_KEY = "test-key";
  resetConnecteamReadCaches();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CONNECTEAM_API_KEY;
  setSecret("connecteam.provisioningScope", null);
  setJson("people.connecteamScope", null);
});

describe("Connecteam step looks before it creates", () => {
  it("links an account someone made by hand (matched by phone) and creates nothing", async () => {
    setSecret("connecteam.provisioningScope", "verified");
    const e = createEmployee({ displayName: "Hand Made", role: "member", department: "warehouse", phone: "(202) 555-0201" });
    startOnboarding(e.id, "tester");
    const ct = listTasks(e.id, "provision").find((t) => t.adapterId === "connecteam")!;

    const calls = fakeConnecteam([OTHER, { userId: 4242, firstName: "Hand", lastName: "Made", phoneNumber: "+12025550201" }]);
    const r = await executeAutomatedTask(ct.id, "tester");
    expect(r.ok).toBe(true);
    expect(r.task!.status).toBe("completed");
    expect(r.message).toMatch(/Already in Connecteam/);
    expect(getEmployee(e.id)!.connecteamUserId).toBe(4242);
    expect(creates(calls)).toHaveLength(0);
  });

  it("matches by email when the phone is not on the account", async () => {
    setSecret("connecteam.provisioningScope", "verified");
    const e = createEmployee({ displayName: "Mail Match", role: "member", department: "warehouse", phone: "+12025550202", personalEmail: "Mail.Match@Example.com" });
    startOnboarding(e.id, "tester");
    const ct = listTasks(e.id, "provision").find((t) => t.adapterId === "connecteam")!;

    const calls = fakeConnecteam([OTHER, { userId: 4343, firstName: "Mail", lastName: "Match", email: "mail.match@example.com" }]);
    const r = await executeAutomatedTask(ct.id, "tester");
    expect(r.task!.status).toBe("completed");
    expect(getEmployee(e.id)!.connecteamUserId).toBe(4343);
    expect(creates(calls)).toHaveLength(0);
  });

  it("does not create when the team cannot be read", async () => {
    setSecret("connecteam.provisioningScope", "verified");
    const e = createEmployee({ displayName: "Blind Spot", role: "member", department: "warehouse", phone: "+12025550203" });
    startOnboarding(e.id, "tester");
    const ct = listTasks(e.id, "provision").find((t) => t.adapterId === "connecteam")!;

    const calls = fakeConnecteam([]);
    const r = await executeAutomatedTask(ct.id, "tester");
    expect(r.ok).toBe(false);
    expect(r.task!.status).toBe("failed");
    expect(creates(calls)).toHaveLength(0);
  });

  it("refuses to link an account that already belongs to someone else in People", async () => {
    setSecret("connecteam.provisioningScope", "verified");
    const holder = createEmployee({ displayName: "First Holder", role: "member", department: "warehouse" });
    setEmployeeConnecteamUserId(holder.id, 4444);
    const e = createEmployee({ displayName: "Second Try", role: "member", department: "warehouse", phone: "+12025550204" });
    startOnboarding(e.id, "tester");
    const ct = listTasks(e.id, "provision").find((t) => t.adapterId === "connecteam")!;

    const calls = fakeConnecteam([OTHER, { userId: 4444, firstName: "Second", lastName: "Try", phoneNumber: "+12025550204" }]);
    const r = await executeAutomatedTask(ct.id, "tester");
    expect(r.task!.status).toBe("manual_required");
    expect(getEmployee(e.id)!.connecteamUserId).toBeNull();
    expect(creates(calls)).toHaveLength(0);
  });
});

describe("the tick runs Connecteam onboarding on its own", () => {
  it("checks write access itself, then links the hand-made account without a click", async () => {
    const e = createEmployee({ displayName: "Tick Linked", role: "member", department: "warehouse", phone: "+12025550205" });
    startOnboarding(e.id, "tester");
    expect(listTasks(e.id, "provision").find((t) => t.adapterId === "connecteam")!.status).toBe("manual_required");

    const calls = fakeConnecteam([OTHER, { userId: 4545, firstName: "Tick", lastName: "Linked", phoneNumber: "+12025550205" }]);
    await runPeopleLifecycleTick();
    expect(getSecret("connecteam.provisioningScope")).toBe("verified");
    const ct = listTasks(e.id, "provision").find((t) => t.adapterId === "connecteam")!;
    expect(ct.status).toBe("completed");
    expect(getEmployee(e.id)!.connecteamUserId).toBe(4545);
    expect(creates(calls, "+12025550205")).toHaveLength(0);
  });

  it("creates the user when none exists, with no activation text", async () => {
    setSecret("connecteam.provisioningScope", "verified");
    const e = createEmployee({ displayName: "Brand New", role: "member", department: "warehouse", phone: "+12025550206" });
    startOnboarding(e.id, "tester");

    const calls = fakeConnecteam([OTHER], { createId: 4646 });
    await runPeopleLifecycleTick();
    expect(listTasks(e.id, "provision").find((t) => t.adapterId === "connecteam")!.status).toBe("completed");
    expect(getEmployee(e.id)!.connecteamUserId).toBe(4646);
    const made = creates(calls, "+12025550206");
    expect(made).toHaveLength(1);
    expect(made[0].url).not.toContain("sendActivation");
  });

  it("leaves the step manual when the key cannot write, and does not recheck within a day", async () => {
    const e = createEmployee({ displayName: "No Scope", role: "member", department: "warehouse", phone: "+12025550207" });
    startOnboarding(e.id, "tester");

    const calls = fakeConnecteam([OTHER], { probeStatus: 403 });
    await runPeopleLifecycleTick();
    expect(getSecret("connecteam.provisioningScope")).toBeNull();
    expect(listTasks(e.id, "provision").find((t) => t.adapterId === "connecteam")!.status).toBe("manual_required");
    const probes = () => calls.filter((c) => c.method === "POST" && Array.isArray(c.body) && c.body.length === 0).length;
    expect(probes()).toBe(1);
    await runPeopleLifecycleTick();
    expect(probes()).toBe(1);
  });
});
