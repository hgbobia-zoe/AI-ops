// Instawork temp pay — temps are paid VIA INSTAWORK, not Gusto, so this is a labor-COST view, kept out of
// the Gusto sync path. We compute an ESTIMATE from the booked gigs we already capture (scheduled window ×
// seat price), reusing the canonical scheduling/cost helpers so HR agrees with Finance, then overlay any
// ACTUAL payouts imported from Instawork (the reconcile seam). FACTS ONLY: unknown window/price → null,
// never 0; the snapshot is point-in-time, so a past week is only as complete as what was captured.

import { getInstaworkShifts } from "@/lib/instawork/client";
import { instaworkLocalDate } from "@/lib/instawork/reconcile";
import { gigWindowHours, tempSeat } from "@/lib/scheduling/cost";
import { listTempPayouts } from "./store";
import type { PayPeriod, TempPayResult, TempWorkerPay } from "./types";

const UNNAMED = "Unassigned seats";
const round1 = (n: number): number => Math.round(n * 10) / 10;

export async function instaworkTempPay(period: PayPeriod): Promise<TempPayResult> {
  const snap = await getInstaworkShifts("in_progress_upcoming");
  const actuals = listTempPayouts(period.start, period.end);

  if (!snap.ok && actuals.size === 0) {
    return {
      ok: false, asOf: snap.fetchedAt ?? null, periodGigs: 0, workers: [],
      totalHours: null, totalEstCost: null, totalActualCost: null, hasActuals: false, partial: true,
      note: "Instawork snapshot unavailable — connect/refresh the Instawork pull to estimate temp pay.",
    };
  }

  const inPeriod = snap.shifts.filter((g) => {
    const d = instaworkLocalDate(g);
    return d !== "" && d >= period.start && d <= period.end;
  });

  const acc = new Map<string, { gigs: number; hours: number; hoursKnown: boolean; cost: number; costKnown: boolean }>();
  let partial = false;
  const bump = (name: string, hours: number | null, cost: number | null): void => {
    const w = acc.get(name) ?? { gigs: 0, hours: 0, hoursKnown: true, cost: 0, costKnown: true };
    w.gigs += 1;
    if (hours != null) w.hours += hours; else w.hoursKnown = false;
    if (cost != null) w.cost += cost; else w.costKnown = false;
    acc.set(name, w);
  };
  for (const g of inPeriod) {
    const seat = tempSeat(gigWindowHours(g), g.basePrice); // hours = window, cost = per-seat basePrice
    const named = g.workers.filter(Boolean);
    const unnamed = Math.max(0, g.filled - named.length);
    for (const n of named) bump(n, seat.hours, seat.cost);
    for (let i = 0; i < unnamed; i++) bump(UNNAMED, seat.hours, seat.cost);
    if (seat.hours == null || seat.cost == null || unnamed > 0) partial = true;
  }

  // Merge any worker who only has an actual payout (no matching booked gig in the snapshot).
  for (const name of actuals.keys()) if (!acc.has(name)) acc.set(name, { gigs: 0, hours: 0, hoursKnown: false, cost: 0, costKnown: false });

  const workers: TempWorkerPay[] = [...acc.entries()]
    .map(([name, w]): TempWorkerPay => {
      const a = actuals.get(name);
      return {
        name,
        gigs: w.gigs,
        hours: w.gigs > 0 && w.hoursKnown ? round1(w.hours) : null,
        estCost: w.gigs > 0 && w.costKnown ? Math.round(w.cost) : null,
        actualHours: a?.actualHours ?? null,
        actualCost: a?.actualAmount ?? null,
      };
    })
    .sort((x, y) => x.name.localeCompare(y.name));

  const totalHours = workers.some((w) => w.hours != null) ? round1(workers.reduce((s, w) => s + (w.hours ?? 0), 0)) : null;
  const totalEstCost = workers.some((w) => w.estCost != null) ? workers.reduce((s, w) => s + (w.estCost ?? 0), 0) : null;
  const hasActuals = actuals.size > 0;
  const totalActualCost = hasActuals && workers.some((w) => w.actualCost != null) ? workers.reduce((s, w) => s + (w.actualCost ?? 0), 0) : null;

  return {
    ok: snap.ok, asOf: snap.fetchedAt, periodGigs: inPeriod.length, workers,
    totalHours, totalEstCost, totalActualCost, hasActuals, partial,
    note: "Estimated from booked Instawork gigs (scheduled window × seat price). Paid via Instawork, not Gusto. Actuals reconcile once imported.",
  };
}
