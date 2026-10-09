// In-app GitHub PR review + merge. Lets a human review and merge pull requests from inside the app instead
// of going to GitHub. Server-only. The token (GITHUB_PR_TOKEN) should be a FINE-GRAINED PAT scoped to this
// one repo with ONLY "Pull requests: read/write" (+ "Contents: read") — enough to list and merge PRs, and
// deliberately NOT able to change branch protection, CODEOWNERS, or admin settings (audit gate 12: even if
// leaked, it cannot weaken the controls). The merge endpoint that uses this is HUMAN-ONLY (owner/admin
// cookie, never the AI's bridge token), so the agent can never merge its own PR through the app.

import { getSecret } from "@/lib/secrets";

const API = "https://api.github.com";

export function githubRepo(): string {
  return process.env.GITHUB_REPO || "hgbobia-zoe/AI-ops";
}
function token(): string {
  // Prefer the in-app secrets store (set via /admin, no redeploy) then the env/Fly secret.
  try {
    const s = getSecret("github.prToken");
    if (s) return s;
  } catch {
    /* secrets store unavailable (non-DB context) — fall through to env */
  }
  return process.env.GITHUB_PR_TOKEN || "";
}
export function githubMergeConfigured(): boolean {
  return !!token();
}

async function gh(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: Record<string, unknown> | Record<string, unknown>[] }> {
  const t = token();
  if (!t) return { ok: false, status: 0, data: { error: "no_token" } };
  try {
    const res = await fetch(`${API}/repos/${githubRepo()}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${t}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: String(e) } };
  }
}

export type PrChecks = "passing" | "failing" | "pending" | "none";

export interface PrSummary {
  number: number;
  title: string;
  url: string;
  draft: boolean;
  author: string | null;
  createdAt: string;
  headSha: string | null;
  /** GitHub's mergeable_state: clean | blocked | unstable | behind | dirty | draft | unknown. */
  mergeableState: string;
  checks: PrChecks;
}

/** Map GitHub's mergeable_state to a simple checks verdict for the UI. */
export function checksFromState(mergeableState: string): PrChecks {
  switch (mergeableState) {
    case "clean": return "passing";
    case "unstable": case "dirty": return "failing";
    case "blocked": case "behind": return "pending"; // needs review / out of date — not a hard CI fail
    default: return "none";
  }
}

/** List open PRs (newest first). Empty when the token isn't configured. */
export async function listOpenPrs(): Promise<PrSummary[]> {
  const r = await gh(`/pulls?state=open&sort=created&direction=desc&per_page=30`);
  if (!r.ok || !Array.isArray(r.data)) return [];
  return (r.data as Record<string, unknown>[]).map((p) => {
    const ms = String(p.mergeable_state ?? "unknown");
    return {
      number: Number(p.number),
      title: String(p.title ?? ""),
      url: String(p.html_url ?? ""),
      draft: Boolean(p.draft),
      author: (p.user as { login?: string } | undefined)?.login ?? null,
      createdAt: String(p.created_at ?? ""),
      headSha: (p.head as { sha?: string } | undefined)?.sha ?? null,
      mergeableState: ms,
      checks: checksFromState(ms),
    };
  });
}

export interface MergeResult {
  ok: boolean;
  sha?: string;
  error?: string;
  skipped?: boolean;
}

/** Merge a PR via the GitHub API. The caller MUST have already authorized a human (owner/admin). Returns a
 *  clear error when GitHub refuses (e.g. required checks not met) so the app can show why. */
export async function mergePr(number: number, method: "squash" | "merge" | "rebase" = "squash"): Promise<MergeResult> {
  if (!githubMergeConfigured()) return { ok: false, skipped: true, error: "GITHUB_PR_TOKEN not configured" };
  const r = await gh(`/pulls/${number}/merge`, { method: "PUT", body: JSON.stringify({ merge_method: method }) });
  if (r.ok) return { ok: true, sha: String((r.data as Record<string, unknown>).sha ?? "") };
  const msg = typeof (r.data as Record<string, unknown>).message === "string" ? String((r.data as Record<string, unknown>).message) : `merge failed (${r.status})`;
  return { ok: false, error: msg };
}
