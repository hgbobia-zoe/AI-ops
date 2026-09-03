// Distinct drivers scheduled in Connecteam for a date — populates the Dispatch driver picker.
// Read-only. GET /api/crew/drivers?date=YYYY-MM-DD

import { NextResponse } from "next/server";
import { getCrewForDate, connecteamConfigured } from "@/lib/connecteam";
import { todayInOpsTz } from "@/lib/dates";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  if (!connecteamConfigured()) return NextResponse.json({ drivers: [], configured: false });
  const url = new URL(req.url);
  const date = url.searchParams.get("date") || todayInOpsTz();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "bad date" }, { status: 400 });
  const crew = await getCrewForDate(date);
  const seen = new Map<number, string>();
  for (const s of crew) for (const a of s.assignees) if (a.role === "driver") seen.set(a.userId, a.name);
  const drivers = [...seen.entries()].map(([userId, name]) => ({ userId: String(userId), name })).sort((a, b) => a.name.localeCompare(b.name));
  return NextResponse.json({ drivers, configured: true });
}
