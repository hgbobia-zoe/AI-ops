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
  canUseWebsiteStudio,
  canSeeMarketing,
  canSeeCoaching,
  canManagePayroll,
  marketingCanReachPage,
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
    expect(assignableRoles("owner")).toEqual(["owner", "admin", "member", "marketing"]);
    expect(assignableRoles("admin")).toEqual(["member", "marketing"]);
    expect(assignableRoles("member")).toEqual([]);
    expect(assignableRoles("marketing")).toEqual([]);
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

  it("Website Studio: any staff + marketing may submit a change request; guest never", () => {
    expect(canUseWebsiteStudio("owner")).toBe(true);
    expect(canUseWebsiteStudio("admin")).toBe(true);
    expect(canUseWebsiteStudio("member")).toBe(true);
    expect(canUseWebsiteStudio("marketing")).toBe(true);
    expect(canUseWebsiteStudio("guest")).toBe(false);
  });
});

describe("marketing role — scoped, deny-by-default", () => {
  it("reaches ONLY Website Studio + the Marketing blade", () => {
    expect(canUseWebsiteStudio("marketing")).toBe(true);
    expect(canSeeMarketing("marketing")).toBe(true);
  });

  it("is DENIED every money / settings / users / payroll / coaching / AI capability", () => {
    expect(canSeeFinancials("marketing")).toBe(false);
    expect(canManageSettings("marketing")).toBe(false);
    expect(canManageUsers("marketing")).toBe(false);
    expect(canManagePayroll("marketing")).toBe(false);
    expect(canSeeCoaching("marketing")).toBe(false);
    expect(canApproveAi("marketing")).toBe(false);
    expect(canManageAi("marketing")).toBe(false);
    // Marketing is NOT ops staff: even the member-level AI view/operate gates are false.
    expect(canViewAi("marketing")).toBe(false);
    expect(canOperateAi("marketing")).toBe(false);
    expect(aiCapabilityLevel("marketing")).toBe("none");
  });

  it("canSeeMarketing is true for all back-office staff + marketing, false for guest", () => {
    for (const r of ["owner", "admin", "member", "marketing"] as const) expect(canSeeMarketing(r)).toBe(true);
    expect(canSeeMarketing("guest")).toBe(false);
  });

  it("owner + admin can assign/manage marketing; marketing manages nobody; nobody escalates", () => {
    expect(canManageRole("owner", "marketing")).toBe(true);
    expect(canManageRole("admin", "marketing")).toBe(true);
    expect(canManageRole("marketing", "member")).toBe(false);
    expect(canManageRole("marketing", "marketing")).toBe(false);
    expect(assignableRoles("owner")).toContain("marketing");
    expect(assignableRoles("admin")).toContain("marketing");
  });

  it("marketingCanReachPage allows only /marketing* and /website-studio*", () => {
    expect(marketingCanReachPage("/marketing")).toBe(true);
    expect(marketingCanReachPage("/marketing/campaigns")).toBe(true);
    expect(marketingCanReachPage("/website-studio")).toBe(true);
    expect(marketingCanReachPage("/website-studio/anything")).toBe(true);
    expect(marketingCanReachPage("/finance")).toBe(false);
    expect(marketingCanReachPage("/dispatch")).toBe(false);
    expect(marketingCanReachPage("/admin")).toBe(false);
    expect(marketingCanReachPage("/marketingx")).toBe(false); // not a sub-path of /marketing
  });
});
