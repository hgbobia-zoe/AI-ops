// Opportunity Radar — source registry + page-load refresh. NO demo data: the owner asked to remove all mock
// data (2026-11-07). Radar shows only real records (CSV imports, live SAM.gov / ICS pulls, browser
// captures, conversions). Earlier versions seeded is_seed=1 rows; purgeDemoDataOnce() deletes them.
// (File name kept so existing imports stay stable.)

import { getDb } from "@/lib/db";
import { syncEventOpportunities } from "./eventBridge";
import { enrichEntityMatches } from "./relationship";
import { samGovConfigured } from "./sources/samgov";
import { BROWSER_WORKFLOWS } from "./sources/browser";
import { icsFeedsFromEnv } from "@/lib/radar/sources/ics";
import { purgeDemoDataOnce } from "./demoPurge";

// ── Source registry ───────────────────────────────────────────────────────────────────────────────
interface SourceRow {
  id: string; name: string; kind: string; url: string | null; region: string; enabled: number;
  acquisition_method: string; auth_status: string; frequency: string; adapter: string | null; is_seed: number;
}

export function registerSources(now: Date): void {
  const db = getDb();
  const ts = now.toISOString();
  const rows: SourceRow[] = [
    { id: "samgov-federal", name: "SAM.gov — federal solicitations", kind: "FEDERAL_API", url: "https://sam.gov", region: "FEDERAL", enabled: 1, acquisition_method: "API", auth_status: samGovConfigured() ? "REQUIRED_OK" : "REQUIRED_MISSING", frequency: "daily", adapter: "samgov", is_seed: 0 },
  ];
  for (const w of BROWSER_WORKFLOWS) {
    rows.push({ id: w.sourceId, name: w.name, kind: "GOV_PORTAL", url: w.portalUrl, region: w.jurisdiction, enabled: 1, acquisition_method: "BROWSER", auth_status: "NONE", frequency: "weekly", adapter: `browser:${w.sourceId}`, is_seed: 0 });
  }
  // ICS / iCal event feeds. One row per configured feed; when none are set, a single dormant row documents
  // the blocker right in the registry.
  const feeds = icsFeedsFromEnv();
  if (feeds.length > 0) {
    for (const f of feeds) {
      rows.push({ id: f.id, name: f.name, kind: "ICS_FEED", url: f.url, region: f.region ?? "DMV", enabled: 1, acquisition_method: "API", auth_status: "REQUIRED_OK", frequency: "daily", adapter: "ics", is_seed: 0 });
    }
  } else {
    rows.push({ id: "ics-events", name: "Public event calendars (ICS/iCal)", kind: "ICS_FEED", url: null, region: "DMV", enabled: 0, acquisition_method: "API", auth_status: "REQUIRED_MISSING", frequency: "daily", adapter: "ics", is_seed: 0 });
  }
  const stmt = db.prepare(
    `INSERT INTO radar_sources (id, name, kind, url, region, enabled, adapter, acquisition_method, auth_status, frequency, last_status, is_seed, created_at)
     VALUES (@id,@name,@kind,@url,@region,@enabled,@adapter,@acquisition_method,@auth_status,@frequency,'NEVER_RUN',@is_seed,@ts)
     ON CONFLICT(id) DO UPDATE SET name=@name, kind=@kind, url=@url, region=@region, enabled=@enabled, adapter=@adapter,
       acquisition_method=@acquisition_method, auth_status=@auth_status, frequency=@frequency`,
  );
  for (const r of rows) stmt.run({ ...r, ts });
}

/** Page-load prep: remove legacy demo rows (once), register sources, bridge events. Never seeds.
 *  Returns false (kept for the old call sites that expected "did it seed"). */
export async function seedOpportunitiesIfEmpty(now: Date = new Date()): Promise<boolean> {
  purgeDemoDataOnce();
  registerSources(now);
  syncEventOpportunities(now);
  return false;
}

/** Refresh on page load: bridge new events and re-match entities to Zoe customer history. Live
 *  connectors (SAM.gov, ICS) are NOT pulled here: they run on the runtime clock (opportunity-radar job),
 *  because SAM.gov allows only a handful of calls a day and a page load must stay fast. */
export async function refreshOpportunities(now: Date = new Date()): Promise<void> {
  purgeDemoDataOnce();
  registerSources(now);
  syncEventOpportunities(now);
  try { enrichEntityMatches(); } catch { /* non-fatal */ }
}
