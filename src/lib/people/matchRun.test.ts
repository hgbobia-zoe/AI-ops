// Staff matching run against the DB: confident links are applied and audited, exceptions are stored, and a
// person confirming a link is validated (never steals an account held by someone else).

import { describe, it, expect } from "vitest";
import { createUser } from "@/lib/auth/users";
import { createEmployee, getEmployee } from "./store";
import { confirmLink, lastMatchReport, runStaffMatching } from "./matchRun";

describe("runStaffMatching", () => {
  it("links a Zoe login on full name and stores the exceptions it could not resolve", async () => {
    const e = createEmployee({ displayName: "Rita Moreno", role: "member", department: "sales_associate", lifecycleState: "ACTIVE" });
    const u = createUser({ username: "rita.m", name: "Rita Moreno", role: "member", password: "a-long-test-password-123" });
    const stray = createUser({ username: "zz-shared-box", name: "zz-shared-box", role: "member", password: "a-long-test-password-123" });

    const r = await runStaffMatching("Hermann");
    expect(getEmployee(e.id)!.userId).toBe(u.id);
    expect(r.linked.some((l) => l.employeeId === e.id && l.field === "user_id")).toBe(true);
    // Connecteam is not configured in tests, so there is no roster: a login with nobody in People is NOT
    // flagged yet (existing staff have not been imported), it waits for a run with the roster.
    expect(r.rosterOk).toBe(false);
    expect(r.exceptions.some((x) => x.key === `no_match:zoe:${stray.id}`)).toBe(false);
    expect(lastMatchReport()?.by).toBe("Hermann");
  });

  it("confirming a link refuses an account someone else already holds", async () => {
    const holder = createEmployee({ displayName: "Hold Er", role: "member", department: "sales_associate", lifecycleState: "ACTIVE" });
    const other = createEmployee({ displayName: "Oth Er", role: "member", department: "sales_associate", lifecycleState: "ACTIVE" });
    const u = createUser({ username: "shared.one", name: "Hold Er", role: "member", password: "a-long-test-password-123" });
    await runStaffMatching(null);
    expect(getEmployee(holder.id)!.userId).toBe(u.id);

    const r = await confirmLink(other.id, "user_id", u.id, "Hermann");
    expect(r.ok).toBe(false);
    expect(getEmployee(other.id)!.userId).toBeNull();
  });
});
