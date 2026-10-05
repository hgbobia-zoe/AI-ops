// Server side of the office-machine Ignition etaLink mint: geocode the stop, enqueue a mint request for
// the extension to replay, and (when a signed-in Ignition tab is minting) do a BOUNDED WAIT for the live
// link so the "on the way" SMS can carry the real Ignition map URL. Pure request/URL/selection logic
// lives in ./etaLinkMint; this module is the IO glue (geocode + DB + timing).
//
// Timing design (see also the design note in notify/fanout.ts):
//   • We ALWAYS enqueue the mint and ALWAYS have the /track fallback ready, so the customer never gets a
//     dead or fabricated link.
//   • We only BLOCK the text waiting for the Ignition link when a signed-in Ignition poller is active
//     (etaLinkPollerReady). The extension's Ignition content script polls every ~15s, so a mint lands in
//     ~15-45s; we early-return the instant it does. When no poller is signed in, we DON'T wait at all —
//     the text goes out immediately with /track, and /track upgrades to the Ignition map if the mint
//     lands later. A slightly delayed-but-correct link beats a dead one; an unconfigured office never
//     pays the delay.

import { geocode } from "./geo";
import { computeLiveEta } from "./liveEta";
import { shiftWindowHours } from "./etaLinkMint";
import { enqueueEtaLinkMint, getMintedEtaLinkForStop, getEtaLinkStateForStop } from "@/lib/db/repo";
import { etaLinkPollerReady } from "@/lib/pull/state";
import type { Stop } from "@/lib/types";

const WAIT_MS = Math.max(0, Number(process.env.ETA_LINK_MINT_WAIT_MS || 45000));
const POLL_MS = Math.max(500, Number(process.env.ETA_LINK_MINT_POLL_MS || 2500));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Mint (or reuse) an Ignition etaLink for a stop and return its public live-map URL, or null if it
 * isn't available in time (caller falls back to /track). Honest: never returns a fabricated link.
 *
 * @param truckLabel the Ignition unit label to resolve at runtime (e.g. "Ford E450")
 */
export async function mintEtaLinkForStop(
  stop: Stop,
  truckId: string,
  truckLabel: string,
): Promise<string | null> {
  // Feature escape hatch: ETA_LINK_MINT=0 disables minting entirely (pure /track — the prior behavior).
  if (process.env.ETA_LINK_MINT === "0") return null;
  if (!stop.address) return null;

  const coords = await geocode(stop.address).catch(() => null);
  if (!coords) return null; // no coordinates → createEtaLink can't run; /track stays the link

  // Rough initial ETA (hours) best-effort from live GPS; the Ignition page recomputes live anyway.
  let etaHours: number | null = null;
  try {
    const live = await computeLiveEta(truckId, stop);
    if (live && live.minutesAway > 0) etaHours = live.minutesAway / 60;
  } catch {
    /* no live fix → omit the initial estimate */
  }

  const now = Date.now();
  const startISO = new Date(now).toISOString();
  const endISO = new Date(now + shiftWindowHours() * 3600 * 1000).toISOString();

  const state = enqueueEtaLinkMint({
    stopId: stop.stopId,
    routeId: stop.routeId,
    truckId,
    truckLabel,
    address: stop.address,
    lat: coords.lat,
    lng: coords.lng,
    etaHours,
    startISO,
    endISO,
  });

  // Reused an already-minted link → send it now.
  if (state.status === "minted" && state.url) return state.url;

  // Only wait if a signed-in Ignition tab is actively minting; otherwise send /track now (it upgrades).
  if (WAIT_MS <= 0 || !etaLinkPollerReady()) return null;

  const deadline = now + WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const minted = getMintedEtaLinkForStop(stop.stopId);
    if (minted?.url) return minted.url;
    const cur = getEtaLinkStateForStop(stop.stopId);
    if (cur?.status === "error") return null; // failed fast — don't block the text
  }
  return null;
}
