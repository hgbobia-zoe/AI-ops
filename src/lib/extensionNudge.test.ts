import { afterEach, describe, expect, it, vi } from "vitest";
import { nudgeCreateNow, nudgeDrainNow } from "./extensionNudge";

// The helper reads window.chrome.runtime.sendMessage. In the node test env `window` is undefined, which is
// the real "not a browser / extension absent" path; we also simulate a Chrome with the extension present.
const g = globalThis as unknown as { window?: unknown };

afterEach(() => {
  delete g.window;
  vi.useRealTimers();
});

describe("nudgeCreateNow", () => {
  it("resolves false when not in a browser (no window.chrome)", async () => {
    await expect(nudgeCreateNow()).resolves.toBe(false);
  });

  it("resolves false when the extension is absent (chrome.runtime missing)", async () => {
    g.window = { chrome: {} };
    await expect(nudgeCreateNow()).resolves.toBe(false);
  });

  it("sends zoe-create-now and resolves true when the extension acks ok", async () => {
    const sendMessage = vi.fn((_id: string, _msg: unknown, cb: (r: unknown) => void) => cb({ ok: true, createDrainEnabled: true }));
    g.window = { chrome: { runtime: { sendMessage } } };
    await expect(nudgeCreateNow()).resolves.toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(expect.any(String), { type: "zoe-create-now" }, expect.any(Function));
  });

  it("resolves false when the extension replies without ok", async () => {
    const sendMessage = vi.fn((_id: string, _msg: unknown, cb: (r: unknown) => void) => cb(undefined));
    g.window = { chrome: { runtime: { sendMessage } } };
    await expect(nudgeCreateNow()).resolves.toBe(false);
  });

  it("does not hang when the callback never fires (times out to false)", async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn(() => {}); // extension-shaped API but no callback ever invoked
    g.window = { chrome: { runtime: { sendMessage } } };
    const p = nudgeCreateNow();
    await vi.advanceTimersByTimeAsync(1600);
    await expect(p).resolves.toBe(false);
  });
});

describe("nudgeDrainNow", () => {
  it("resolves false when not in a browser (no window.chrome)", async () => {
    await expect(nudgeDrainNow()).resolves.toBe(false);
  });

  it("resolves false when the extension is absent (chrome.runtime missing)", async () => {
    g.window = { chrome: {} };
    await expect(nudgeDrainNow()).resolves.toBe(false);
  });

  it("sends zoe-drain-now and resolves true when the extension acks ok", async () => {
    const sendMessage = vi.fn((_id: string, _msg: unknown, cb: (r: unknown) => void) => cb({ ok: true, enabled: true, pending: 1 }));
    g.window = { chrome: { runtime: { sendMessage } } };
    await expect(nudgeDrainNow()).resolves.toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(expect.any(String), { type: "zoe-drain-now" }, expect.any(Function));
  });

  it("resolves false when the extension replies without ok", async () => {
    const sendMessage = vi.fn((_id: string, _msg: unknown, cb: (r: unknown) => void) => cb(undefined));
    g.window = { chrome: { runtime: { sendMessage } } };
    await expect(nudgeDrainNow()).resolves.toBe(false);
  });

  it("does not hang when the callback never fires (times out to false)", async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn(() => {}); // extension-shaped API but no callback ever invoked
    g.window = { chrome: { runtime: { sendMessage } } };
    const p = nudgeDrainNow();
    await vi.advanceTimersByTimeAsync(1600);
    await expect(p).resolves.toBe(false);
  });
});
