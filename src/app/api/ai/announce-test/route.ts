// Slack announce SELF-TEST — fires one real sample bot card through the live botAnnounce path (persona +
// channel routing + Block Kit) so we can confirm the wiring end-to-end without waiting for a real event.
// Token-gated (RUNTIME_TOKEN, same as the runtime tick): 503 until set, 401 on a bad token. Returns the
// SlackResult so the caller can SEE what happened — ok (posted), skipped (no bot token), or an error like
// "not_in_channel" / "missing_scope". Harmless: it only posts a clearly-labelled test card.
//
//   curl -X POST "https://zoe-dispatch.fly.dev/api/ai/announce-test?bot=scheduling" -H "authorization: Bearer <RUNTIME_TOKEN>"

import { NextResponse } from "next/server";
import { botAnnounce, appUrl, type BotId } from "@/lib/notify/aiBots";

export const dynamic = "force-dynamic";

const BOT_IDS: BotId[] = ["scheduling", "pricing", "sales", "reviews", "inventory", "hiring", "data", "ops"];

function sampleCard(bot: BotId) {
  const at = new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  if (bot === "sales") {
    return {
      emoji: "✍️",
      title: "Test — follow-up drafted",
      fields: [
        { label: "Client", value: "Test Client (sample)" },
        { label: "Value", value: "$8,400" },
        { label: "Channel", value: "text" },
        { label: "Event", value: "2026-11-02" },
      ],
      body: "*This is a test card* to confirm the Sales Bot can post here. No real message was drafted or sent.",
      link: { text: "Review & approve", url: appUrl("/ai-org/approvals") },
      context: `Sales Bot · self-test ${at} ET`,
    };
  }
  return {
    emoji: "🗓️",
    title: `Test notification — ${bot} bot`,
    fields: [
      { label: "Status", value: "Wiring check" },
      { label: "Sent at", value: `${at} ET` },
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
  if (auth !== `Bearer ${token}` && qp !== token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const botParam = (url.searchParams.get("bot") || "scheduling").toLowerCase();
  const bot = (BOT_IDS as string[]).includes(botParam) ? (botParam as BotId) : "scheduling";
  const result = await botAnnounce(bot, sampleCard(bot));
  return NextResponse.json({ ok: result.ok, bot, result, at: new Date().toISOString() });
}

export const GET = handle;
export const POST = handle;
