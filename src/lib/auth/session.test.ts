import { describe, it, expect } from "vitest";
import { signSession, verifySession } from "./session";

const SECRET = "unit-test-signing-secret";

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

describe("signed session — tamper-proof", () => {
  it("round-trips uid + role", async () => {
    const token = await signSession({ uid: "U1", role: "owner" }, SECRET);
    expect(await verifySession(token, SECRET)).toEqual({ uid: "U1", role: "owner" });
  });

  it("REJECTS a forged role (Member swaps payload to Owner, keeps the signature)", async () => {
    const token = await signSession({ uid: "U1", role: "member" }, SECRET);
    const sig = token.split(".")[1];
    const forged = `${b64url(JSON.stringify({ uid: "U1", role: "owner" }))}.${sig}`;
    expect(await verifySession(forged, SECRET)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signSession({ uid: "U1", role: "admin" }, SECRET);
    expect(await verifySession(token, "a-different-secret")).toBeNull();
  });

  it("rejects malformed / missing tokens", async () => {
    expect(await verifySession(undefined, SECRET)).toBeNull();
    expect(await verifySession("garbage", SECRET)).toBeNull();
    expect(await verifySession(".", SECRET)).toBeNull();
  });
});
