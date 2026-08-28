// Client-safe app configuration. Server-only secrets are read directly from
// process.env where they're used (db, ingest, notify) — never here.

export const appConfig = {
  name: process.env.NEXT_PUBLIC_APP_NAME ?? "Zoe Dispatch",
  /** Poll interval (ms) for refreshing the current route on the tablet. */
  routePollMs: 10_000,
  /** localStorage keys. */
  storage: {
    truck: "aiops.truck",
    queue: "aiops.actionQueue",
  },
} as const;
