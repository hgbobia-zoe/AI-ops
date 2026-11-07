import { describe, expect, it } from "vitest";
import { acquireSamIncremental, isRelevantNotice, mapNotice, noticeStatus, type SamNotice } from "./samgov";

// Made-up notices in the SAM v2 shape.
const tentNotice: SamNotice = {
  noticeId: "N1",
  title: "Tent and chair rental for change of command ceremony",
  solicitationNumber: "W91-26-Q-0001",
  fullParentPathName: "DEPT OF DEFENSE.DEPT OF THE ARMY",
  type: "Combined Synopsis/Solicitation",
  active: "Yes",
  postedDate: "2026-11-01",
  responseDeadLine: "2026-11-20T17:00:00-05:00",
  naicsCode: "532289",
  uiLink: "https://sam.gov/opp/N1/view",
  description: "https://api.sam.gov/prod/opportunities/v1/noticedesc?noticeid=N1",
  placeOfPerformance: { city: { name: "Fort Meade" }, state: { code: "MD" } },
};

describe("mapNotice", () => {
  it("keeps a relevant DMV notice and maps its fields", () => {
    const r = mapNotice(tentNotice)!;
    expect(r.kind).toBe("PROCUREMENT");
    expect(r.state).toBe("MD");
    expect(r.deadline).toBe("2026-11-20");
    expect(r.status).toBe("open");
    expect(r.agency).toBe("DEPT OF DEFENSE");
    expect(r.description).toBeUndefined(); // v2 description is a URL, not text
    expect(r.procurement?.naics).toBe("532289");
  });

  it("drops notices outside the DMV and irrelevant ones", () => {
    expect(mapNotice({ ...tentNotice, placeOfPerformance: { state: { code: "NY" } } })).toBeNull();
    expect(mapNotice({ ...tentNotice, title: "Jet engine overhaul", naicsCode: "336412", classificationCode: "J028" })).toBeNull();
  });

  it("counts a relevant NAICS or PSC code even when the title is generic", () => {
    expect(isRelevantNotice({ title: "Support services", naicsCode: "561920" })).toBe(true);
    expect(isRelevantNotice({ title: "Support services", classificationCode: "8340" })).toBe(true);
    expect(isRelevantNotice({ title: "Support services", classificationCode: "J028" })).toBe(false);
  });

  it("derives cancelled, closed and awarded status", () => {
    expect(noticeStatus({ type: "Cancelled" }, undefined)).toBe("cancelled");
    expect(noticeStatus({ type: "Solicitation", active: "No" }, undefined)).toBe("closed");
    expect(noticeStatus({ type: "Award Notice" }, "Acme Events")).toBe("awarded");
  });
});

type Call = { url: URL };
function fakeFetch(pages: Record<string, { status?: number; totalRecords?: number; rows?: SamNotice[] }[]>) {
  const calls: Call[] = [];
  const idx: Record<string, number> = {};
  const impl = async (url: string) => {
    const u = new URL(url);
    calls.push({ url: u });
    const st = u.searchParams.get("state")!;
    const i = idx[st] ?? 0;
    idx[st] = i + 1;
    const p = pages[st]?.[i] ?? { totalRecords: 0, rows: [] };
    return { ok: (p.status ?? 200) < 400, status: p.status ?? 200, json: async () => ({ totalRecords: p.totalRecords, opportunitiesData: p.rows ?? [] }) };
  };
  return { impl, calls };
}

const rows = (n: number, prefix: string): SamNotice[] => Array.from({ length: n }, (_, i) => ({ noticeId: `${prefix}${i}`, title: "x" }));

describe("acquireSamIncremental", () => {
  it("queries each DMV state once within budget and advances cursors when caught up", async () => {
    const { impl, calls } = fakeFetch({ MD: [{ totalRecords: 2, rows: rows(2, "md") }], DC: [{ totalRecords: 0, rows: [] }], VA: [{ totalRecords: 1, rows: rows(1, "va") }] });
    const out = await acquireSamIncremental({ key: "KEY", today: "2026-11-07", cursors: {}, maxCalls: 3, lookbackDays: 14, fetchImpl: impl });
    expect(calls.map((c) => c.url.searchParams.get("state"))).toEqual(["MD", "DC", "VA"]);
    expect(calls[0].url.searchParams.get("postedFrom")).toBe("10/24/2026");
    expect(calls[0].url.searchParams.get("postedTo")).toBe("11/07/2026");
    expect(out.notices).toHaveLength(3);
    expect(out.report.complete).toBe(true);
    expect(out.cursors.MD).toEqual({ from: "2026-11-06", offset: 0 });
  });

  it("stops at the call budget and resumes from the saved offset next run", async () => {
    const { impl } = fakeFetch({ MD: [{ totalRecords: 1500, rows: rows(1000, "a") }, { totalRecords: 1500, rows: rows(500, "b") }] });
    const first = await acquireSamIncremental({ key: "KEY", today: "2026-11-07", cursors: {}, maxCalls: 1, lookbackDays: 14, fetchImpl: impl });
    expect(first.report.complete).toBe(false);
    expect(first.cursors.MD).toEqual({ from: "2026-10-24", offset: 1000 });
    expect(first.cursors.DC).toEqual({ from: "2026-10-24", offset: 0 }); // untouched, still owed

    const second = await acquireSamIncremental({ key: "KEY", today: "2026-11-07", cursors: first.cursors, maxCalls: 1, lookbackDays: 14, fetchImpl: impl });
    expect(second.notices).toHaveLength(500);
    expect(second.cursors.MD).toEqual({ from: "2026-11-06", offset: 0 });
  });

  it("records errors without the key and keeps the cursor for a retry", async () => {
    const { impl } = fakeFetch({ MD: [{ status: 429 }], DC: [{ status: 500 }], VA: [{ totalRecords: 0 }] });
    const out = await acquireSamIncremental({ key: "SECRETKEY", today: "2026-11-07", cursors: { MD: { from: "2026-11-01", offset: 0 } }, maxCalls: 3, lookbackDays: 14, fetchImpl: impl });
    expect(out.report.errors[0]).toContain("daily limit");
    expect(out.report.errors.join(" ")).not.toContain("SECRETKEY");
    expect(out.cursors.MD).toEqual({ from: "2026-11-01", offset: 0 });
    expect(out.report.complete).toBe(false);
  });
});
