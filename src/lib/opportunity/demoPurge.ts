// Remove every demo / seed record from Opportunity Radar. Owner decision (2026-11-07): "Remove all mock
// data." Radar no longer seeds demo data anywhere; this deletes what earlier versions seeded (is_seed=1
// rows) plus everything hanging off them, and the placeholder source stubs that pointed at example.org.
// Real records (imports, live pulls, conversions) are never touched: every delete keys on is_seed=1 or on
// a seed parent. Runs once per database (kv flag), from the first Radar page load after deploy.

import { getDb } from "@/lib/db";
import { getJson, setJson } from "@/lib/kv";

const FLAG = "radar.demoPurged.v1";
const PLACEHOLDER_SOURCES = ["src-waltere-convention", "src-gaylord-national", "src-baltimore-convention", "src-umd", "src-assoc-directory", "src-search"];

export interface PurgeReport {
  opportunities: number;
  events: number;
  procurements: number;
  entities: number;
  other: number;
}

/** Delete all seed rows and their dependents in one transaction. Idempotent. */
export function purgeDemoData(): PurgeReport {
  const db = getDb();
  const report: PurgeReport = { opportunities: 0, events: 0, procurements: 0, entities: 0, other: 0 };
  const run = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args).changes;
  db.transaction(() => {
    const seedOpp = "SELECT id FROM opportunities WHERE is_seed=1";
    const seedEvent = "SELECT id FROM radar_events WHERE is_seed=1";
    // Dependents of seed opportunities first.
    report.other += run(`DELETE FROM opportunity_entities WHERE opportunity_id IN (${seedOpp})`);
    report.other += run(`DELETE FROM opportunity_alerts WHERE opportunity_id IN (${seedOpp})`);
    report.other += run(`DELETE FROM opportunity_ai WHERE opportunity_id IN (${seedOpp})`);
    report.other += run(`DELETE FROM opportunity_outreach WHERE opportunity_id IN (${seedOpp})`);
    report.other += run(`DELETE FROM prospect_tasks WHERE opportunity_id IN (${seedOpp})`);
    report.other += run(`DELETE FROM prospect_enrollments WHERE opportunity_id IN (${seedOpp})`);
    report.other += run(`DELETE FROM settings WHERE key IN (SELECT 'outreach_plan:' || id FROM opportunities WHERE is_seed=1 UNION SELECT 'pursuit:' || id FROM opportunities WHERE is_seed=1)`);
    report.opportunities += run("DELETE FROM opportunities WHERE is_seed=1");
    // Event side.
    report.other += run(`DELETE FROM radar_opportunities WHERE event_id IN (${seedEvent})`);
    report.other += run("DELETE FROM radar_planners WHERE is_seed=1");
    report.events += run("DELETE FROM radar_events WHERE is_seed=1");
    report.other += run("DELETE FROM radar_series WHERE is_seed=1");
    report.other += run("DELETE FROM radar_organizations WHERE is_seed=1");
    report.procurements += run("DELETE FROM radar_procurements WHERE is_seed=1");
    // Seed entities, unless a real opportunity still links to one.
    report.entities += run("DELETE FROM radar_entities WHERE is_seed=1 AND id NOT IN (SELECT entity_id FROM opportunity_entities)");
    report.other += run("DELETE FROM radar_campaigns WHERE is_seed=1");
    report.other += run("DELETE FROM radar_sources WHERE is_seed=1");
    report.other += run(`DELETE FROM radar_sources WHERE id IN (${PLACEHOLDER_SOURCES.map(() => "?").join(",")})`, ...PLACEHOLDER_SOURCES);
  })();
  return report;
}

/** Purge once per database. Returns the report the first time, null afterwards. Never throws. */
export function purgeDemoDataOnce(): PurgeReport | null {
  try {
    if (getJson<string | null>(FLAG, null)) return null;
    const report = purgeDemoData();
    setJson(FLAG, new Date().toISOString());
    return report;
  } catch (e) {
    console.error("[radar] demo purge failed:", e);
    return null;
  }
}
