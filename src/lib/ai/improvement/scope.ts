// Self-Improvement Controller — the scope gate (audit gate 1, and gate 12 at the file level). The
// controller decides whether a changed path is in scope; the AI does not. A run declares allowedPaths and
// forbiddenPaths, but on TOP of that there is an ALWAYS-FORBIDDEN set — the agent's own safety controls —
// that no request scope can ever open. Touching those (or anything outside the allowed set) trips the run.
// PURE (string/prefix logic only) — fully unit-tested.

import type { RunScope } from "./types";

// The agent's own guardrails. A self-improvement run may NEVER modify these, whatever its declared scope —
// this is the file-level half of "the agent cannot weaken its own safety controls" (CODEOWNERS is the
// review-level half). Paths are matched as prefixes against repo-relative, forward-slash paths.
export const ALWAYS_FORBIDDEN_PATHS: string[] = [
  ".github/", //                       CI/CD + CODEOWNERS + the merge gate
  "src/lib/auth/", //                  authn/authz
  "src/lib/aiorg/approvals.ts", //     the execution gate
  "src/lib/ai/provider.ts", //         the AI provider seam
  "src/lib/ai/improvement/", //        the self-improvement controller itself (scope/budget/machine/service)
  "src/lib/ai/sessions.ts",
  "src/lib/ai/requests.ts",
  "src/lib/ai/github.ts", //            the in-app merge mechanism (holds the GitHub token)
  "src/app/api/ai/bridge/",
  "src/app/api/ai/requests/",
  "src/app/api/ai/improvement/",
  "src/app/api/ai/github/",
  "docs/ai-bridge-responder.md", //    the responder contract
  "Dockerfile",
  "fly.toml",
  "vitest.config.ts",
];

/** Normalize a path to repo-relative, forward slashes, no leading "./" or "/". PURE. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").trim();
}

function matchesAny(path: string, prefixes: string[]): string | null {
  const norm = normalizePath(path);
  for (const pre of prefixes) {
    const p = normalizePath(pre);
    if (norm === p || norm.startsWith(p.endsWith("/") ? p : p + (p.includes(".") ? "" : "/")) || norm.startsWith(p)) {
      return pre;
    }
  }
  return null;
}

/** Is this path one of the agent's always-forbidden safety controls? PURE. */
export function isAlwaysForbidden(path: string): boolean {
  return matchesAny(path, ALWAYS_FORBIDDEN_PATHS) !== null;
}

/** Is a single path allowed under this run's scope? Always-forbidden wins over everything; then an explicit
 *  forbiddenPath; then it must sit under an allowedPath. PURE. */
export function pathInScope(path: string, scope: RunScope): boolean {
  if (isAlwaysForbidden(path)) return false;
  if (matchesAny(path, scope.forbiddenPaths)) return false;
  return matchesAny(path, scope.allowedPaths) !== null;
}

export interface ScopeCheck {
  ok: boolean;
  /** Paths that violated scope, each with why. */
  violations: { path: string; reason: "always_forbidden" | "forbidden" | "out_of_scope" }[];
}

/** Check a set of changed paths against the run's scope. PURE. Returns every violation, classified. */
export function checkScope(changedPaths: string[], scope: RunScope): ScopeCheck {
  const violations: ScopeCheck["violations"] = [];
  for (const raw of changedPaths) {
    const path = normalizePath(raw);
    if (!path) continue;
    if (isAlwaysForbidden(path)) violations.push({ path, reason: "always_forbidden" });
    else if (matchesAny(path, scope.forbiddenPaths)) violations.push({ path, reason: "forbidden" });
    else if (matchesAny(path, scope.allowedPaths) === null) violations.push({ path, reason: "out_of_scope" });
  }
  return { ok: violations.length === 0, violations };
}
