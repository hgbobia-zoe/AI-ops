import { describe, it, expect } from "vitest";
import { deliveryPushDisplay, PUSH_SLOW_AFTER_SEC } from "./pushStatus";

describe("deliveryPushDisplay", () => {
  it("shows the fast-path spinner right after a push on the office machine", () => {
    const d = deliveryPushDisplay({ status: "pending", waitedSec: 2, extReachable: true });
    expect(d.kind).toBe("pushing");
    expect(d.tone).toBe("info");
    expect(d.showPushNow).toBe(false);
  });

  it("resolves to Pushed when the op lands", () => {
    const d = deliveryPushDisplay({ status: "done", waitedSec: 6, extReachable: true });
    expect(d.kind).toBe("done");
    expect(d.tone).toBe("ok");
    expect(d.showPushNow).toBe(false);
  });

  it("surfaces a failure with the error and offers a retry", () => {
    const d = deliveryPushDisplay({ status: "failed", waitedSec: 6, extReachable: true, error: "no_delivery_line" });
    expect(d.kind).toBe("failed");
    expect(d.tone).toBe("error");
    expect(d.text).toContain("no_delivery_line");
    expect(d.showPushNow).toBe(true);
  });

  it("is honest immediately when the extension isn't in this browser (off the office machine)", () => {
    const d = deliveryPushDisplay({ status: "pending", waitedSec: 1, extReachable: false });
    expect(d.kind).toBe("queued");
    expect(d.tone).toBe("attention");
    expect(d.text).toMatch(/office/i);
    expect(d.showPushNow).toBe(true);
  });

  it("flips from Pushing to an honest queued state after the slow threshold", () => {
    const before = deliveryPushDisplay({ status: "pending", waitedSec: PUSH_SLOW_AFTER_SEC - 1, extReachable: true });
    expect(before.kind).toBe("pushing");
    const after = deliveryPushDisplay({ status: "pending", waitedSec: PUSH_SLOW_AFTER_SEC + 1, extReachable: true });
    expect(after.kind).toBe("queued");
    expect(after.tone).toBe("attention");
    expect(after.showPushNow).toBe(true);
  });

  it("treats unknown (pre-first-poll, ext not yet known) as the fast path", () => {
    const d = deliveryPushDisplay({ status: "unknown", waitedSec: 1, extReachable: null });
    expect(d.kind).toBe("pushing");
  });
});
