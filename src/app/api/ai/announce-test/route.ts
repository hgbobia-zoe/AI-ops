// Slack announce SELF-TEST — fires one real sample bot card through the live botAnnounce path (persona +
// channel routing + Block Kit) so the wiring can be confirmed end-to-end without waiting for a real event.
// Token-gated (RUNTIME_TOKEN, same as the runtime tick) OR an internal localhost call (only reachable from
// inside the machine over SSH). Harmless: posts a clearly-labelled test card.
//
//   curl -X POST "https://zoe-dispatch.fly.dev/api/ai/announce-test?bot=sales" -H "authorization: Bearer <RUNTIME_TOKEN>"
//
// bot=sales also attaches real Approve/Dismiss buttons backed by a SAFE test approval (a FORBIDDEN-to-execute
// action type), so clicking Approve in Slack exercises the interactivity endpoint but sends nothing.

import { NextResponse } from "next/server";
import { botAnnounce, appUrl, cardBlocks, BOTS, type BotCard, type BotId } from "@/lib/notify/aiBots";
import { slackPostAs } from "@/lib/notify/slack";
import { APPROVE_ACTION, REJECT_ACTION } from "@/lib/slack/interactivity";
import { createApproval } from "@/lib/aiorg/approvals";

export const dynamic = "force-dynamic";

const BOT_IDS: BotId[] = ["scheduling", "pricing", "sales", "reviews", "inventory", "hiring", "data", "ops"];

function etNow(): string {
  return new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
}

function sampleCard(bot: BotId): BotCard {
  if (bot === "sales") {
    // A SAFE test approval: "schedule_change" is FORBIDDEN to execute, so approving it records intent and
    // sends nothing (never contacts a customer). The buttons carry its id so the interactivity flow is real.
    const appr = createApproval({
      agentId: "outreach",
      owner: "Jessie",
      title: "TEST — follow-up to Test Client (sample)",
      actionType: "schedule_change",
      actionPayload: { note: "self-test" },
      card: { what: "Test card.", why: "Self-test.", dataUsed: "none", expectedOutcome: "none", risk: "none", whatIfApproved: "Nothing is sent (forbidden action)." },
      idempotencyKey: `announce-test:${Date.now()}`,
    });
    return {
      emoji: "✍️",
      title: "Test — follow-up drafted",
      fields: [
        { label: "Client", value: "Test Client (sample)" },
        { label: "Value", value: "$8,400" },
        { label: "Channel", value: "text" },
        { label: "Event", value: "2026-11-02" },
      ],
      body: "*This is a test card.* Clicking Approve is safe — it records intent and sends nothing.",
      buttons: [
        { text: "Approve & send", actionId: APPROVE_ACTION, value: appr.id, style: "primary" },
        { text: "Dismiss", actionId: REJECT_ACTION, value: appr.id, style: "danger" },
      ],
      link: { text: "Open to edit", url: appUrl("/ai-org/approvals") },
      context: `Sales Bot · self-test ${etNow()} ET`,
    };
  }
  return {
    emoji: "🗓️",
    title: `Test notification — ${bot} bot`,
    fields: [
      { label: "Status", value: "Wiring check" },
      { label: "Sent at", value: `${etNow()} ET` },
    ],
    body: `*This is a test card* to confirm the ${bot} bot can post to its channel. Nothing real happened.`,
    link: { text: "Open app", url: appUrl("/") },
    context: `${bot} bot · self-test`,
  };
}

async function handle(req: Request): Promise<NextResponse> {
  const token = process.env.RUNTIME_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "not_configured", message: "Set RUNTIME_TOKEN to use the announce self-test." }, { status: 503 });
  }
  const url = new URL(req.url);
  const auth = req.headers.get("authorization");
  const qp = url.searchParams.get("token");
  const host = (req.headers.get("host") || "").toLowerCase();
  const internal = host.startsWith("localhost") || host.startsWith("127.0.0.1") || host.startsWith("[::1]");
  if (!internal && auth !== `Bearer ${token}` && qp !== token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const botParam = (url.searchParams.get("bot") || "scheduling").toLowerCase();
  const bot = (BOT_IDS as string[]).includes(botParam) ? (botParam as BotId) : "scheduling";
  const card = sampleCard(bot);
  // Optional ?ch= override: post this bot's card to a specific channel (e.g. to demo the sales card with
  // buttons in a channel the bot has already been invited to). No fallback — shows the raw bot-token result.
  const chOverride = url.searchParams.get("ch")?.trim();
  if (chOverride) {
    const r = await slackPostAs(chOverride, BOTS[bot], card.title, { blocks: cardBlocks(card) });
    return NextResponse.json({ ok: r.ok, bot, channel: chOverride, result: r, at: new Date().toISOString() });
  }
  const result = await botAnnounce(bot, card);
  return NextResponse.json({ ok: result.ok, bot, result, at: new Date().toISOString() });
}

export const GET = handle;
export const POST = handle;
