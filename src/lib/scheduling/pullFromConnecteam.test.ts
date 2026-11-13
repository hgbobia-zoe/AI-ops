import { describe, expect, it, vi } from "vitest";
import { pullFromConnecteam, type PullDeps } from "./pullFromConnecteam";
import type { StaffShift } from "./types";

const shift = (p: Partial<StaffShift> = {}): StaffShift =>
  ({ id: "S1", date: "2026-11-17", role: "prep", status: "sent", assignees: [11], connecteamShiftId: "6af6:abc", connecteamSchedulerId: 11594873, ...p }) as StaffShift;

function deps(result: { ok: boolean; gone?: boolean; error?: string } = { ok: true }): PullDeps & { deleteShift: ReturnType<typeof vi.fn> } {
  return { deleteShift: vi.fn(async () => result), defaultSchedulerId: async () => 999 };
}

describe("cancelled shifts are pulled from Connecteam (owner rule 2026-11-13)", () => {
  it("takes the Connecteam copy down on its own scheduler", async () => {
    const d = deps();
    expect(await pullFromConnecteam(shift(), [shift()], d)).toEqual({ ok: true, removed: true, reason: "removed" });
    expect(d.deleteShift).toHaveBeenCalledWith({ schedulerId: 11594873, shiftId: "6af6:abc" });
  });

  it("a shift that was never in Connecteam is just cancelled here", async () => {
    const d = deps();
    expect(await pullFromConnecteam(shift({ connecteamShiftId: null }), [], d)).toEqual({ ok: true, removed: false, reason: "not_in_connecteam" });
    expect(d.deleteShift).not.toHaveBeenCalled();
  });

  it("already gone in Connecteam counts as done", async () => {
    expect(await pullFromConnecteam(shift(), [], deps({ ok: true, gone: true }))).toEqual({ ok: true, removed: true, reason: "already_gone" });
  });

  it("a Connecteam failure stops the cancel, so the two never drift apart", async () => {
    const r = await pullFromConnecteam(shift(), [], deps({ ok: false, error: "Connecteam HTTP 500" }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("Nothing was cancelled");
  });

  it("never deletes a Connecteam shift another live Dispatch shift still uses", async () => {
    const d = deps();
    const other = shift({ id: "S2" });
    expect(await pullFromConnecteam(shift(), [shift(), other], d)).toEqual({ ok: true, removed: false, reason: "shared" });
    expect(d.deleteShift).not.toHaveBeenCalled();
    // A cancelled sibling does not count as a user.
    expect((await pullFromConnecteam(shift(), [shift({ id: "S2", status: "cancelled" })], d)).ok).toBe(true);
    expect(d.deleteShift).toHaveBeenCalledTimes(1);
  });

  it("falls back to the default scheduler, and refuses honestly when none is reachable", async () => {
    const d = deps();
    await pullFromConnecteam(shift({ connecteamSchedulerId: null }), [], d);
    expect(d.deleteShift).toHaveBeenCalledWith({ schedulerId: 999, shiftId: "6af6:abc" });
    const none: PullDeps = { deleteShift: vi.fn(), defaultSchedulerId: async () => null };
    expect((await pullFromConnecteam(shift({ connecteamSchedulerId: null }), [], none)).ok).toBe(false);
  });
});
