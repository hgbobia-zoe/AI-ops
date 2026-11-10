// Chrome-run account setup: jobs are approved + handed out in run order (mailbox first), each with a one-time
// key; the extension's report only lands with that key; outcomes map onto honest task states; Slack/Quo
// invites close only once the hire has actually joined.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmployee, getEmployee, getTask, listTasks, updateTask } from "./store";
import { startOnboarding } from "./lifecycle";
import { _resetChromeJobCaches, applyChromeResult, confirmChromeInvites, jobData, mailboxUserName, startChromeRun } from "./chromeJobs";

const ORIGIN = "https://zoe.example";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SLACK_BOT_TOKEN;
  _resetChromeJobCaches();
});

function onboardSales(name: string, extra: { personalEmail?: string; workEmail?: string } = {}) {
  const e = createEmployee({ displayName: name, role: "member", department: "sales_associate", phone: "+12025550300", ...extra });
  startOnboarding(e.id, "tester");
  return getEmployee(e.id)!;
}

describe("mailbox name + job data", () => {
  it("uses the existing work address, else first.last without accents", () => {
    expect(mailboxUserName({ displayName: "Ana María López", workEmail: null })).toBe("ana.lopez");
    expect(mailboxUserName({ displayName: "Pat Lee", workEmail: "patrick.lee@zoeeventsdmv.com" })).toBe("patrick.lee");
    expect(mailboxUserName({ displayName: "Cher", workEmail: null })).toBe("cher");
  });

  it("the mailbox needs a personal email for the login; invites need any email", () => {
    const e = onboardSales("Jo Noemail");
    expect(jobData("squarespace_email", e, null)).toEqual({ blocked: expect.stringMatching(/personal email/) });
    expect(jobData("slack", e, null)).toEqual({ blocked: expect.stringMatching(/email/) });
    expect(jobData("slack", e, "jo.noemail@zoeeventsdmv.com")).toMatchObject({ data: { email: "jo.noemail@zoeeventsdmv.com" } });
  });
});

describe("startChromeRun", () => {
  it("approves and hands out Chrome jobs, mailbox first, invites to the new work address", async () => {
    const e = onboardSales("Riley Stone", { personalEmail: "riley@gmail.test" });
    const { jobs } = await startChromeRun({ employeeId: e.id, actor: "Lisa", origin: ORIGIN });
    const systems = jobs.map((j) => j.system);
    expect(systems[0]).toBe("squarespace_email");
    expect(systems).toEqual(expect.arrayContaining(["slack", "quo"]));
    expect(jobs.every((j) => j.token.length > 20 && j.resultUrl === `${ORIGIN}/api/provision/result`)).toBe(true);
    expect(jobs.find((j) => j.system === "squarespace_email")!.data).toMatchObject({ newEmail: "riley.stone@zoeeventsdmv.com", loginTo: "riley@gmail.test" });
    expect(jobs.find((j) => j.system === "slack")!.data).toMatchObject({ email: "riley.stone@zoeeventsdmv.com" });
    expect(jobs.find((j) => j.system === "quo")!.approval).toBe("paid");
    // Each step is now waiting for Chrome, with its approval card.
    for (const j of jobs) {
      const t = getTask(j.taskId)!;
      expect(t.status).toBe("in_progress");
      expect(t.approvalId).toMatch(/^AP-/);
    }
  });

  it("a step that can't run is marked blocked with the reason", async () => {
    const e = onboardSales("No Contact");
    const { jobs, skipped } = await startChromeRun({ employeeId: e.id, actor: "Lisa", origin: ORIGIN });
    expect(jobs).toEqual([]);
    const mail = listTasks(e.id, "provision").find((t) => t.adapterId === "squarespace_email");
    if (mail) {
      expect(getTask(mail.id)!.status).toBe("blocked");
      expect(skipped.some((s) => /personal email/.test(s.reason))).toBe(true);
    }
  });
});

describe("applyChromeResult", () => {
  it("needs the job's key, once; a created mailbox becomes the work email", async () => {
    const e = onboardSales("Sam Field", { personalEmail: "sam@gmail.test" });
    const { jobs } = await startChromeRun({ employeeId: e.id, actor: "Lisa", origin: ORIGIN });
    const mail = jobs.find((j) => j.system === "squarespace_email")!;
    expect(applyChromeResult({ taskId: mail.taskId, token: "wrong", outcome: "done" }).ok).toBe(false);
    expect(applyChromeResult({ taskId: mail.taskId, token: mail.token, outcome: "done", createdEmail: "sam.field@zoeeventsdmv.com" }).ok).toBe(true);
    const t = getTask(mail.taskId)!;
    expect(t.status).toBe("completed");
    expect(t.actor).toBe("Lisa");
    expect(getEmployee(e.id)!.workEmail).toBe("sam.field@zoeeventsdmv.com");
    // Reusing the key is refused.
    expect(applyChromeResult({ taskId: mail.taskId, token: mail.token, outcome: "failed" }).ok).toBe(false);
  });

  it("a Slack invite stays open until they join; WeddingPro's closes on send; declines go back to pending", async () => {
    const e = onboardSales("Kai Brook", { personalEmail: "kai@gmail.test", workEmail: "kai.brook@zoeeventsdmv.com" });
    const { jobs } = await startChromeRun({ employeeId: e.id, actor: "Lisa", origin: ORIGIN });
    const slack = jobs.find((j) => j.system === "slack")!;
    applyChromeResult({ taskId: slack.taskId, token: slack.token, outcome: "invited", createdEmail: "kai.brook@zoeeventsdmv.com" });
    expect(getTask(slack.taskId)).toMatchObject({ status: "in_progress", externalRef: "invited:kai.brook@zoeeventsdmv.com" });

    const wp = jobs.find((j) => j.system === "weddingpro");
    if (wp) {
      applyChromeResult({ taskId: wp.taskId, token: wp.token, outcome: "invited" });
      expect(getTask(wp.taskId)!.status).toBe("completed");
    }
    const quo = jobs.find((j) => j.system === "quo")!;
    applyChromeResult({ taskId: quo.taskId, token: quo.token, outcome: "declined" });
    expect(getTask(quo.taskId)).toMatchObject({ status: "pending", externalRef: null });

    // A new run hands out a job for the declined step but not for the sent Slack invite.
    const again = await startChromeRun({ employeeId: e.id, actor: "Lisa", origin: ORIGIN });
    expect(again.jobs.map((j) => j.system)).toContain("quo");
    expect(again.jobs.map((j) => j.system)).not.toContain("slack");
  });
});

describe("confirmChromeInvites", () => {
  it("closes a Slack invite once the bot finds the person, and leaves it open otherwise", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const e = onboardSales("Lee Joined", { workEmail: "lee.joined@zoeeventsdmv.com" });
    const slackTask = listTasks(e.id, "provision").find((t) => t.adapterId === "slack");
    if (!slackTask) return; // the sales policy has no Slack step
    updateTask(slackTask.id, { status: "in_progress", externalRef: "invited:lee.joined@zoeeventsdmv.com" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "users_not_found" }), { status: 200 })));
    expect(await confirmChromeInvites([getTask(slackTask.id)!], "tick")).toBe(0);
    expect(getTask(slackTask.id)!.status).toBe("in_progress");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, user: { id: "U1" } }), { status: 200 })));
    expect(await confirmChromeInvites([getTask(slackTask.id)!], "tick")).toBe(1);
    expect(getTask(slackTask.id)!.status).toBe("completed");
  });
});
