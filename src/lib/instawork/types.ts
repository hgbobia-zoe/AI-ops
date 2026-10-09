// Instawork — temp-labor shift data pulled from the business dashboard's internal API. Zoe books
// Drivers + General Labor here to top up the internal crew. We READ these shifts to reconcile them
// against the app's schedule + routes (is a gap already covered by a booked Instawork gig?). Posting a
// gig is a separate, paid action captured/built later. FACTS ONLY: unknowns stay null, never 0.

/** One Instawork shift group (= a position booked for a day), from GET /api/partner/gigs/groups/. */
export interface InstaworkShift {
  id: string;
  name: string; // the gig label, e.g. "ZER"
  startsAt: string; // ISO instant
  endsAt: string; // ISO instant
  timezone: string; // e.g. "America/New_York"
  position: string; // "Driver" | "General Labor"
  basePrice: number | null; // pay rate (dollars), null when unknown
  filled: number; // filled_shifts_count
  total: number; // total_shifts_count
  locationName: string | null;
  workers: string[]; // assigned worker names
  workerIds: string[]; // assigned worker ids (stable handle, parallel to workers)
  interestedPending: number; // interested pros not yet booked
  // Per-gig clock codes (shared by that gig's workers). null when Instawork didn't send them (FACTS ONLY).
  clockInCode: string | null;
  clockOutCode: string | null;
}

export type InstaworkHealthStatus = "not_configured" | "ok" | "error";

export interface InstaworkResult {
  /** True only when Instawork actually answered. false = not configured OR unreachable (UNVERIFIED —
   *  never treat empty shifts as "nothing booked"). */
  ok: boolean;
  status: InstaworkHealthStatus;
  shifts: InstaworkShift[];
  error?: string;
  fetchedAt: string;
}
