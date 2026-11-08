import { describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { upsertOpportunity, upsertEntity, linkEntity, getOpportunities } from "./store";
import { purgeDemoData, purgeDemoDataOnce } from "./demoPurge";
import { seedOpportunitiesIfEmpty } from "./seed";

const NOW = new Date("2026-11-07T15:00:00Z");

describe("demo data removal", () => {
  it("deletes seed rows and their links, keeps real ones, and never re-seeds", async () => {
    const real = upsertOpportunity({ dedupeKey: "real-1", kind: "EVENT", name: "Real gala", jurisdiction: "DC", region: "DC" }, NOW);
    const demo = upsertOpportunity({ dedupeKey: "demo-1", kind: "PROCUREMENT", name: "Demo RFP", jurisdiction: "DC", region: "DC", isSeed: true }, NOW);
    const demoEnt = upsertEntity({ name: "XYZ Events Group", kind: "EVENT_MGMT" as never, website: null, email: null, phone: null, jurisdiction: null, verificationStatus: "INFERRED", matchedCustomerKey: null, notes: null, isSeed: true }, NOW);
    linkEntity(demo.id, demoEnt.id, "EVENT_MGMT" as never, {}, NOW);
    getDb().prepare("INSERT INTO radar_sources (id, name, kind, region, enabled, is_seed, created_at) VALUES ('src-umd','UMD','UNIVERSITY','DMV',0,0,?)").run(NOW.toISOString());

    const r = purgeDemoData();
    expect(r.opportunities).toBe(1);
    const ids = getOpportunities().map((o) => o.id);
    expect(ids).toContain(real.id);
    expect(ids).not.toContain(demo.id);
    expect(getDb().prepare("SELECT COUNT(*) n FROM opportunity_entities WHERE opportunity_id=?").get(demo.id)).toEqual({ n: 0 });
    expect(getDb().prepare("SELECT COUNT(*) n FROM radar_entities WHERE id=?").get(demoEnt.id)).toEqual({ n: 0 });
    expect(getDb().prepare("SELECT COUNT(*) n FROM radar_sources WHERE id='src-umd'").get()).toEqual({ n: 0 });

    // The page-load prep never adds demo data back, even into an empty table.
    getDb().prepare("DELETE FROM opportunities").run();
    await seedOpportunitiesIfEmpty(NOW);
    expect(getOpportunities()).toHaveLength(0);
    expect(purgeDemoDataOnce()).toBeNull(); // already ran once for this database
  });
});
