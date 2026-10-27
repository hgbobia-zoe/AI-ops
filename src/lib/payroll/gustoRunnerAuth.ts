// Gusto remote-browser push — office-runner endpoint auth. The runner (tools/gusto-runner) authenticates with
// the shared GUSTO_RUNNER_TOKEN in the `x-gusto-runner-token` header. Like the Website Studio runner endpoints
// (and UNLIKE the fail-OPEN gs_outbox ingest), these fail CLOSED: with the token env unset the runner
// endpoints return 503, so no push job is ever claimed or reported until an operator deliberately configures
// the token. This drives a WRITE into real payroll from the office machine — it must be off by default.

export type RunnerAuth = "ok" | "unconfigured" | "forbidden";

/** Compare the presented token against GUSTO_RUNNER_TOKEN. PURE given the env.
 *  - "unconfigured": the token env is unset → caller should 503 (fail-closed, nothing runs).
 *  - "ok":           a non-empty token matching the env.
 *  - "forbidden":    env set but the token is missing/wrong → caller should 401. */
export function checkGustoRunnerToken(token: string | null | undefined): RunnerAuth {
  const expected = process.env.GUSTO_RUNNER_TOKEN;
  if (!expected) return "unconfigured";
  if (typeof token === "string" && token.length > 0 && token === expected) return "ok";
  return "forbidden";
}

/** Is the in-app remote-browser push path configured on this deployment? The /payroll UI uses this to decide
 *  whether to offer "Push from the app" (runner) vs the extension fallback. */
export function gustoRunnerConfigured(): boolean {
  return !!process.env.GUSTO_RUNNER_TOKEN;
}
