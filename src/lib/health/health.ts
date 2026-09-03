// Data Health — "can I trust these numbers?" Per source, in five explicit states, from the signals
// we actually persist (import_log + per-source freshness + config). Never fabricates confidence.

import { getPullState, getRecentImports, type ImportRow } from "@/lib/pull/state";
import { getDataCounts } from "@/lib/db/repo";
import { connecteamConfigured } from "@/lib/connecteam";

export type HealthState = "FRESH" | "STALE" | "INCOMPLETE" | "RETRIEVAL_FAILED" | "UNVERIFIED" | "NEVER";

export interface SourceHealth {
  key: string;
  label: string;
  state: HealthState;
  lastAt: string | null;
  ageH: number | null;
  rows: number | null;
  detail: string;
}

const ageHours = (iso: string | null): number | null => (iso ? Math.round((Date.now() - Date.parse(iso)) / 3_600_000) : null);

/** State for a pull-backed source from its freshness + latest import row + rows on file. */
function pullState(lastAt: string | null, latest: ImportRow | null, thresholdH: number, rowsOnFile: number, configured = true): HealthState {
  if (!configured) return "UNVERIFIED";
  if (latest && !latest.ok) return latest.detail?.toLowerCase().includes("partial") ? "INCOMPLETE" : "RETRIEVAL_FAILED";
  if (!lastAt) {
    // No freshness signal. If rows already exist (an earlier pull, before per-source tracking), the
    // data is STALE-of-unknown-age, NOT absent — don't cry "no data" over real (old) rows.
    return rowsOnFile > 0 ? "STALE" : "NEVER";
  }
  const age = ageHours(lastAt);
  if (age != null && age >= thresholdH) return "STALE";
  return "FRESH";
}

export function computeDataHealth(): SourceHealth[] {
  const sources = getPullState().sources ?? {};
  const imports = getRecentImports(400);
  const counts = getDataCounts();
  const latest = (pred: (r: ImportRow) => boolean): ImportRow | null => imports.find(pred) ?? null;

  // Goodshuffle routes — freshest across route:* pulls.
  const routeEntries = Object.entries(sources).filter(([k]) => k.startsWith("route:"));
  const routeAt = routeEntries.length ? new Date(Math.max(...routeEntries.map(([, v]) => Date.parse(v.at)))).toISOString() : null;
  const routeImp = latest((r) => r.source.startsWith("route:"));
  const bookImp = latest((r) => r.source === "bookings");
  const bookAt = sources["bookings"]?.at ?? null;
  const ctImp = latest((r) => r.source === "connecteam");
  const ctAt = sources["connecteam"]?.at ?? null;

  const out: SourceHealth[] = [
    {
      key: "routes",
      label: "Goodshuffle routes (dispatch)",
      state: pullState(routeAt, routeImp, 26, counts.routes),
      lastAt: routeAt,
      ageH: ageHours(routeAt),
      rows: counts.routes,
      detail: routeAt
        ? `${routeEntries.length} truck(s) pulled`
        : counts.routes > 0
          ? `${counts.routes} route(s) on file from an earlier pull — no recent pull recorded; pull to confirm`
          : "no route data",
    },
    {
      key: "bookings",
      label: "Goodshuffle bookings (sales/finance/customers)",
      state: pullState(bookAt, bookImp, 26, counts.bookings),
      lastAt: bookAt,
      ageH: ageHours(bookAt),
      rows: counts.bookings,
      detail: bookImp && !bookImp.ok
        ? bookImp.detail ?? "last pull failed"
        : bookAt
          ? "commercial pipeline"
          : counts.bookings > 0
            ? `${counts.bookings} booking(s) on file from an earlier pull — no recent pull recorded; pull to confirm`
            : "no booking data",
    },
    {
      key: "connecteam",
      label: "Connecteam (staffing / labor cost)",
      state: connecteamConfigured() ? pullState(ctAt, ctImp, 24, 0) : "UNVERIFIED",
      lastAt: ctAt,
      ageH: ageHours(ctAt),
      rows: null,
      detail: connecteamConfigured()
        ? ctImp && !ctImp.ok
          ? "unreachable at last scan"
          : "verified at last scan"
        : "not connected",
    },
    {
      key: "gps",
      label: "GPS / live ETA",
      state: "UNVERIFIED",
      lastAt: null,
      ageH: null,
      rows: null,
      detail: "live-only — computed on demand from truck GPS; no stored last-fix yet",
    },
  ];
  return out;
}
