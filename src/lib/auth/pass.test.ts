import { describe, expect, it } from "vitest";
import { signSession, verifySession } from "./session";
import { passStatus, isPassLive, passSession, passIdFromUid, newPassToken } from "./pass";
import type { ShiftPass } from "@/lib/db/repo";

const SECRET = "test-signing-secret";
const base = (over: Partial<ShiftPass> = {}): ShiftPass => ({
  id: "tok123",
  name: "Marcus Bell",
  phone: null,
  scope: "drive",
  createdBy: "Owner",
  createdAt: "2027-01-01T00:00:00.000Z",
  expiresAt: "2999-01-01T00:00:00.000Z",
  revokedAt: null,
  lastSeenAt: null,
  ...over,
});

describe("passStatus / isPassLive", () => {
  it("is active before expiry when not revoked", () => {
    expect(passStatus(base())).toBe("active");
    expect(isPassLive(base())).toBe(true);
  });
  it("is expired once past expiresAt", () => {
    const p = base({ expiresAt: "2000-01-01T00:00:00.000Z" });
    expect(passStatus(p)).toBe("expired");
    expect(isPassLive(p)).toBe(false);
  });
  it("revoked beats not-yet-expired", () => {
    const p = base({ revokedAt: "2027-06-01T00:00:00.000Z" });
    expect(passStatus(p)).toBe("revoked");
    expect(isPassLive(p)).toBe(false);
  });
  it("treats a null pass as not live", () => {
    expect(isPassLive(null)).toBe(false);
  });
});

describe("passSession / passIdFromUid", () => {
  it("mints a guest session whose exp mirrors the pass expiry", () => {
    const p = base({ expiresAt: "2027-01-01T10:00:00.000Z" });
    const s = passSession(p);
    expect(s.role).toBe("guest");
    expect(s.uid).toBe("pass:tok123");
    expect(s.name).toBe("Marcus Bell");
    expect(s.exp).toBe(Math.floor(Date.parse(p.expiresAt) / 1000));
  });
  it("round-trips the pass id out of the session uid", () => {
    expect(passIdFromUid("pass:tok123")).toBe("tok123");
    expect(passIdFromUid("u_realuser")).toBeNull();
    expect(passIdFromUid(undefined)).toBeNull();
  });
  it("mints unguessable, distinct tokens", () => {
    const a = newPassToken();
    const b = newPassToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(20);
  });
});

describe("signed guest session expiry (the security guarantee)", () => {
  it("verifies a live guest cookie and preserves role/name/exp", async () => {
    const p = base({ expiresAt: "2999-01-01T00:00:00.000Z" });
    const cookie = await signSession(passSession(p), SECRET);
    const back = await verifySession(cookie, SECRET);
    expect(back?.role).toBe("guest");
    expect(back?.name).toBe("Marcus Bell");
  });
  it("rejects a validly-signed cookie whose exp has passed", async () => {
    const cookie = await signSession(passSession(base({ expiresAt: "2000-01-01T00:00:00.000Z" })), SECRET);
    expect(await verifySession(cookie, SECRET)).toBeNull();
  });
  it("rejects a tampered payload", async () => {
    const cookie = await signSession(passSession(base()), SECRET);
    const tampered = cookie.replace(/^[^.]+/, (p) => p.slice(0, -1) + (p.slice(-1) === "A" ? "B" : "A"));
    expect(await verifySession(tampered, SECRET)).toBeNull();
  });
  it("still verifies a staff cookie with no exp (back-compat)", async () => {
    const cookie = await signSession({ uid: "u_owner", role: "owner" }, SECRET);
    const back = await verifySession(cookie, SECRET);
    expect(back?.role).toBe("owner");
    expect(back?.exp).toBeUndefined();
  });
});
