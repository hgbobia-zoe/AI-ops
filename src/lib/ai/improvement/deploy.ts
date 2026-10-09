// Self-Improvement Controller — deployment DETECTION (audit gate 8). Read-only: the controller never holds
// Fly deploy credentials (that would let the agent ship arbitrary code — audit gate 12). Deployment is
// performed by CI (deploy.yml, which holds the token); here the controller only OBSERVES, by reading the
// public /api/version and comparing the live commit to the one it merged.

import { commitMatches } from "./verify";

export interface DeployStatus {
  reachable: boolean; //  did /api/version respond?
  live: boolean; //       is the app serving?
  liveCommit: string; //  the commit currently deployed
  matches: boolean; //    does the live commit match the expected (merged) one?
  startedAt: string | null;
}

/** Observe the live deployment. Never throws — an unreachable app is reported, not raised. */
export async function detectDeployment(opts: { baseUrl: string; expectedCommit?: string | null; timeoutMs?: number }): Promise<DeployStatus> {
  const base = opts.baseUrl.replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/api/version`, { cache: "no-store", signal: AbortSignal.timeout(opts.timeoutMs ?? 8000) });
    const v = (await res.json()) as { commit?: string; startedAt?: string };
    const liveCommit = v.commit ?? "unknown";
    return { reachable: res.ok, live: res.ok, liveCommit, matches: commitMatches(liveCommit, opts.expectedCommit), startedAt: v.startedAt ?? null };
  } catch {
    return { reachable: false, live: false, liveCommit: "unknown", matches: false, startedAt: null };
  }
}
