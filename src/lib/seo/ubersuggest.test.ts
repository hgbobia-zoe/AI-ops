import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated throwaway DB. These tests exercise the HONEST health logic WITHOUT any network — probe() is
// never called here, so no live MCP request is made. (A real MCP call would need live OAuth credentials.)
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "aiops-seo-us-"));
  process.env.DATABASE_PATH = join(dir, "test.db");
  delete process.env.UBERSUGGEST_MCP_TOKEN;
  delete process.env.UBERSUGGEST_API_KEY;
});
afterEach(() => {
  delete process.env.UBERSUGGEST_MCP_TOKEN;
  delete process.env.UBERSUGGEST_API_KEY;
});
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

async function mod() {
  return import("./ubersuggest");
}
async function db() {
  return (await import("@/lib/db")).getDb();
}

describe("ubersuggest boundary — honest health (no network)", () => {
  it("reports not_configured with no credential, and makes no claim of a connection", async () => {
    const { configured, getHealth } = await mod();
    expect(configured()).toBe(false);
    const h = getHealth();
    expect(h.status).toBe("not_configured");
    expect(h.configured).toBe(false);
    expect(h.lastSuccessAt).toBeNull();
  });

  it("reports 'never' when a credential is set but nothing has been probed", async () => {
    process.env.UBERSUGGEST_MCP_TOKEN = "test-token";
    const { configured, getHealth } = await mod();
    expect(configured()).toBe(true);
    expect(getHealth().status).toBe("never");
  });

  it("reports ok after a successful retrieval and error after a failure", async () => {
    process.env.UBERSUGGEST_MCP_TOKEN = "test-token";
    const { getHealth } = await mod();
    const { recordRetrieval } = await import("./store");

    recordRetrieval({ operation: "probe", ok: true, durationMs: 100 });
    expect(getHealth().status).toBe("ok");

    recordRetrieval({ operation: "keyword_research", ok: false, detail: "HTTP 500" });
    const h = getHealth();
    expect(h.status).toBe("error");
    expect(h.lastError).toContain("500");
  });

  it("flags stale when the only successful retrieval is old", async () => {
    process.env.UBERSUGGEST_MCP_TOKEN = "test-token";
    const d = await db();
    d.exec("DELETE FROM seo_diagnostics");
    const old = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(); // 30 days ago
    d.prepare(
      "INSERT INTO seo_diagnostics (id, ts, operation, tool, ok, status_code, rate_limited, duration_ms, detail) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run("SEOD-old", old, "probe", null, 1, 200, 0, 50, null);

    const { getHealth } = await mod();
    const h = getHealth();
    expect(h.status).toBe("stale");
    expect(h.stale).toBe(true);
  });
});
