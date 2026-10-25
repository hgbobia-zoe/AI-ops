// Website Studio jobs API — the browse-and-edit upgrade contract: POST accepts + validates + persists the
// edit context (contextUrl + environment) and threads it onto the created job. Uses the real in-memory DB;
// only the session accessor is stubbed so we can flip the viewer's role (RBAC gate: canUseWebsiteStudio).
import { describe, it, expect, beforeEach, vi } from "vitest";

const mockRole = { value: "member" as "owner" | "admin" | "member" | "guest" };
vi.mock("@/lib/auth/getSession", () => ({
  viewerRole: async () => mockRole.value,
  currentActor: async () => ({ id: "u1", label: "Marcy (Marketing)" }),
}));

import { GET, POST } from "./route";
import { getDb } from "@/lib/db";
import { listJobs } from "@/lib/website/jobs";

const postReq = (body: unknown): Request =>
  new Request("http://localhost/api/website/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  mockRole.value = "member";
  getDb().prepare("DELETE FROM website_jobs").run();
});

describe("/api/website/jobs — RBAC", () => {
  it("blocks a guest on GET and POST (403)", async () => {
    mockRole.value = "guest";
    expect((await GET()).status).toBe(403);
    expect((await POST(postReq({ prompt: "x" }))).status).toBe(403);
    expect(listJobs()).toHaveLength(0);
  });
});

describe("/api/website/jobs — edit context", () => {
  it("persists contextUrl + environment onto the queued job", async () => {
    const res = await POST(postReq({
      prompt: "Change this headline to Fall Sale",
      contextUrl: "https://zoeeventsdmv.com/about",
      environment: "local",
    }));
    expect(res.status).toBe(200);
    const { job } = (await res.json()) as { job: { id: string; contextUrl: string | null; environment: string; requester: string | null } };
    expect(job.contextUrl).toBe("https://zoeeventsdmv.com/about");
    expect(job.environment).toBe("local");
    expect(job.requester).toBe("Marcy (Marketing)");

    // And it's actually in the store for the runner to claim.
    const stored = listJobs()[0];
    expect(stored.contextUrl).toBe("https://zoeeventsdmv.com/about");
    expect(stored.environment).toBe("local");
  });

  it("defaults environment to production and contextUrl to null when omitted", async () => {
    const res = await POST(postReq({ prompt: "Make the button gold" }));
    expect(res.status).toBe(200);
    const { job } = (await res.json()) as { job: { contextUrl: string | null; environment: string } };
    expect(job.environment).toBe("production");
    expect(job.contextUrl).toBeNull();
  });

  it("coerces an invalid environment to production (never fails the submit on it)", async () => {
    const res = await POST(postReq({ prompt: "x", environment: "staging-typo", contextUrl: "/pricing" }));
    expect(res.status).toBe(200);
    const { job } = (await res.json()) as { job: { contextUrl: string | null; environment: string } };
    expect(job.environment).toBe("production");
    expect(job.contextUrl).toBe("/pricing");
  });

  it("rejects an empty prompt (400) and an over-long contextUrl (400)", async () => {
    expect((await POST(postReq({ prompt: "   " }))).status).toBe(400);
    expect((await POST(postReq({ prompt: "ok", contextUrl: "x".repeat(2001) }))).status).toBe(400);
  });
});
