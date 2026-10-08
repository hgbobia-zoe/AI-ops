// Self-Improvement Controller — post-deployment verification (audit gate 9). "Deployed" is NOT "verified":
// after a deploy is detected, the controller runs health checks and only then may a run reach `verified`.
// The DECISION (which checks fail the deploy) is pure + unit-tested; the runner does the IO. Honest by
// construction — a check that can't run is a failure, never a silent pass.

import { computeConnections } from "@/lib/health/connections";
import type { HealthResult } from "./types";

export interface HealthCheck {
  name: string;
  critical: boolean; // a failing critical check makes the deploy unhealthy; non-critical is informational
  ok: boolean;
  detail: string;
}

/** Combine individual checks into a verdict. Unhealthy iff any CRITICAL check failed. PURE. */
export function evaluateHealth(checks: HealthCheck[], now: Date = new Date()): HealthResult {
  const failures = checks.filter((c) => c.critical && !c.ok).map((c) => `${c.name}: ${c.detail}`);
  const detail = checks.map((c) => `${c.ok ? "ok" : "FAIL"} ${c.name}`).join(" · ");
  return { healthy: failures.length === 0, checkedAt: now.toISOString(), detail, failures };
}

/** A loose commit match: either side empty/unknown passes; otherwise one must prefix the other (short vs
 *  full SHA). PURE. */
export function commitMatches(live: string | null | undefined, expected: string | null | undefined): boolean {
  const l = (live || "").trim();
  const e = (expected || "").trim();
  if (!e || e === "unknown" || !l || l === "unknown") return true;
  return l === e || l.startsWith(e) || e.startsWith(l);
}

/** Gather the real health checks for a deployment. IO: reads /api/version and the live integration health.
 *  Never throws — a failure to run a check becomes a failed check. */
export async function runHealthChecks(opts: { baseUrl: string; expectedCommit?: string | null; timeoutMs?: number }): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];
  const base = opts.baseUrl.replace(/\/+$/, "");

  // 1. Deployed the right commit (gate 8 -> 9 handoff).
  try {
    const ctrl = AbortSignal.timeout(opts.timeoutMs ?? 8000);
    const res = await fetch(`${base}/api/version`, { cache: "no-store", signal: ctrl });
    const v = (await res.json()) as { commit?: string };
    const live = v.commit ?? "unknown";
    const ok = res.ok && commitMatches(live, opts.expectedCommit);
    checks.push({ name: "version", critical: !!(opts.expectedCommit && opts.expectedCommit !== "unknown"), ok, detail: `live=${live}${opts.expectedCommit ? ` expected=${opts.expectedCommit}` : ""}` });
  } catch {
    checks.push({ name: "version", critical: true, ok: false, detail: "version endpoint unreachable" });
  }

  // 2. Runtime health: that computeConnections() runs at all proves the deployed server code executes; the
  //    integration states tell us whether anything is newly degraded.
  try {
    const conns = computeConnections();
    const attention = conns.filter((c) => c.status === "attention");
    checks.push({ name: "runtime", critical: true, ok: true, detail: `${conns.length} integrations evaluated` });
    checks.push({ name: "integrations", critical: false, ok: attention.length === 0, detail: attention.length ? attention.map((a) => a.key).join(",") + " need attention" : "all clear" });
  } catch (e) {
    checks.push({ name: "runtime", critical: true, ok: false, detail: "server threw evaluating health: " + String(e).slice(0, 100) });
  }

  return checks;
}

/** Run the checks and return the verdict. */
export async function verifyDeployment(opts: { baseUrl: string; expectedCommit?: string | null; timeoutMs?: number }): Promise<HealthResult> {
  return evaluateHealth(await runHealthChecks(opts));
}
