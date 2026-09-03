// Data Health — "can I trust these numbers?" Per source, in five explicit states, from the signals
// we actually persist (import_log + per-source freshness + config). Never fabricates confidence.

import { getPullState, getRecentImports, type ImportRow } from "@/lib/pull/state";
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

/** State for a pull-backed source from its freshness + latest import row. */
function pullState(lastAt: string | null, latest: ImportRow | null, thresholdH: number, configured = true): HealthState {
  if (!configured) return "UNVERIFIED";
  if (latest && !latest.ok) return latest.detail?.toLowerCase().includes("partial") ? "INCOMPLETE" : "RETRIEVAL_FAILED";
  if (!lastAt) return "NEVER";
  const age = ageHours(lastAt);
  if (age != null && age >= thresholdH) return "STALE";
  return "FRESH";
}

export function computeDataHealth(): SourceHealth[] {
  const sources = getPullState().sources ?? {};
  const imports = getRecentImports(400);
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
      state: pullState(routeAt, routeImp, 26),
      lastAt: routeAt,
      ageH: ageHours(routeAt),
      rows: routeImp?.rowsWritten ?? null,
      detail: routeEntries.length ? `${routeEntries.length} truck(s) pulled` : "no route pull recorded",
    },
    {
      key: "bookings",
      label: "Goodshuffle bookings (sales/finance/customers)",
      state: pullState(bookAt, bookImp, 26),
      lastAt: bookAt,
      ageH: ageHours(bookAt),
      rows: bookImp?.rowsWritten ?? sources["bookings"]?.count ?? null,
      detail: bookImp && !bookImp.ok ? bookImp.detail ?? "last pull failed" : "commercial pipeline",
    },
    {
      key: "connecteam",
      label: "Connecteam (staffing / labor cost)",
      state: connecteamConfigured() ? pullState(ctAt, ctImp, 24) : "UNVERIFIED",
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
