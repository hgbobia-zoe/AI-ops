// Client-safe app configuration. Server-only secrets are read directly from
// process.env where they're used (db, ingest, notify) — never here.

export const appConfig = {
  name: process.env.NEXT_PUBLIC_APP_NAME ?? "Zoe Dispatch",
  /** Poll interval (ms) for refreshing the current route on the tablet. */
  routePollMs: 10_000,
  /** How often (ms) the kiosk auto re-pulls the route from Goodshuffle, so a change made
   *  in Goodshuffle (added/removed/rescheduled/re-addressed stop) flows into the app on
   *  its own. The import reconciles: it keeps started/finished stops and only refreshes the
   *  upcoming ones, so this never erases driver progress. */
  routeRepullMs: 5 * 60_000,
  /** localStorage keys. */
  storage: {
    truck: "aiops.truck",
    queue: "aiops.actionQueue",
  },
} as const;
