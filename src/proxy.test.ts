import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy, isHeadlessTokenPath, bridgeTokenOk } from "./proxy";
import { signSession } from "@/lib/auth/session";
import type { Role } from "@/lib/auth/roles";

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

/** Build a request carrying a VALID signed session cookie for `role`, so the role gates run. */
async function reqAs(role: Role, path: string): Promise<NextRequest> {
  const cookie = await signSession({ uid: `U-${role}`, role }, process.env.APP_SESSION_TOKEN!);
  const headers = new Headers();
  headers.set("cookie", `zoe_session=${cookie}`);
  return new NextRequest(new URL(`http://localhost${path}`), { headers });
}

describe("proxy — Gusto remote-browser push boundary", () => {
  it("lets the office RUNNER endpoints through without a session (token-checked in-handler)", async () => {
    // These fail-CLOSED on GUSTO_RUNNER_TOKEN inside the route; the proxy must not bounce them to auth, and
    // must NOT let the owner/admin /api/payroll gate catch them (the runner has no session).
    for (const p of [
      "/api/payroll/gusto/runner/next",
      "/api/payroll/gusto/runner/job",
      "/api/payroll/gusto/runner/update",
      "/api/payroll/gusto/runner/artifact",
      "/api/payroll/gusto/runner/input",
    ]) {
      const res = await proxy(reqFor(p));
      expect(res.status, `expected 200 (public) for ${p}`).toBe(200);
    }
  });

  it("keeps the CONSOLE (session) endpoints owner/admin only — a member is blocked", async () => {
    for (const p of ["/api/payroll/gusto/console", "/api/payroll/gusto/console/cancel", "/api/payroll/gusto/console/screenshot", "/api/payroll/gusto/console/input"]) {
      const res = await proxy(await reqAs("member", p));
      expect(res.status, `expected 403 for ${p}`).toBe(403);
    }
  });

  it("the console is NOT public — no session is a 401", async () => {
    const res = await proxy(reqFor("/api/payroll/gusto/console"));
    expect(res.status).toBe(401);
  });
});

describe("proxy — marketing role is scoped (deny-by-default)", () => {
  it("ALLOWS its whole demand-gen surface (Marketing+Creative, Radar, SEO, Website Studio) + their APIs", async () => {
    for (const p of [
      "/marketing", "/marketing/campaigns", "/marketing/reviews",
      "/creative", "/creative/dna", "/radar", "/radar/analytics", "/radar/capability",
      "/seo", "/seo/opportunities", "/seo/performance", "/website-studio",
      "/api/marketing/campaigns", "/api/creative/jobs", "/api/radar/source/run",
      "/api/opportunity/stage", "/api/pursuit/capability-profile", "/api/seo/discovery", "/api/website/jobs",
    ]) {
      const res = await proxy(await reqAs("marketing", p));
      expect(res.status, `expected 200 for ${p}`).toBe(200); // NextResponse.next()
    }
  });

  it("SEO Growth: owner + marketing reach it; a Member does NOT", async () => {
    expect((await proxy(await reqAs("owner", "/seo"))).status).toBe(200);
    expect((await proxy(await reqAs("marketing", "/seo"))).status).toBe(200);
    expect((await proxy(await reqAs("marketing", "/api/seo/discovery"))).status).toBe(200);
    // A Member never had SEO (it stayed owner/admin + marketing) — page bounces to "/", API is 403.
    const memPage = await proxy(await reqAs("member", "/seo"));
    expect(memPage.status).toBe(307);
    expect(new URL(memPage.headers.get("location")!).pathname).toBe("/");
    expect((await proxy(await reqAs("member", "/api/seo/discovery"))).status).toBe(403);
  });

  it("BLOCKS sensitive APIs with a 403 (money / payroll / people / AI sessions / dispatch)", async () => {
    for (const p of ["/api/finance/summary", "/api/payroll/overview", "/api/people/x", "/api/ai/sessions", "/api/scheduling/plan", "/api/settings/x"]) {
      const res = await proxy(await reqAs("marketing", p));
      expect(res.status, `expected 403 for ${p}`).toBe(403);
    }
  });

  it("BOUNCES every other console PAGE to /marketing (never loops through '/')", async () => {
    for (const p of ["/finance", "/admin", "/dispatch", "/payroll", "/scheduling", "/dashboard", "/ai-command", "/sales", "/customers"]) {
      const res = await proxy(await reqAs("marketing", p));
      expect(res.status, `expected redirect for ${p}`).toBe(307);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/marketing");
    }
  });

  it("a MEMBER (for contrast) still reaches dispatch but not finance", async () => {
    expect((await proxy(await reqAs("member", "/dispatch"))).status).toBe(200);
    // Member is blocked from finance (redirect to "/"), confirming the sensitive gates are intact.
    const fin = await proxy(await reqAs("member", "/finance"));
    expect(fin.status).toBe(307);
    expect(new URL(fin.headers.get("location")!).pathname).toBe("/");
  });
});
