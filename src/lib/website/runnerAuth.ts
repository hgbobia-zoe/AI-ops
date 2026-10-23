// Website Studio — office-runner endpoint auth. The runner (tools/website-studio-runner) authenticates with
// the shared WEBSITE_RUNNER_TOKEN in the `x-website-runner-token` header. Unlike the gs_outbox ingest
// endpoints (which fail OPEN until their token is set), these fail CLOSED: with the token env unset the
// runner endpoints return 503, so no job is ever claimed or completed until an operator deliberately
// configures the token. This is a code-editing pipeline driven by non-engineers — it must be off by default.

export type RunnerAuth = "ok" | "unconfigured" | "forbidden";

/** Constant-ish comparison of the presented token against WEBSITE_RUNNER_TOKEN. PURE given the env.
 *  - "unconfigured": the token env is unset → caller should 503 (fail-closed, nothing runs).
 *  - "ok":           a non-empty token matching the env.
 *  - "forbidden":    env set but the token is missing/wrong → caller should 401. */
export function checkRunnerToken(token: string | null | undefined): RunnerAuth {
  const expected = process.env.WEBSITE_RUNNER_TOKEN;
  if (!expected) return "unconfigured";
  if (typeof token === "string" && token.length > 0 && token === expected) return "ok";
  return "forbidden";
}
