// Cloud runtime — the registry of integration jobs and the server-side runner. The goal: run every
// integration UNATTENDED from the cloud (Fly), scheduled by GitHub Actions (an off-machine clock), so
// nothing depends on the office machine being on. Each job declares its "bucket":
//   • server  — the Fly server can reach it directly (API/cookie). The runtime runs these.
//   • browser — blocked from datacenter IPs (Goodshuffle/Cloudflare). Needs a logged-in browser; today
//               the office extension, later a cloud browser behind a residential proxy. The runtime does
//               NOT run these server-side — it only surfaces their freshness so the gap is visible.
//
// Runs are recorded in the existing import ledger (logImport) so status reuses /admin/health's data —
// no new table. HONEST: a job with no credential is skipped and shown as "not configured", never faked.

import { getInstaworkShifts, instaworkConfigured } from "@/lib/instawork/client";
import { runInstaworkMonitor } from "@/lib/instawork/monitor";
import { slackNotify } from "@/lib/notify/slack";
import { discover } from "@/lib/seo/discovery";
import { configured as ubersuggestConfigured } from "@/lib/seo/ubersuggest";
import { connecteamConfigured, refreshConnecteamHealth } from "@/lib/connecteam";
import { logImport, getLatestImportBySource, type ImportRow } from "@/lib/pull/state";

export type RuntimeBucket = "server" | "browser";

export interface RuntimeJob {
  key: string; // also the import-ledger source key
  label: string;
  bucket: RuntimeBucket;
  configured: () => boolean;
  note?: string;
  /** Present for server jobs; returns a success flag + a short human detail. */
  run?: () => Promise<{ ok: boolean; detail: string }>;
}

export const RUNTIME_JOBS: RuntimeJob[] = [
  {
    key: "instawork",
    label: "Instawork shifts",
    bucket: "server",
    configured: instaworkConfigured,
    note: "Reads booked temp-labor shifts (cookie auth).",
    run: async () => {
      const r = await getInstaworkShifts();
      if (!r.ok) return { ok: false, detail: r.error ?? r.status };
      // Monitor for no-shows / drop-offs: a booked worker disappearing near/after a gig's start →
      // Slack. (Instawork's API has no no-show field; a removed worker is the signal.)
      const alerts = runInstaworkMonitor(r.shifts);
      for (const a of alerts) await slackNotify(a);
      return { ok: true, detail: `${r.shifts.length} shifts${alerts.length ? ` · ${alerts.length} drop alert${alerts.length === 1 ? "" : "s"}` : ""}` };
    },
  },
  {
    key: "ubersuggest",
    label: "Ubersuggest discovery (SEO)",
    bucket: "server",
    configured: ubersuggestConfigured,
    note: "Pulls keyword opportunities for the SEO engine.",
    run: async () => {
      const r = await discover();
      if (!r.configured) return { ok: false, detail: "not configured" };
      return { ok: r.errors === 0, detail: `${r.created} new, ${r.updated} updated${r.errors ? `, ${r.errors} errors` : ""}` };
    },
  },
  {
    key: "connecteam",
    label: "Connecteam crew",
    bucket: "server",
    configured: connecteamConfigured,
    note: "Confirms the crew schedule is reachable.",
    run: async () => {
      const h = await refreshConnecteamHealth();
      return { ok: h.ok, detail: h.detail };
    },
  },
  {
    key: "route",
    label: "Goodshuffle routes + bookings",
    bucket: "browser",
    configured: () => true,
    note: "Cloudflare blocks datacenter IPs — runs from a logged-in browser (office extension today; cloud browser behind a residential proxy is the planned cloud-runtime path).",
  },
];

export interface JobRunResult {
  key: string;
  ok: boolean;
  detail: string;
  ms: number;
}

/** Run every CONFIGURED server job once, recording each to the import ledger. Never throws. */
export async function runServerJobs(): Promise<JobRunResult[]> {
  const out: JobRunResult[] = [];
  for (const job of RUNTIME_JOBS) {
    if (job.bucket !== "server" || !job.run || !job.configured()) continue;
    const t = Date.now();
    try {
      const r = await job.run();
      logImport(job.key, r.ok, { detail: r.detail });
      out.push({ key: job.key, ok: r.ok, detail: r.detail, ms: Date.now() - t });
    } catch (e) {
      const detail = e instanceof Error ? e.message : "error";
      logImport(job.key, false, { detail });
      out.push({ key: job.key, ok: false, detail, ms: Date.now() - t });
    }
  }
  return out;
}

export type JobState = "ok" | "stale" | "error" | "not_configured" | "browser_pending" | "never";

export interface JobStatus {
  key: string;
  label: string;
  bucket: RuntimeBucket;
  configured: boolean;
  state: JobState;
  lastRunAt: string | null;
  lastDetail: string | null;
  note?: string;
}

/** Hours after which a successful server job is considered stale (for the status view). */
export const RUNTIME_STALE_HOURS = 24;

/**
 * Current status of every job, from the credential state + the import ledger. Pure given `ledger`+`now`,
 * so it's unit-testable. Browser jobs report their own freshness but are flagged browser_pending (the
 * runtime can't run them server-side yet).
 */
export function computeJobStatus(
  ledger: Record<string, ImportRow>,
  now: number = Date.now(),
  jobs: RuntimeJob[] = RUNTIME_JOBS,
): JobStatus[] {
  return jobs.map((job) => {
    const row = ledger[job.key] ?? null;
    const lastRunAt = row?.ts ?? null;
    const lastDetail = row?.detail ?? null;
    const ageH = lastRunAt ? (now - Date.parse(lastRunAt)) / 3_600_000 : Infinity;
    const configured = job.configured();

    let state: JobState;
    if (job.bucket === "browser") state = "browser_pending";
    else if (!configured) state = "not_configured";
    else if (!row) state = "never";
    else if (!row.ok) state = "error";
    else if (ageH > RUNTIME_STALE_HOURS) state = "stale";
    else state = "ok";

    return { key: job.key, label: job.label, bucket: job.bucket, configured, state, lastRunAt, lastDetail, note: job.note };
  });
}

/** Convenience: status from the live ledger. */
export function runtimeStatus(): JobStatus[] {
  return computeJobStatus(getLatestImportBySource());
}
