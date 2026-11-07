// Proves the Radar machine endpoints fail CLOSED: no token configured → 503, wrong or missing → 401,
// a token in the query string is ignored. None of them run a pull or store anything when refused.
import { afterEach, describe, expect, it, vi } from "vitest";

const runOpportunitySource = vi.fn();
vi.mock("@/lib/opportunity/ingest", () => ({ runOpportunitySource: (...a: unknown[]) => runOpportunitySource(...a) }));
const runSource = vi.fn();
vi.mock("@/lib/radar/ingest", () => ({ runSource: (...a: unknown[]) => runSource(...a) }));

import { POST as ingest } from "./ingest/route";
import { GET as cron } from "./cron/route";
import { GET as eventsPull } from "./events/pull/route";

afterEach(() => {
  delete process.env.RADAR_INGEST_TOKEN;
  runOpportunitySource.mockReset();
  runSource.mockReset();
});

const body = JSON.stringify({ sourceId: "moco-procurement", records: [{ name: "Tent rental" }] });
const post = (headers: Record<string, string> = {}, url = "https://zoe.test/api/radar/ingest") =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
const get = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

describe("radar machine endpoints", () => {
  it("refuse with 503 when RADAR_INGEST_TOKEN is not set", async () => {
    expect((await ingest(post({ "x-radar-token": "x" }))).status).toBe(503);
    expect((await cron(get("https://zoe.test/api/radar/cron"))).status).toBe(503);
    expect((await eventsPull(get("https://zoe.test/api/radar/events/pull"))).status).toBe(503);
    expect(runOpportunitySource).not.toHaveBeenCalled();
    expect(runSource).not.toHaveBeenCalled();
  });

  it("refuse with 401 for a wrong token or a query-string token", async () => {
    process.env.RADAR_INGEST_TOKEN = "right";
    expect((await ingest(post({ "x-radar-token": "wrong" }))).status).toBe(401);
    expect((await ingest(post({}, "https://zoe.test/api/radar/ingest?token=right"))).status).toBe(401);
    expect((await cron(get("https://zoe.test/api/radar/cron?token=right"))).status).toBe(401);
    expect((await eventsPull(get("https://zoe.test/api/radar/events/pull?token=right"))).status).toBe(401);
    expect(runOpportunitySource).not.toHaveBeenCalled();
  });

  it("accept the header token", async () => {
    process.env.RADAR_INGEST_TOKEN = "right";
    runOpportunitySource.mockResolvedValue({ sourceId: "moco-procurement", acquired: 1, stored: 1, duplicatesCollapsed: 0, changes: 0, alertsPosted: 0, errors: [] });
    const res = await ingest(post({ "x-radar-token": "right" }));
    expect(res.status).toBe(200);
    expect(runOpportunitySource).toHaveBeenCalledTimes(1);
    const c = await cron(get("https://zoe.test/api/radar/cron", { authorization: "Bearer right" }));
    expect(c.status).toBe(200);
  });

  it("answer CORS only for the Chrome extension origin", async () => {
    process.env.RADAR_INGEST_TOKEN = "right";
    const evil = await ingest(post({ origin: "https://evil.example", "x-radar-token": "wrong" }));
    expect(evil.headers.get("access-control-allow-origin")).toBe("null");
    const ext = await ingest(post({ origin: "chrome-extension://abc", "x-radar-token": "wrong" }));
    expect(ext.headers.get("access-control-allow-origin")).toBe("chrome-extension://abc");
  });
});
