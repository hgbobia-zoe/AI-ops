// Lost Quotes intelligence — the deterministic core. RULES CALCULATE: win rate, lost value, and
// where in the pipeline we leak, all from real booking outcomes. No fabrication, no invented
// competitor data. Goodshuffle stores no loss REASON, so reasons come only from what the team tags
// (reasonBreakdown separates tagged from untagged honestly).

export type Outcome = "won" | "lost" | "open";

const LOST_RE = /(lost|cancel|dead)/;

/** Outcome from real status: a lost/cancelled status wins (even if it was once signed), else signed ⇒
 *  won, else it's still open. */
export function outcomeOf(b: { signed: boolean; statusLabel?: string | null }): Outcome {
  if (LOST_RE.test((b.statusLabel ?? "").toLowerCase())) return "lost";
  if (b.signed) return "won";
  return "open";
}

export interface LostInput {
  signed: boolean;
  statusLabel?: string | null;
  grandTotal?: number | null; // $ (potential/contract value)
  eventDate?: string | null; // YYYY-MM-DD
  lossReason?: string | null;
}

const avg = (vals: (number | null | undefined)[]): number | null => {
  const k = vals.filter((v): v is number => typeof v === "number");
  return k.length ? k.reduce((s, v) => s + v, 0) / k.length : null;
};
const sum = (vals: (number | null | undefined)[]): number | null => {
  const k = vals.filter((v): v is number => typeof v === "number");
  return k.length ? k.reduce((s, v) => s + v, 0) : null;
};

export interface WinLossStats {
  won: number;
  lost: number;
  open: number;
  decided: number; // won + lost
  winRate: number | null; // won / decided (0..1)
  wonValue: number | null;
  lostValue: number | null;
  avgWonValue: number | null;
  avgLostValue: number | null;
}

/** Overall win/loss from a set of bookings. Open quotes are excluded from win rate (not yet decided). */
export function winLossStats(bookings: LostInput[]): WinLossStats {
  const won = bookings.filter((b) => outcomeOf(b) === "won");
  const lost = bookings.filter((b) => outcomeOf(b) === "lost");
  const open = bookings.filter((b) => outcomeOf(b) === "open");
  const decided = won.length + lost.length;
  return {
    won: won.length,
    lost: lost.length,
    open: open.length,
    decided,
    winRate: decided > 0 ? won.length / decided : null,
    wonValue: sum(won.map((b) => b.grandTotal)),
    lostValue: sum(lost.map((b) => b.grandTotal)),
    avgWonValue: avg(won.map((b) => b.grandTotal)),
    avgLostValue: avg(lost.map((b) => b.grandTotal)),
  };
}

export interface SizeBucket {
  label: string;
  min: number;
  max: number | null; // null = no upper bound
  won: number;
  lost: number;
  decided: number;
  winRate: number | null;
}

export const DEFAULT_SIZE_BUCKETS: { label: string; min: number; max: number | null }[] = [
  { label: "Under $500", min: 0, max: 500 },
  { label: "$500–1k", min: 500, max: 1000 },
  { label: "$1k–2.5k", min: 1000, max: 2500 },
  { label: "$2.5k–5k", min: 2500, max: 5000 },
  { label: "$5k+", min: 5000, max: null },
];

/** Win rate by deal size — the honest answer to "are we losing the big ones or the small ones?".
 *  Only decided quotes with a known value are counted. */
export function winRateBySize(bookings: LostInput[], buckets = DEFAULT_SIZE_BUCKETS): SizeBucket[] {
  return buckets.map((b) => {
    let won = 0;
    let lost = 0;
    for (const q of bookings) {
      const v = q.grandTotal;
      if (typeof v !== "number") continue;
      if (v < b.min || (b.max != null && v >= b.max)) continue;
      const o = outcomeOf(q);
      if (o === "won") won++;
      else if (o === "lost") lost++;
    }
    const decided = won + lost;
    return { label: b.label, min: b.min, max: b.max, won, lost, decided, winRate: decided > 0 ? won / decided : null };
  });
}

export interface YearWinLoss {
  year: number;
  won: number;
  lost: number;
  decided: number;
  winRate: number | null;
  lostValue: number | null;
}

