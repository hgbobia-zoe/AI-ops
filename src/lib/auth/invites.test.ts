import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { createInvite, inviteState, acceptInvite, listPendingInvites, revokeInvite } from "./invites";
import { verifyLogin, usernameExists } from "./users";

beforeEach(() => {
  getDb().prepare("DELETE FROM invites").run();
  getDb().prepare("DELETE FROM users").run();
});

describe("invites", () => {
  it("mints a valid invite and accepting it creates a working account with the invite's role", () => {
    const inv = createInvite({ role: "member", name: "Pat Rep" });
    expect(inviteState(inv.token).state).toBe("valid");

    const res = acceptInvite(inv.token, { username: "pat", password: "supersecret" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.user.role).toBe("member");
      expect(res.user.name).toBe("Pat Rep");
    }
    // The account really works, and the invite is now consumed.
    expect(verifyLogin("pat", "supersecret")?.username).toBe("pat");
    expect(inviteState(inv.token).state).toBe("used");
  });

  it("is single-use — a second accept is rejected", () => {
    const inv = createInvite({ role: "admin" });
    expect(acceptInvite(inv.token, { username: "a", password: "password1" }).ok).toBe(true);
    const again = acceptInvite(inv.token, { username: "b", password: "password1" });
    expect(again).toEqual({ ok: false, error: "used" });
    expect(usernameExists("b")).toBe(false);
  });

  it("rejects a weak password and a taken username without consuming the invite", () => {
    createInvite({ role: "member" }); // occupy a username first
    acceptInvite(createInvite({ role: "member" }).token, { username: "taken", password: "password1" });

    const inv = createInvite({ role: "member" });
    expect(acceptInvite(inv.token, { username: "x", password: "short" })).toEqual({ ok: false, error: "weak_password" });
    expect(acceptInvite(inv.token, { username: "taken", password: "password1" })).toEqual({ ok: false, error: "username_taken" });
    expect(inviteState(inv.token).state).toBe("valid"); // still usable
  });

  it("treats an expired invite as expired", () => {
    const inv = createInvite({ role: "member" });
    getDb().prepare("UPDATE invites SET expires_at = ? WHERE token = ?").run(new Date(Date.now() - 1000).toISOString(), inv.token);
    expect(inviteState(inv.token).state).toBe("expired");
    expect(acceptInvite(inv.token, { username: "late", password: "password1" })).toEqual({ ok: false, error: "expired" });
  });

  it("lists pending invites and revokes them", () => {
    const a = createInvite({ role: "member" });
    createInvite({ role: "admin" });
    expect(listPendingInvites()).toHaveLength(2);
    expect(revokeInvite(a.token)).toBe(true);
    expect(listPendingInvites()).toHaveLength(1);
  });
});
