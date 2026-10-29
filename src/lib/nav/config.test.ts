import { describe, it, expect } from "vitest";
import {
  NAV_GROUPS, buildAdminGroup, bladeVisible, visibleGroups, visibleHubs, showsPrimaryAction,
  isHrefActive, isBladeActive, groupIsActive, activeGroupLabel, activeBlade, breadcrumbTrail,
  type Blade, type NavGroup,
} from "@/lib/nav/config";

const groupByLabel = (groups: NavGroup[], label: string) => groups.find((g) => g.label === label);
const hrefs = (groups: NavGroup[]) => groups.flatMap((g) => g.blades.map((b) => b.href));

describe("active / ancestor resolution", () => {
  it("isHrefActive matches exact and sub-paths, not siblings", () => {
    expect(isHrefActive("/radar", "/radar")).toBe(true);
    expect(isHrefActive("/radar", "/radar/outreach")).toBe(true);
    expect(isHrefActive("/radar", "/radar-extra")).toBe(false); // not a sub-path
    expect(isHrefActive("/radar", "/dispatch")).toBe(false);
  });

  it("exact blades highlight only on their own path; non-exact match sub-paths", () => {
    const exactLanding: Blade = { href: "/radar", label: "Overview", icon: NAV_GROUPS[0].icon, exact: true };
    const normal: Blade = { href: "/radar/outreach", label: "Outreach", icon: NAV_GROUPS[0].icon };
    expect(isBladeActive(exactLanding, "/radar")).toBe(true);
    expect(isBladeActive(exactLanding, "/radar/outreach")).toBe(false); // exact: not active for a child
    expect(isBladeActive(normal, "/radar/outreach")).toBe(true);
    expect(isBladeActive(normal, "/radar/outreach/123")).toBe(true);
  });

  it("the group owning the current path is the active ancestor (even for an exact landing child)", () => {
    const groups = visibleGroups("owner");
    expect(activeGroupLabel(groups, "/radar/outreach")).toBe("Opportunity Radar");
    expect(activeGroupLabel(groups, "/radar")).toBe("Opportunity Radar");
    expect(activeGroupLabel(groups, "/dispatch")).toBe("Operations");
    expect(activeGroupLabel(groups, "/nowhere")).toBeUndefined();
  });

  it("groupIsActive ignores the exact flag so a sub-path still activates the ancestor", () => {
    const radar = groupByLabel(visibleGroups("owner"), "Opportunity Radar")!;
    expect(groupIsActive(radar, "/radar/import")).toBe(true);
  });

  it("activeBlade picks the deepest (longest-href) match", () => {
    const groups = visibleGroups("owner");
    expect(activeBlade(groups, "/salesos/outreach")?.href).toBe("/salesos/outreach");
    // A path under /salesos that is not its own blade falls back to the /salesos blade.
    expect(activeBlade(groups, "/salesos/board")?.href).toBe("/salesos");
  });
});

