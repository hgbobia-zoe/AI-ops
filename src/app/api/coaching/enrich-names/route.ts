// Name enrichment — one pass of the continuous loop that tries to put a name on calls that still show
// only a number. For each un-named call it derives the customer's number (call metadata, else the
// transcript) and resolves a name from our Goodshuffle bookings, else the OpenPhone address book,
// persisting it. Calls it can't name yet are throttled (retried after a cooldown, in case the contact
// gets added later). Owner/admin only (proxy-gated /api/coaching/*).

import { NextResponse } from "next/server";
import { listUnnamedCoachableCalls, countUnnamedDueCalls, setCallContactName, markNameAttempted, getBookingByPhoneDigits } from "@/lib/db/repo";
import { computeCallMetrics } from "@/lib/coach/metrics";
import { ourPhoneDigits, last10 } from "@/lib/comms/identity";
import { getOpenphoneContactMap } from "@/lib/comms/openphone";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const COOLDOWN_HOURS = 12;

export async function POST(): Promise<NextResponse> {
  const cutoff = new Date(Date.now() - COOLDOWN_HOURS * 3600_000).toISOString();
  const ourDigits = ourPhoneDigits();
  const contactMap = await getOpenphoneContactMap();
  const batch = listUnnamedCoachableCalls(30, cutoff);

  let resolved = 0;
  for (const c of batch) {
    const fromD = last10(c.fromPhone);
    const toD = last10(c.toPhone);
    let digits: string | null = fromD && !ourDigits.has(fromD) ? fromD : toD && !ourDigits.has(toD) ? toD : null;
    if (!digits) {
      const cust = computeCallMetrics(c.transcript, null, ourDigits).speakers.find((s) => s.label === "Customer");
      digits = cust && /\d{10}/.test(cust.raw) ? last10(cust.raw) : null;
    }
    const name = digits ? getBookingByPhoneDigits(digits)?.clientName?.trim() || contactMap.get(digits) || null : null;
    if (name) {
      setCallContactName(c.id, name);
      resolved++;
    } else {
      markNameAttempted(c.id); // couldn't name it yet — retry after the cooldown
    }
  }

  const remaining = countUnnamedDueCalls(cutoff);
  return NextResponse.json({ resolved, remaining, done: remaining === 0 || batch.length === 0, batch: batch.length });
}