/** Win/loss by event-date year (ascending) — the trend of how we're closing over time. */
export function winLossByYear(bookings: LostInput[]): YearWinLoss[] {
  const by = new Map<number, { won: number; lost: number; lostValue: number }>();
  for (const b of bookings) {
    const y = b.eventDate && b.eventDate.length >= 4 ? Number(b.eventDate.slice(0, 4)) : NaN;
    if (!Number.isFinite(y) || y < 1900) continue;
    const o = outcomeOf(b);
    if (o === "open") continue;
    const row = by.get(y) ?? { won: 0, lost: 0, lostValue: 0 };
    if (o === "won") row.won++;
    else {
      row.lost++;
      if (typeof b.grandTotal === "number") row.lostValue += b.grandTotal;
    }
    by.set(y, row);
  }
  return [...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, r]) => {
      const decided = r.won + r.lost;
      return { year, won: r.won, lost: r.lost, decided, winRate: decided > 0 ? r.won / decided : null, lostValue: r.lost > 0 ? r.lostValue : null };
    });
}

export interface ReasonCount {
  reason: string;
  count: number;
  value: number | null; // $ lost attributed to this reason
}

/** Tally lost quotes by their team-tagged reason. Untagged losses are surfaced as their own bucket —
 *  never hidden — so the "how much do we actually know" is honest. */
export function reasonBreakdown(lost: LostInput[]): { tagged: ReasonCount[]; untaggedCount: number } {
  const by = new Map<string, { count: number; value: number }>();
  let untaggedCount = 0;
  for (const b of lost) {
    const r = (b.lossReason ?? "").trim();
    if (!r) {
      untaggedCount++;
      continue;
    }
    const row = by.get(r) ?? { count: 0, value: 0 };
    row.count++;
    if (typeof b.grandTotal === "number") row.value += b.grandTotal;
    by.set(r, row);
  }
  const tagged = [...by.entries()]
    .map(([reason, r]) => ({ reason, count: r.count, value: r.value > 0 ? r.value : null }))
    .sort((a, b) => b.count - a.count);
  return { tagged, untaggedCount };
}

export interface Insight {
  tone: "info" | "warn" | "good";
  text: string;
}

const MIN_BUCKET_VOL = 10; // don't draw conclusions from a handful of quotes

/** Deterministic, grounded takeaways — "where we leak and what to look at". No speculation beyond the
 *  data: every claim traces to a computed number. */
export function lossInsights(stats: WinLossStats, buckets: SizeBucket[], reasons: { tagged: ReasonCount[]; untaggedCount: number }): Insight[] {
  const out: Insight[] = [];
  const pct = (r: number | null): string => (r == null ? "—" : `${Math.round(r * 100)}%`);

  if (stats.winRate != null) {
    out.push({
      tone: stats.winRate >= 0.5 ? "good" : "info",
      text: `Won ${stats.won} of ${stats.decided} decided quotes — a ${pct(stats.winRate)} win rate. ${stats.lost} were lost.`,
    });
  }

  // Where the biggest leak is by deal size: the highest-volume bucket whose win rate trails the best.
  const solid = buckets.filter((b) => b.decided >= MIN_BUCKET_VOL && b.winRate != null);
  if (solid.length >= 2) {
    const best = solid.reduce((a, b) => (b.winRate! > a.winRate! ? b : a));
    const worst = solid.reduce((a, b) => (b.winRate! < a.winRate! ? b : a));
    if (best.label !== worst.label && best.winRate! - worst.winRate! >= 0.15) {
      out.push({
        tone: "warn",
        text: `Win rate drops to ${pct(worst.winRate)} on ${worst.label} quotes vs ${pct(best.winRate)} on ${best.label} — that size is your biggest leak. Tighten follow-up and review pricing there.`,
      });
    }
  }

  const topReason = reasons.tagged[0];
  if (topReason && topReason.count >= 3) {
    out.push({ tone: "warn", text: `Most common recorded loss reason: “${topReason.reason}” (${topReason.count}). Worth a targeted fix.` });
  } else if (reasons.untaggedCount > 0 && reasons.tagged.length === 0) {
    out.push({ tone: "info", text: `Goodshuffle records no loss reason — tag why quotes were lost to unlock reason trends and see what's actually costing you.` });
  }

  return out;
}
