import { describe, it, expect } from "vitest";
import {
  canSeeFinancials,
  canManageSettings,
  canManageUsers,
  canManageRole,
  assignableRoles,
  canViewAi,
  canOperateAi,
  canApproveAi,
  canManageAi,
  aiCapabilityLevel,
} from "./roles";

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

  it("AI: any staff views + operates; only owner/admin approve + manage; guest none", () => {
    for (const r of ["owner", "admin", "member"] as const) {
      expect(canViewAi(r)).toBe(true);
      expect(canOperateAi(r)).toBe(true);
    }
    expect(canApproveAi("owner")).toBe(true);
    expect(canApproveAi("admin")).toBe(true);
    expect(canApproveAi("member")).toBe(false);
    expect(canManageAi("member")).toBe(false);

    // Guest (Shift Pass) has no AI access at any level.
    expect(canViewAi("guest")).toBe(false);
    expect(canOperateAi("guest")).toBe(false);
    expect(canApproveAi("guest")).toBe(false);
    expect(canManageAi("guest")).toBe(false);
  });

  it("AI capability level is the highest a role holds", () => {
    expect(aiCapabilityLevel("owner")).toBe("admin");
    expect(aiCapabilityLevel("admin")).toBe("admin");
    expect(aiCapabilityLevel("member")).toBe("operator");
    expect(aiCapabilityLevel("guest")).toBe("none");
  });
});
