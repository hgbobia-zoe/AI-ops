// Instawork read boundary. As of the browser-pull switch, the server NEVER calls Instawork (Cloudflare /
// datacenter-IP block risk, same as Goodshuffle). The Auto-Pull browser extension fetches the gig groups
// same-origin inside a logged-in app.instawork.com tab and POSTs them to /api/instawork/import, which saves
// the snapshot. This module just READS that snapshot — no network, no cookie. HONEST: no snapshot yet →
// not_configured (never fabricated); present → ok with the stored shifts + the browser's fetch time.

import { readInstaworkSnapshot } from "./store";
import type { InstaworkResult } from "./types";

/** True once the browser pull has stored at least one snapshot. */
export function instaworkConfigured(): boolean {
  return readInstaworkSnapshot() !== null;
}

/**
 * The latest browser-pulled Instawork shifts. Never throws, never calls Instawork. A stored snapshot →
 * ok; nothing pulled yet → not_configured (never treat empty as "nothing booked"). The `timeframe`
 * argument is kept for signature compatibility but is unused (the browser pull decides the timeframe).
 */
export async function getInstaworkShifts(_timeframe = "in_progress_upcoming"): Promise<InstaworkResult> {
  void _timeframe;
  const snap = readInstaworkSnapshot();
  if (!snap) return { ok: false, status: "not_configured", shifts: [], fetchedAt: new Date().toISOString() };
  return { ok: true, status: "ok", shifts: snap.shifts, fetchedAt: snap.fetchedAt };
}
