import { describe, expect, it } from "vitest";
import { renderTemplate, defaultSettings, templateForKind } from "./settings";

describe("renderTemplate", () => {
  it("substitutes provided variables", () => {
    expect(renderTemplate("Hi {firstName} from {company}!", { firstName: "Dave", company: "Zoe" })).toBe(
      "Hi Dave from Zoe!",
    );
  });

  it("keeps the link line and fills it when a link is present", () => {
    const out = renderTemplate("Track here: {link}\nThanks", { link: "https://x.co/abc" });
    expect(out).toBe("Track here: https://x.co/abc\nThanks");
  });

  it("drops the whole line when the link is missing", () => {
    const out = renderTemplate("Hi {firstName}\n\nTrack here: {link}\n\nThanks", {
      firstName: "Dave",
      link: undefined,
    });
    expect(out).toBe("Hi Dave\n\nThanks");
  });

  it("ships distinct pickup templates that say 'pick up'", () => {
    const t = defaultSettings().templates;
    expect(t.onWayPickup).toMatch(/pick up/i);
    expect(t.arrivedPickup).toMatch(/pick up/i);
    expect(t.onWayPickup).not.toBe(t.onWay);
  });

  it("templateForKind selects the pickup set only for pickup stops", () => {
    const t = defaultSettings().templates;
    expect(templateForKind(t, "pickup", "onWay")).toBe(t.onWayPickup);
    expect(templateForKind(t, "delivery", "onWay")).toBe(t.onWay);
    expect(templateForKind(t, undefined, "onWay")).toBe(t.onWay); // default = delivery
    expect(templateForKind(t, "pickup", "coordinatorArrived")).toBe(t.coordinatorArrivedPickup);
  });

  it("renders the default on-way template with no link cleanly", () => {
    const out = renderTemplate(defaultSettings().templates.onWay, {
      firstName: "Dave",
      company: "Zoe Events",
      link: undefined,
    });
    expect(out).toContain("Hi Dave,");
    expect(out).not.toContain("{link}");
    expect(out).not.toContain("latest location");
    expect(out.trimEnd().endsWith("Thank you!")).toBe(true);
  });
});
