import { describe, it, expect } from "vitest";
import { RUNTIME_JOBS } from "@/lib/runtime/jobs";
import { jobArea, summarizeJobs, groupJobs, switchStates, summarizeApprovals, opLabel, SWITCHES } from "./register";

describe("automation register", () => {
  it("files every registered runtime job under a real area (none fall through to Other)", () => {
    const orphans = RUNTIME_JOBS.filter((j) => jobArea(j.key) === "Other").map((j) => j.key);
    expect(orphans).toEqual([]);
    expect(jobArea("some-new-job")).toBe("Other");
  });

  it("counts jobs by state", () => {
    const c = summarizeJobs([{ state: "ok" }, { state: "ok" }, { state: "error" }, { state: "stale" }, { state: "not_configured" }, { state: "never" }, { state: "browser_pending" }]);
    expect(c).toEqual({ total: 7, running: 2, failing: 1, stale: 1, notSetUp: 1, neverRun: 1, browser: 1 });
  });

  it("groups by area in a fixed order with problems first", () => {
    const g = groupJobs([
      { key: "website-uptime", label: "Website uptime", state: "ok" as const },
      { key: "sales-ai", label: "Sales AI", state: "ok" as const },
      { key: "esign-cutoff", label: "E-signature cutoff", state: "error" as const },
    ]);
    expect(g.map((x) => x.area)).toEqual(["Sales", "Monitoring"]);
    expect(g[0].jobs.map((j) => j.key)).toEqual(["esign-cutoff", "sales-ai"]);
  });

  it("reads switches through the given flag reader", () => {
    const s = switchStates((env) => env !== "SMS_SEND_ENABLED");
    expect(s).toHaveLength(SWITCHES.length);
    expect(s.find((x) => x.env === "SMS_SEND_ENABLED")?.on).toBe(false);
    expect(s.find((x) => x.env === "EMAIL_SEND_ENABLED")?.on).toBe(true);
  });

  it("counts approvals waiting and decided in the last 7 days only", () => {
    const now = Date.parse("2026-11-03T12:00:00Z");
    const c = summarizeApprovals(
      [
        { status: "pending", decided_at: null },
        { status: "info_requested", decided_at: "2026-11-01T00:00:00Z" },
        { status: "executed", decided_at: "2026-11-02T00:00:00Z" },
        { status: "approved", decided_at: "2026-11-02T00:00:00Z" },
        { status: "rejected", decided_at: "2026-10-01T00:00:00Z" }, // older than a week
        { status: "failed", decided_at: "2026-11-03T00:00:00Z" },
      ],
      now,
    );
    expect(c).toEqual({ waiting: 2, executed7d: 1, held7d: 1, rejected7d: 0, failed7d: 1 });
  });

  it("labels known write-back ops and falls back readably", () => {
    expect(opLabel("create_project")).toBe("Project created from a lead");
    expect(opLabel("brand_new_op")).toBe("brand new op");
  });
});
