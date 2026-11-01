import { describe, expect, it } from "vitest";
import { buildOfficePullScript } from "./gsPull";

describe("office pull bookmarklet: create claim", () => {
  const src = buildOfficePullScript("https://zoe-dispatch.fly.dev");

  it("is valid JavaScript", () => {
    const body = src.replace(/^javascript:/, "");
    expect(() => new Function(decodeURIComponent(body))).not.toThrow();
  });

  it("claims a create op before opening the createNewProject popup", () => {
    const claimAt = src.indexOf("claim:true");
    const openAt = src.indexOf('window.open("/app/project/createNewProject"');
    expect(claimAt).toBeGreaterThan(-1);
    expect(openAt).toBeGreaterThan(claimAt);
    expect(src).toContain("cj.claimed===true");
  });

  it("only claims on a real click (a timer cycle can't open the popup)", () => {
    expect(src).toContain("navigator.userActivation.isActive");
    expect(src).toContain("(createOps.length && activeClick)");
  });
});
