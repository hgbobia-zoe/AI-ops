// Opportunity Radar — the scheduled discovery cycle (runtime job "opportunity-radar"). Runs on the
// in-process runtime clock, so no public endpoint or token is involved. Each source has its own cadence,
// kept in kv, so the 15 minute clock never over-spends a quota:
//   • SAM.gov (federal): every RADAR_SAM_INTERVAL_HOURS (default 24; a key without a federal role gets
//     about 10 calls a day, and one pass costs up to RADAR_SAM_MAX_CALLS, default 3).
//   • ICS event calendars: every RADAR_ICS_INTERVAL_HOURS (default 6).
// After any pull it bridges events into the opportunity layer and re-matches entities to customers.
// Idempotent (every store upserts by a stable key) and never throws. A failing source reports ok=false so
// /automation and /admin show it red, and alerts ops once (throttled) instead of failing silently.

import { getJson, setJson } from "@/lib/kv";
import { alertOps } from "@/lib/notify/alert";
import { runOpportunitySource } from "./ingest";
import { syncEventOpportunities } from "./eventBridge";
import { enrichEntityMatches } from "./relationship";
import { registerSources } from "./seed";
import { samGovConfigured, samGovSource, lastSamRun } from "./sources/samgov";
import { runSource } from "@/lib/radar/ingest";
import { configuredIcsSources, icsFeedsConfigured } from "@/lib/radar/sources/ics";

export const RADAR_JOB_KEY = "opportunity-radar";
const STATE_KEY = "radar.cycle.lastRun";

interface CycleState {
  samAt?: string;
  icsAt?: string;
}

/** The job is configured when at least one live source has its credential / config. */
export function radarCycleConfigured(): boolean {
  return samGovConfigured() || icsFeedsConfigured();
}

const hours = (env: string, dflt: number) => {
  const n = Number(process.env[env]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

/** PURE. Is a source due, given when it last ran and its interval? */
export function isDue(lastAt: string | undefined, intervalHours: number, now: Date): boolean {
  if (!lastAt) return true;
  const t = Date.parse(lastAt);
  return !Number.isFinite(t) || now.getTime() - t >= intervalHours * 3_600_000;
}

export async function runRadarCycle(now: Date = new Date()): Promise<{ ok: boolean; detail: string }> {
  const state = getJson<CycleState>(STATE_KEY, {});
  const parts: string[] = [];
  const failures: string[] = [];
  let pulled = false;

  try {
    registerSources(now);
  } catch {
    /* registry refresh is best effort */
  }

  if (samGovConfigured() && isDue(state.samAt, hours("RADAR_SAM_INTERVAL_HOURS", 24), now)) {
    const res = await runOpportunitySource(samGovSource({ now }), now);
    const rep = lastSamRun();
    state.samAt = now.toISOString(); // attempted: even a failure waits a full interval (quota)
    pulled = true;
    const note = rep ? `${rep.calls} calls, ${rep.fetched} fetched, ${rep.kept} relevant${rep.complete ? "" : ", more to read next run"}` : "";
    parts.push(`SAM.gov: ${res.stored} stored, ${res.changes} changes${note ? ` (${note})` : ""}`);
    const errs = [...res.errors, ...(rep?.errors ?? [])];
    if (errs.length) failures.push(`SAM.gov: ${[...new Set(errs)].join("; ").slice(0, 300)}`);
  } else if (!samGovConfigured()) {
    parts.push("SAM.gov off (SAM_API_KEY not set)");
  }

  if (icsFeedsConfigured() && isDue(state.icsAt, hours("RADAR_ICS_INTERVAL_HOURS", 6), now)) {
    let stored = 0;
    for (const s of configuredIcsSources()) {
      try {
        const r = await runSource(s, now);
        stored += r.stored;
        if (r.errors.length) failures.push(`${s.name}: ${r.errors.join("; ").slice(0, 200)}`);
      } catch (e) {
        failures.push(`${s.name}: ${(e as Error).message}`);
      }
    }
    state.icsAt = now.toISOString();
    pulled = true;
    parts.push(`Event calendars: ${stored} stored`);
  } else if (!icsFeedsConfigured()) {
    parts.push("Event calendars off (RADAR_ICS_FEEDS not set)");
  }

  if (pulled) {
    try {
      const bridged = syncEventOpportunities(now);
      if (bridged) parts.push(`${bridged} events bridged`);
    } catch (e) {
      failures.push(`bridge: ${(e as Error).message}`);
    }
    try {
      enrichEntityMatches();
    } catch {
      /* non-fatal */
    }
  }
  setJson(STATE_KEY, state);

  if (failures.length) {
    await alertOps("Opportunity Radar discovery", failures.join(" | ")).catch(() => {});
    return { ok: false, detail: [...parts, `FAILED: ${failures.join(" | ")}`].join(". ") };
  }
  return { ok: true, detail: pulled ? parts.join(". ") : `nothing due. ${parts.join(". ")}`.trim() };
}
