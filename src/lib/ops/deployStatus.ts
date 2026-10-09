// In-app DEPLOY STATUS (server-only). Reports whether the LIVE build is up to date and healthy after any
// merge/push to main — so an operator never has to leave the app or open GitHub to see deployment state.
//
// Two sources, combined into one plain object the UI renders:
//   1. The LIVE build identity — read DIRECTLY from the deploy-stamped env (GIT_COMMIT / DEPLOYED_AT /
//      FLY_REGION), the same values /api/version exposes. We read env, never self-fetch.
//   2. GitHub — the latest commit on main and the most recent "Deploy" workflow run, read with a
//      read-only token (the same token the in-app PR panel uses). When there's no token, `configured` is
//      false and the card shows just the live version, no GitHub bits.
//
// This file deliberately does NOT import from src/lib/ai/github.ts (CODEOWNERS-protected). The ~3-line
// token read and the GitHub GET header shape are duplicated here on purpose. getDeployStatus() never
// throws; derivePhase() is PURE and unit-tested.

import { getSecret } from "@/lib/secrets";

const API = "https://api.github.com";

function repo(): string {
  return process.env.GITHUB_REPO || "hgbobia-zoe/AI-ops";
}

function token(): string {
  // Prefer the in-app secrets store (set via /admin, no redeploy) then the env/Fly secret — same order
  // as the PR panel, so connecting GitHub once lights up both.
  try {
    const s = getSecret("github.prToken");
    if (s) return s;
  } catch {
    /* secrets store unavailable (non-DB context) — fall through to env */
  }
  return process.env.GITHUB_PR_TOKEN || "";
}

/** A read-only GitHub GET. Never throws — any failure becomes a null result the caller treats as
 *  "unavailable". Returns parsed JSON (object or array) plus ok/status. */
async function ghGet(path: string): Promise<{ ok: boolean; status: number; data: unknown }> {
  const t = token();
  if (!t) return { ok: false, status: 0, data: null };
  try {
    const res = await fetch(`${API}/repos/${repo()}${path}`, {
      headers: {
        authorization: `Bearer ${t}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      cache: "no-store",
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

/** A loose commit match: one side must prefix the other (short vs full SHA). Unlike the controller's
 *  commitMatches, this returns null (unknown) — not a false-positive true — when either side is
 *  missing/unknown, so the UI never shows a misleading "behind" or "up to date". PURE. */
export function looseCommitMatch(a: string | null | undefined, b: string | null | undefined): boolean | null {
  const x = (a || "").trim();
  const y = (b || "").trim();
  if (!x || x === "unknown" || !y || y === "unknown") return null;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

export type DeployPhase = "deploying" | "deployed" | "behind" | "failed" | "unknown";

export interface LastDeployRun {
  status: string | null; // queued | in_progress | completed | ...
  conclusion: string | null; // success | failure | cancelled | null (still running)
  headSha: string | null;
  createdAt: string | null;
  htmlUrl: string | null;
}

export interface DeployStatus {
  configured: boolean;
  live: {
    commit: string;
    deployedAt: string | null;
    startedAt: string;
    region: string | null;
  };
  latestMainCommit: string | null;
  upToDate: boolean | null;
  lastDeploy: LastDeployRun | null;
  phase: DeployPhase;
  checkedAt: string;
}

export interface DerivePhaseInput {
  lastDeploy: LastDeployRun | null;
  upToDate: boolean | null;
}

/** Derive the single status label from (lastDeploy, upToDate). PURE so it can be unit-tested without
 *  network. Order matters: a run in flight wins (we're actively deploying), then a hard failure, then the
 *  up-to-date/behind split. Missing data → "unknown" rather than a confident wrong answer. */
export function derivePhase(input: DerivePhaseInput): DeployPhase {
  const { lastDeploy, upToDate } = input;

  // A Deploy run is queued or running right now.
  if (lastDeploy && (lastDeploy.status === "in_progress" || lastDeploy.status === "queued")) return "deploying";

  // The most recent completed run failed.
  if (lastDeploy && lastDeploy.status === "completed" && lastDeploy.conclusion === "failure") return "failed";

  // Live matches the latest commit on main and the last run succeeded → fully deployed & current.
  if (upToDate === true && lastDeploy && lastDeploy.status === "completed" && lastDeploy.conclusion === "success") {
    return "deployed";
  }

  // Main has a commit the live build doesn't have yet, and nothing is in flight → behind (deploy pending).
  if (upToDate === false) return "behind";

  // Up to date but no successful-run confirmation (e.g. GitHub runs unavailable): still current, so report
  // deployed rather than a misleading unknown.
  if (upToDate === true) return "deployed";

  return "unknown";
}

/** Build the deploy-status object the UI renders. Reads the live build from env (same values as
 *  /api/version) and, when a GitHub token is present, the latest main commit + last "Deploy" run. Never
 *  throws. */
export async function getDeployStatus(): Promise<DeployStatus> {
  const live = {
    commit: process.env.GIT_COMMIT || "unknown",
    deployedAt: process.env.DEPLOYED_AT || null,
    // The live deploy stamp is the best available "when this build went out" marker from env.
    startedAt: process.env.DEPLOYED_AT || new Date().toISOString(),
    region: process.env.FLY_REGION || null,
  };

  const configured = !!token();
  if (!configured) {
    return {
      configured: false,
      live,
      latestMainCommit: null,
      upToDate: null,
      lastDeploy: null,
      phase: "unknown",
      checkedAt: new Date().toISOString(),
    };
  }

  // Latest commit on main.
  let latestMainCommit: string | null = null;
  const mainRes = await ghGet(`/commits/main`);
  if (mainRes.ok && mainRes.data && typeof mainRes.data === "object" && !Array.isArray(mainRes.data)) {
    const sha = (mainRes.data as Record<string, unknown>).sha;
    if (typeof sha === "string" && sha) latestMainCommit = sha;
  }

  // Most recent run of the "Deploy" workflow (deploy.yml).
  let lastDeploy: LastDeployRun | null = null;
  const runsRes = await ghGet(`/actions/workflows/deploy.yml/runs?per_page=1`);
  if (runsRes.ok && runsRes.data && typeof runsRes.data === "object") {
    const runs = (runsRes.data as Record<string, unknown>).workflow_runs;
    if (Array.isArray(runs) && runs.length > 0) {
      const r = runs[0] as Record<string, unknown>;
      lastDeploy = {
        status: typeof r.status === "string" ? r.status : null,
        conclusion: typeof r.conclusion === "string" ? r.conclusion : null,
        headSha: typeof r.head_sha === "string" ? r.head_sha : null,
        createdAt: typeof r.created_at === "string" ? r.created_at : null,
        htmlUrl: typeof r.html_url === "string" ? r.html_url : null,
      };
    }
  }

  const upToDate = looseCommitMatch(live.commit, latestMainCommit);
  const phase = derivePhase({ lastDeploy, upToDate });

  return {
    configured: true,
    live,
    latestMainCommit,
    upToDate,
    lastDeploy,
    phase,
    checkedAt: new Date().toISOString(),
  };
}