describe("permission filtering", () => {
  it("owner sees every group incl. Admin and both hubs", () => {
    const groups = visibleGroups("owner");
    expect(groupByLabel(groups, "Admin")).toBeTruthy();
    expect(groupByLabel(groups, "AI Org")).toBeTruthy();
    expect(visibleHubs("owner").map((h) => h.href)).toEqual(["/dashboard", "/ai-command"]);
    expect(showsPrimaryAction("owner")).toBe(true);
  });

  it("member cannot see financial / coaching / seo / manage blades or Admin", () => {
    expect(bladeVisible({ href: "/finance", label: "x", icon: NAV_GROUPS[0].icon, financial: true }, "member")).toBe(false);
    expect(bladeVisible({ href: "/coaching", label: "x", icon: NAV_GROUPS[0].icon, coaching: true }, "member")).toBe(false);
    expect(bladeVisible({ href: "/seo", label: "x", icon: NAV_GROUPS[0].icon, seo: true }, "member")).toBe(false);
    expect(bladeVisible({ href: "/events", label: "x", icon: NAV_GROUPS[0].icon, manage: true }, "member")).toBe(false);
    const groups = visibleGroups("member");
    expect(groupByLabel(groups, "Admin")).toBeUndefined();
    expect(groupByLabel(groups, "AI Org")).toBeUndefined(); // all blades are manage-gated
    expect(hrefs(groups)).not.toContain("/finance");
    expect(hrefs(groups)).not.toContain("/payroll");
    // Member CAN still use Website Studio (no flag) even though the rest of SEO is hidden.
    expect(hrefs(groups)).toContain("/website-studio");
    expect(hrefs(groups)).not.toContain("/seo");
  });

  it("the scoped marketing role sees ONLY its demand-gen surface, with carve-outs hidden", () => {
    const groups = visibleGroups("marketing");
    const seen = hrefs(groups);
    // Allowed surface
    expect(seen).toContain("/marketing");
    expect(seen).toContain("/creative");
    expect(seen).toContain("/radar");
    expect(seen).toContain("/seo");
    expect(seen).toContain("/website-studio");
    // Carve-outs stay owner/admin even inside an allowed prefix
    expect(seen).not.toContain("/radar/capability");
    expect(seen).not.toContain("/creative/dna");
    // Nothing from the operational / financial / admin surface
    expect(seen).not.toContain("/dispatch");
    expect(seen).not.toContain("/finance");
    expect(groupByLabel(groups, "Operations")).toBeUndefined();
    expect(groupByLabel(groups, "Admin")).toBeUndefined();
    // No hubs, no primary action for marketing
    expect(visibleHubs("marketing")).toEqual([]);
    expect(showsPrimaryAction("marketing")).toBe(false);
  });

  it("admin can manage users (Team) but buildAdminGroup is null for non-managers", () => {
    expect(buildAdminGroup("admin")?.blades.map((b) => b.href)).toContain("/admin/users");
    expect(buildAdminGroup("member")).toBeNull();
    expect(buildAdminGroup("marketing")).toBeNull();
    expect(buildAdminGroup("guest")).toBeNull();
  });

  it("every visible blade is reachable by the marketing proxy allow-list (no nav/proxy drift)", () => {
    // Nav must never surface a destination the proxy would hard-deny for marketing.
    for (const href of hrefs(visibleGroups("marketing"))) {
      // website-studio + the marketing surface are all allowed; this is a guard against future edits.
      expect(href.startsWith("/marketing") || href.startsWith("/creative") || href.startsWith("/radar") || href.startsWith("/seo") || href.startsWith("/website-studio")).toBe(true);
    }
  });
});

describe("breadcrumb trail", () => {
  it("renders a single crumb for a hub", () => {
    expect(breadcrumbTrail("/dashboard", "owner")).toEqual([{ label: "Command Center", href: "/dashboard" }]);
    expect(breadcrumbTrail("/ai-command", "owner")).toEqual([{ label: "AI Command Center", href: "/ai-command" }]);
  });

  it("links the group to its exact landing page, then the current blade (inert)", () => {
    expect(breadcrumbTrail("/radar/outreach", "owner")).toEqual([
      { label: "Opportunity Radar", href: "/radar" },
      { label: "Outreach" },
    ]);
  });

  it("uses an inert group label when the group has no exact landing page", () => {
    expect(breadcrumbTrail("/sales", "owner")).toEqual([
      { label: "Sales" },
      { label: "Sales Intelligence" },
    ]);
  });

  it("appends a local-view crumb for a sub-path under a blade", () => {
    expect(breadcrumbTrail("/salesos/board", "owner")).toEqual([
      { label: "Sales" },
      { label: "Sales OS", href: "/salesos" },
      { label: "Board" },
    ]);
  });

  it("on an exact landing page the group label is inert and the blade is current", () => {
    expect(breadcrumbTrail("/radar", "owner")).toEqual([
      { label: "Opportunity Radar" },
      { label: "Overview" },
    ]);
  });

  it("resolves against role visibility and falls back to titleized segments for unknown paths", () => {
    const trail = breadcrumbTrail("/some/deep/thing", "owner");
    expect(trail[trail.length - 1]).toEqual({ label: "Thing" });
    expect(trail[0]).toEqual({ label: "Some", href: "/some" });
  });
});
