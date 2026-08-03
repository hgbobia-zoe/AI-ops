// Central configuration. Server-only secrets are read lazily inside functions so
// they never leak into the client bundle. Anything the browser needs must be a
// NEXT_PUBLIC_* var referenced directly.

/** Server-side config. Never import these values into a client component. */
export const serverConfig = {
  /**
   * Zapier Catch Hook URL that receives VALIDATED action events for fan-out.
   * When unset (e.g. local dev before Zapier is wired), the intake accepts and
   * logs the action but does not forward — so the whole UI is testable offline.
   */
  zapierForwardUrl: () => process.env.ZAPIER_FORWARD_URL ?? "",

  /** Shared secret used to HMAC-sign forwards to Zapier (verified in a Zap code step). */
  webhookSecret: () => process.env.WEBHOOK_SECRET ?? "",

  /** Optional Zapier Tables REST credentials for reading live route data. */
  zapierTablesApiKey: () => process.env.ZAPIER_TABLES_API_KEY ?? "",
  routesTableId: () => process.env.ZAPIER_ROUTES_TABLE_ID ?? "",
  stopsTableId: () => process.env.ZAPIER_STOPS_TABLE_ID ?? "",

  /** When true, /api/route serves in-memory mock data (M1 before real ingestion). */
  useMockData: () =>
    process.env.USE_MOCK_DATA === "true" ||
    !process.env.ZAPIER_TABLES_API_KEY,
};

/** Client-safe constants. */
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
