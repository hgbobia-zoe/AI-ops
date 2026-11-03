import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { openImprovementRun, advance } from "./service";
import { getRun, listRunEvents } from "./store";
import { gatherEvidence, buildPlannerPrompt, planRun, type PlannerClient } from "./planner";
import { insertAudit } from "@/lib/db/repo";

const scope = { blade: "scheduling", summary: "Recurring failure: SHIFT_PUBLISH_CONNECTEAM_FAILED", problem: "It failed.", allowedPaths: ["src/lib/scheduling/"], forbiddenPaths: [] };

function fake(text: string, stop: Anthropic.Beta.BetaMessage["stop_reason"] = "end_turn"): PlannerClient & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    create: async (p) => {
      prompts.push(String(p.messages[0].content));
      return { content: text ? [{ type: "text", text }] : [], stop_reason: stop } as unknown as Anthropic.Beta.BetaMessage;
    },
  };
}

describe("improvement planner", () => {
  it("gathers the failing audit rows behind an audit signal", () => {
    insertAudit({ actor: "scheduler", action: "SHIFT_PUBLISH_CONNECTEAM_FAILED", entity: "shift", entityId: "S-1", after: { error: "409 conflict" } });
    const run = openImprovementRun({ requestId: "signal:audit:SHIFT_PUBLISH_CONNECTEAM_FAILED", scope });
    const ev = gatherEvidence(run);
    expect(ev.kind).toBe("audit_failure");
    expect(ev.lines[0]).toContain("409 conflict");
    expect(buildPlannerPrompt(run, ev)).toContain("Allowed paths: src/lib/scheduling/");
  });

  it("records the plan and moves requested -> investigating -> planned", async () => {
    const run = openImprovementRun({ requestId: "signal:audit:SHIFT_PUBLISH_CONNECTEAM_FAILED", scope });
    const client = fake("Diagnosis: a stale shift id.\nPlan: 1. Re-read before publish.");
    const out = await planRun(run.id, client);
    expect(out.ok).toBe(true);
    const after = getRun(run.id)!;
    expect(after.state).toBe("planned");
    expect(after.plan).toContain("Diagnosis: a stale shift id.");
    expect(after.plan).toContain("could not read the code");
    expect(listRunEvents(run.id).map((e) => e.to)).toEqual(expect.arrayContaining(["requested", "investigating", "planned"]));
    expect(client.prompts[0]).toContain("Evidence (audit_failure)");
  });

  it("leaves the run untouched when the model fails or declines", async () => {
    const run = openImprovementRun({ requestId: "signal:job:quo-hours", scope });
    expect((await planRun(run.id, fake(""))).ok).toBe(false);
    expect((await planRun(run.id, fake("x", "refusal"))).error).toMatch(/declined/);
    const boom: PlannerClient = { create: async () => { throw new Error("down"); } };
    expect((await planRun(run.id, boom)).error).toContain("down");
    expect(getRun(run.id)!.state).toBe("requested");
  });

  it("only plans runs that are still requested", async () => {
    const run = openImprovementRun({ scope });
    advance(run.id, "investigating");
    expect((await planRun(run.id, fake("plan"))).error).toMatch(/only requested runs/);
  });
});
