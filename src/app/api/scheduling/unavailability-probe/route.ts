// TEMPORARY verification probe for the Connecteam user-unavailability endpoint (the "worker marked
// themselves off" signal). Confirms our key actually reaches /scheduler/v1/schedulers/user-unavailability
// and shows the exact JSON shape so the parser can be locked to reality. Session-gated by the proxy.
// Remove once availability is wired into the eligibility classifier.

import { NextResponse } from "next/server";
import {
  connecteamConfigured,
  getUsers,
  rawUserUnavailability,
  getUserUnavailability,
} from "@/lib/connecteam";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  if (!connecteamConfigured()) {
    return NextResponse.json({ ok: false, reason: "Connecteam not configured (CONNECTEAM_API_KEY unset)" });
  }

  const users = Array.from((await getUsers()).values());
  if (users.length === 0) {
    return NextResponse.json({ ok: false, reason: "no users returned (Connecteam unreachable?)" });
  }

  const now = Math.floor(Date.now() / 1000);
  const from = now - 7 * 86400;
  const to = now + 30 * 86400;

  // Raw shape from the first user, so we can see the real payload keys.
  const first = users[0];
  const raw = await rawUserUnavailability(first.userId, from, to);

  // Parsed counts across a sample of the team, to confirm access + that the parser catches blocks.
  const sample = users.slice(0, 25);
  const parsed: Array<{ userId: number; name: string; ok: boolean; timeOff: number; unavailability: number }> = [];
  let anyOk = false;
  let totalBlocks = 0;
  for (const u of sample) {
    const r = await getUserUnavailability(u.userId, from, to);
    if (r.ok) anyOk = true;
    const timeOff = r.blocks.filter((b) => b.kind === "timeOff").length;
    const unavailability = r.blocks.filter((b) => b.kind === "unavailability").length;
    totalBlocks += r.blocks.length;
    parsed.push({ userId: u.userId, name: u.name, ok: r.ok, timeOff, unavailability });
  }

  return NextResponse.json({
    ok: anyOk,
    windowDays: 37,
    teamSize: users.length,
    sampled: sample.length,
    totalBlocksFound: totalBlocks,
    rawHttpStatus: raw.status, // 200 = our key reaches it; 401/403 = plan/scope gap; 404 = wrong path
    rawSample: raw.json, // the exact JSON shape for the first user (locks the parser)
    parsed,
  });
}
