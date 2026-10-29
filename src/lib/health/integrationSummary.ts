// Pure helpers behind the global integration summary in the app header. The summary REPLACES the old
// per-blade pill row with one compact control, and keeps two things deliberately distinct:
//
//   • CONNECTION HEALTH — is each integration actually wired up and reachable? (OpenPhone/Quo,
//     Connecteam, Slack, GPS, Ignition, Ubersuggest, …)
//   • DATA FRESHNESS — is the data we pulled recent? (the Auto-Pull extension heartbeat + Goodshuffle
//     routes/bookings freshness). This is the same signal the non-dismissible PullHealthBanner raises;
//     the summary surfaces it read-only so connection vs freshness never get conflated.
//
// The split keys off the existing ConnCategory: "Data pull" rows are freshness, everything else is
// connection health. No DB, no React — unit-testable in the node env.

import type { Connection, ConnStatus } from "@/lib/health/connections";
import type { Tone } from "@/lib/tone";

/** Map a connection status to a Spectrum tone (status indicator). "off"/"idle" are neutral — not broken;
 *  "attention" maps to the warning tone; "ok" is positive. */
export function connTone(status: ConnStatus): Tone {
  switch (status) {
    case "ok":
      return "positive";
    case "attention":
      return "attention";
    default:
      return "neutral"; // off (not connected) + idle (healthy, nothing to do) — neither is an error
  }
}

export interface IntegrationSplit {
  connections: Connection[]; // connection-health integrations (not data-pull)
  freshness: Connection[]; // data-pull freshness rows (extension heartbeat + routes/bookings)
}

/** Partition the connection rows into connection-health vs data-freshness, preserving input order. */
export function splitConnections(conns: Connection[]): IntegrationSplit {
  const connections: Connection[] = [];
  const freshness: Connection[] = [];
  for (const c of conns) (c.category === "Data pull" ? freshness : connections).push(c);
  return { connections, freshness };
}

/** How many rows need a human's attention (configured-but-broken). "off" (not connected yet) and "idle"
 *  are NOT counted as problems. */
export function attentionCount(conns: Connection[]): number {
  return conns.filter((c) => c.status === "attention").length;
}

/** The worst tone across a set of rows (attention beats everything; otherwise positive if any ok, else
 *  neutral). Drives the single indicator on the collapsed summary control. */
export function overallTone(conns: Connection[]): Tone {
  if (conns.some((c) => c.status === "attention")) return "attention";
  if (conns.some((c) => c.status === "ok")) return "positive";
  return "neutral";
}

/** A short headline for the collapsed summary, e.g. "All connected", "2 need attention", "Nothing connected". */
export function summaryHeadline(conns: Connection[]): string {
  const attention = attentionCount(conns);
  if (attention > 0) return `${attention} need${attention === 1 ? "s" : ""} attention`;
  const ok = conns.filter((c) => c.status === "ok").length;
  if (ok === 0) return "Nothing connected";
  return "All systems connected";
}
