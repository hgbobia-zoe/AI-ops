import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, unknown>();
vi.mock("@/lib/kv", () => ({
  getJson: (k: string, d: unknown) => (store.has(k) ? store.get(k) : d),
  setJson: (k: string, v: unknown) => void store.set(k, v),
}));
vi.mock("@/lib/pull/state", () => ({ logImport: vi.fn() }));
vi.mock("@/lib/db/repo", () => ({ insertAudit: vi.fn() }));

import { POST } from "./route";
import { readContractorRun } from "@/lib/payroll/gustoContractorState";

const PG = "contractor_adhoc.87437f30-0c73-41f1-b3a7-5babf47bf7a4.0f54fff7-8964-4233-9986-79d350ca3c06";
const call = (body: unknown) =>
  POST(new Request("http://x/api/payroll/gusto/contractor-result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

describe("POST /api/payroll/gusto/contractor-result", () => {
  beforeEach(() => {
    store.clear();
    delete process.env.GS_INGEST_TOKEN;
  });

  it("records a staged + reviewed run with Gusto's debits and the review link", async () => {
    const r = await call({
      payGroupId: PG, reviewOk: true, totalDebit: 127, achSpeed: "four_day_ach", periodStart: "2026-10-26", periodEnd: "2026-11-01",
      members: [
        { key: "ct:1", name: "Mayerlin Alvarado Montegut", memberUuid: "u1", hours: 1.5, matchedBy: "id", outcome: "staged", debit: 27 },
        { key: "ct:2", name: "Raquel", outcome: "unmatched", hours: 4 },
        { name: "junk", outcome: "paid" },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("https://app.gusto.com");
    const run = readContractorRun()!;
    expect(run.stage).toBe("staged");
    expect(run.ok).toBe(true);
    expect(run.totalDebit).toBe(127);
    expect(run.reviewUrl).toContain(`/pay/contractors/ad-hoc/${PG}/review`);
    expect(run.members.map((m) => m.outcome)).toEqual(["staged", "unmatched"]); // unknown outcomes dropped
  });

  it("records Gusto's review errors honestly (never a false 'staged')", async () => {
    await call({ payGroupId: PG, reviewOk: false, reviewErrors: ["Payments in PHP need a transfer purpose"], members: [] });
    const run = readContractorRun()!;
    expect(run.stage).toBe("review_failed");
    expect(run.ok).toBe(false);
    expect(run.reviewErrors).toEqual(["Payments in PHP need a transfer purpose"]);
  });

  it("records an abort (signed out) and rejects a bad token when one is set", async () => {
    await call({ aborted: "not_logged_in" });
    expect(readContractorRun()!.stage).toBe("aborted");
    process.env.GS_INGEST_TOKEN = "t";
    expect((await call({ reviewOk: true })).status).toBe(401);
  });
});
