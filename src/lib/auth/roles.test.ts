import { describe, it, expect } from "vitest";
import { canSeeFinancials, canManageSettings, canManageUsers, canManageRole, assignableRoles } from "./roles";

describe("access matrix", () => {
  it("only Owner + Admin see financials; Member never", () => {
    expect(canSeeFinancials("owner")).toBe(true);
    expect(canSeeFinancials("admin")).toBe(true);
    expect(canSeeFinancials("member")).toBe(false);
  });

  it("settings + user management: Owner/Admin yes, Member no", () => {
    for (const r of ["owner", "admin"] as const) {
      expect(canManageSettings(r)).toBe(true);
      expect(canManageUsers(r)).toBe(true);
    }
    expect(canManageSettings("member")).toBe(false);
    expect(canManageUsers("member")).toBe(false);
  });

  it("Owner manages everyone; Admin manages Members only; Member nobody", () => {
    expect(canManageRole("owner", "owner")).toBe(true);
    expect(canManageRole("owner", "admin")).toBe(true);
    expect(canManageRole("owner", "member")).toBe(true);
    expect(canManageRole("admin", "member")).toBe(true);
    expect(canManageRole("admin", "admin")).toBe(false); // can't touch peers
    expect(canManageRole("admin", "owner")).toBe(false); // can't touch owners
    expect(canManageRole("member", "member")).toBe(false);
  });

  it("assignable roles reflect the hierarchy", () => {
    expect(assignableRoles("owner")).toEqual(["owner", "admin", "member"]);
    expect(assignableRoles("admin")).toEqual(["member"]);
    expect(assignableRoles("member")).toEqual([]);
  });
});
