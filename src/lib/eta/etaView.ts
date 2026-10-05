// How to present an ETA honestly. Real live GPS/ETA is PRIMARY; when the live fetch
// genuinely fails (unit offline, rate-limit backoff, geocode miss) we keep showing the
// planned ETA from Goodshuffle's schedule — but the caller must LABEL it as an estimate,
// never dress it up as a live fix. We never fabricate a position: a map pin is only drawn
// when `live.truck` holds a real coordinate.
//
// This is pure decision logic shared by the customer /track page and the driver tile so
// both fall back identically. RULES CALCULATE — no model, no guessing.

export type EtaPresentation =
  | { mode: "live" } // a real live fix exists and the truck is en route — show the big live treatment
  | { mode: "scheduled"; liveUnavailable: boolean } // show the planned ETA, labeled; liveUnavailable = we expected live but have none
  | { mode: "none" }; // nothing worth showing (completed, or no ETA at all)

export function presentEta(opts: {
  enRoute: boolean; // the stop is in the EnRoute state (when we try for a live fix)
  hasLiveFix: boolean; // computeLiveEta returned a real fix for this stop
  hasPlannedEta: boolean; // the stop carries a planned ETA from the schedule
  completed?: boolean; // the stop is already delivered — no ETA needed
}): EtaPresentation {
  if (opts.enRoute && opts.hasLiveFix) return { mode: "live" };
  if (opts.completed || !opts.hasPlannedEta) return { mode: "none" };
  // Planned ETA is still true information. If the truck is en route, a live fix was expected and is
  // momentarily missing, so flag that; otherwise it is simply the scheduled arrival.
  return { mode: "scheduled", liveUnavailable: opts.enRoute };
}
