// TEMPORARY verification probe for the Connecteam user-unavailability endpoint (the "worker marked
// themselves off" signal). Confirms our key actually reaches /scheduler/v1/schedulers/user-unavailability
// and shows the exact JSON shape so the parser can be locked to reality. Session-gated by the proxy.
// Remove once availability is wired into the eligibility classifier.
//
//   /api/scheduling/unavailability-probe            → sample the first 25 of the team
//   /api/scheduling/unavailability-probe?q=marquis  → target just the people whose name matches

import { NextRequest, NextResponse } from "next/server";
import {
  connecteamConfigured,
  getUsers,
  rawUserUnavailability,
  getUserUnavailability,
  type CrewMember,
} from "@/lib/connecteam";

export const dynamic = "force-dynamic";

const TZ = process.env.ETA_TIMEZONE || "America/New_York";
function readable(unix: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(unix * 1000));
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!connecteamConfigured()) {
    return NextResponse.json({ ok: false, reason: "Connecteam not configured (CONNECTEAM_API_KEY unset)" });
  }

  const all = Array.from((await getUsers()).values());
  if (all.length === 0) {
    return NextResponse.json({ ok: false, reason: "no users returned (Connecteam unreachable?)" });
  }

  const q = (req.nextUrl.searchParams.get("q") || "").trim().toLowerCase();
  const matched: CrewMember[] = q ? all.filter((u) => u.name.toLowerCase().includes(q)) : all;
  const sample = matched.slice(0, 25);
  if (sample.length === 0) {
    return NextResponse.json({ ok: false, reason: `no user matched "${q}"`, teamSize: all.length });
  }

  const now = Math.floor(Date.now() / 1000);
  const from = now - 7 * 86400;
  const to = now + 30 * 86400;

  // Raw shape from the first matched user, so we can see the real payload keys.
  const raw = await rawUserUnavailability(sample[0].userId, from, to);

  const people: Array<{
    userId: number;
    name: string;
    ok: boolean;
    blocks: Array<{ kind: string; from: string; to: string; reason?: string }>;
  }> = [];
  let anyOk = false;
  let totalBlocks = 0;
  for (const u of sample) {
    const r = await getUserUnavailability(u.userId, from, to);
    if (r.ok) anyOk = true;
    totalBlocks += r.blocks.length;
    people.push({
      userId: u.userId,
      name: u.name,
      ok: r.ok,
      blocks: r.blocks.map((b) => ({ kind: b.kind, from: readable(b.startUnix), to: readable(b.endUnix), reason: b.reason })),
    });
  }

  return NextResponse.json({
    ok: anyOk,
    query: q || "(first 25 of team)",
    windowDays: 37,
    teamSize: all.length,
    matched: matched.length,
    sampled: sample.length,
    totalBlocksFound: totalBlocks,
    rawHttpStatus: raw.status, // 200 = our key reaches it; 401/403 = plan/scope gap; 404 = wrong path
    rawSample: raw.json, // the exact JSON shape for the first matched user (locks the parser)
    people,
  });
}
