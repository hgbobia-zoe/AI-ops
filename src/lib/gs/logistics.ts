// Goodshuffle project logistics, parsed from the project timeline (GET /app/vendorTransaction/initProjectTimeline).
// Each logistics leg is an event like { type: "logisticsDelivery", dateLabel: "Friday, 11/13 [9:00 AM - 8:00 PM]" }.
// "logisticsDelivery" = our truck drives there; "logisticsInStore" = the customer collects/returns at the
// warehouse. The earliest delivery leg is the drop-off, the latest the pickup. Labels carry no year, so it
// is taken from the project's logistics start date (rolled to the next year across New Year).
// PURE: no I/O. Verified live against Goodshuffle on 2026-11-10.

export interface TimelineEvent {
  type?: string | null;
  dateLabel?: string | null;
}

export interface ProjectLogistics {
  /** YYYY-MM-DD of the drop-off leg we drive, or null. */
  deliveryDate: string | null;
  /** Raw window, e.g. "9:00 AM - 8:00 PM", or null. */
  deliveryWindow: string | null;
  /** YYYY-MM-DD of the pickup leg we drive, or null (one leg only, or the customer returns it). */
  pickupDate: string | null;
  pickupWindow: string | null;
  /** true = at least one leg is ours to drive; false = only in-store legs; null = no logistics legs seen. */
  delivers: boolean | null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "Friday, 11/13 [9:00 AM - 8:00 PM]" → { date, window } using `startYmd` for the year. */
export function parseLegLabel(label: string, startYmd: string | null): { date: string; window: string | null } | null {
  const m = /(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/.exec(label ?? "");
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  let year: number;
  if (m[3]) {
    year = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
  } else {
    const start = startYmd && /^\d{4}-\d{2}-\d{2}$/.test(startYmd) ? startYmd : null;
    year = start ? Number(start.slice(0, 4)) : new Date().getUTCFullYear();
    // A leg more than ~2 months before the start date is across New Year (e.g. start 12/30, pickup 1/2).
    if (start) {
      const cand = Date.UTC(year, month - 1, day);
      const s = Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1, Number(start.slice(8, 10)));
      if (cand < s - 60 * 86400000) year += 1;
    }
  }
  const w = /\[([^\]]+)\]/.exec(label);
  const window = w ? w[1].replace(/\s+/g, " ").trim().slice(0, 40) || null : null;
  return { date: `${year}-${pad(month)}-${pad(day)}`, window };
}

export function parseProjectLogistics(events: TimelineEvent[], startYmd: string | null): ProjectLogistics {
  const legs = (events ?? []).filter((e) => typeof e?.type === "string" && e.type.startsWith("logistics"));
  const out: ProjectLogistics = { deliveryDate: null, deliveryWindow: null, pickupDate: null, pickupWindow: null, delivers: null };
  if (legs.length === 0) return out;
  const ours = legs
    .filter((e) => e.type === "logisticsDelivery")
    .map((e) => parseLegLabel(String(e.dateLabel ?? ""), startYmd))
    .filter((x): x is { date: string; window: string | null } => x != null)
    .sort((a, b) => a.date.localeCompare(b.date));
  out.delivers = legs.some((e) => e.type === "logisticsDelivery");
  if (ours.length > 0) {
    out.deliveryDate = ours[0].date;
    out.deliveryWindow = ours[0].window;
  }
  if (ours.length > 1) {
    out.pickupDate = ours[ours.length - 1].date;
    out.pickupWindow = ours[ours.length - 1].window;
  }
  return out;
}
