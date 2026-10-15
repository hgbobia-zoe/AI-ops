import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy, isHeadlessTokenPath, bridgeTokenOk } from "./proxy";

beforeEach(() => {
  process.env.APP_SESSION_TOKEN = "sess-secret"; // auth ON (the gate is active)
  process.env.AI_BRIDGE_TOKEN = "bridge-secret";
});
afterEach(() => {
  delete process.env.APP_SESSION_TOKEN;
  delete process.env.AI_BRIDGE_TOKEN;
});

describe("isHeadlessTokenPath (pure)", () => {
  it("matches the bridge + improvement endpoints, nothing else", () => {
    expect(isHeadlessTokenPath("/api/ai/bridge")).toBe(true);
    expect(isHeadlessTokenPath("/api/ai/bridge/pending")).toBe(true);
    expect(isHeadlessTokenPath("/api/ai/improvement")).toBe(true);
    expect(isHeadlessTokenPath("/api/ai/improvement/IR-1/report")).toBe(true);
    expect(isHeadlessTokenPath("/api/ai/propose")).toBe(true);
    // The responder files + manages backlog requests here (a tracked record, never an execution).
    expect(isHeadlessTokenPath("/api/ai/requests")).toBe(true);
    expect(isHeadlessTokenPath("/api/ai/requests/manage")).toBe(true);
    // Only the exact propose path — the responder can't reach anything else under /api/ai via the token.
    expect(isHeadlessTokenPath("/api/ai/propose/x")).toBe(false);
    expect(isHeadlessTokenPath("/api/ai/approvals")).toBe(false);
    expect(isHeadlessTokenPath("/api/ai/sessions")).toBe(false);
    expect(isHeadlessTokenPath("/api/ai/config")).toBe(false);
  });
});

describe("bridgeTokenOk (pure)", () => {
  it("accepts only an exact, non-empty match of AI_BRIDGE_TOKEN", () => {
    expect(bridgeTokenOk("bridge-secret")).toBe(true);
    expect(bridgeTokenOk("nope")).toBe(false);
    expect(bridgeTokenOk("")).toBe(false);
    expect(bridgeTokenOk(null)).toBe(false);
  });
  it("is false when the app has no bridge token set", () => {
    delete process.env.AI_BRIDGE_TOKEN;
    expect(bridgeTokenOk("anything")).toBe(false);
  });
});

function reqFor(path: string, token?: string): NextRequest {
  const headers = new Headers();
  if (token) headers.set("x-bridge-token", token);
  return new NextRequest(new URL(`http://localhost${path}`), { headers });
}

describe("proxy — headless bridge token", () => {
  it("lets a VALID token reach /api/ai/bridge (route then checks it)", async () => {
    const res = await proxy(reqFor("/api/ai/bridge", "bridge-secret"));
    expect(res.status).toBe(200); // NextResponse.next()
  });

  it("lets a VALID token reach the improvement report endpoint", async () => {
    const res = await proxy(reqFor("/api/ai/improvement/IR-x/report", "bridge-secret"));
    expect(res.status).toBe(200);
  });

  it("rejects /api/ai/bridge with NO token (no cookie) as 401", async () => {
    const res = await proxy(reqFor("/api/ai/bridge"));
    expect(res.status).toBe(401);
  });

  it("rejects /api/ai/bridge with a WRONG token as 401", async () => {
    const res = await proxy(reqFor("/api/ai/bridge", "wrong"));
    expect(res.status).toBe(401);
  });

  it("lets a VALID token reach /api/ai/propose (route then checks it)", async () => {
    const res = await proxy(reqFor("/api/ai/propose", "bridge-secret"));
    expect(res.status).toBe(200);
  });

  it("rejects /api/ai/propose with NO token (no cookie) as 401", async () => {
    const res = await proxy(reqFor("/api/ai/propose"));
    expect(res.status).toBe(401);
  });

  it("does NOT let the token bypass the gate on an unrelated AI settings route", async () => {
    // /api/ai/approvals is not a headless-token path — a token-only request still needs a cookie.
    const res = await proxy(reqFor("/api/ai/approvals", "bridge-secret"));
    expect(res.status).toBe(401);
  });
});
