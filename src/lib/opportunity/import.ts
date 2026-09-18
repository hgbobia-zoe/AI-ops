// Opportunity Radar — manual import. Feed REAL opportunities (is_seed=0) from a CSV/paste or an Apify /
// spreadsheet export, through the same normalize → classify → dedupe → score pipeline. This is the
// zero-setup way to start with real data: no API key, no browser agent. Also the target for one-off
// research.
//
// CSV columns (header row, case-insensitive; only `name` is required):
//   name, kind, description, date, deadline, venue, city, state, source_name, source_url, agency,
//   attendance, categories, contact_name, contact_email, contact_role
//   - kind: event | procurement | facility | web  (default event)
//   - date/deadline: YYYY-MM-DD
//   - categories: comma or "|" separated Zoe categories (tent, tables, chairs, ...)
//   - contact_role: buyer | planner | prime | production | facilities | vendor (default planner)

import { runOpportunitySource, type OpportunitySource, type RawOpportunity } from "./ingest";
import { upsertSource } from "@/lib/radar/store";
import type { EntityKind, OpportunityKind, RelationshipRole, ZoeCategory } from "./types";
import { ZOE_CATEGORY_LABEL } from "./types";

const IMPORT_SOURCE_ID = "manual-import";

// ── CSV parsing (RFC-4180-ish: quoted fields, escaped quotes, newlines in quotes) ────────────────
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const s = text.replace(/\r\n?/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length < 2) return [];
  const header = nonEmpty[0].map((h) => h.trim().toLowerCase());
  return nonEmpty.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => { obj[h] = (r[idx] ?? "").trim(); });
    return obj;
  });
}

const KIND_MAP: Record<string, OpportunityKind> = { event: "EVENT", procurement: "PROCUREMENT", facility: "FACILITY_SIGNAL", "facility_signal": "FACILITY_SIGNAL", web: "WEB_SIGNAL", "web_signal": "WEB_SIGNAL" };
const ROLE_MAP: Record<string, { kind: EntityKind; role: RelationshipRole }> = {
  buyer: { kind: "AGENCY", role: "DIRECT_BUYER" },
  planner: { kind: "EVENT_PLANNER", role: "EVENT_PLANNER" },
  prime: { kind: "PRIME", role: "PRIME_CONTRACTOR" },
  production: { kind: "PRODUCTION", role: "EVENT_MGMT" },
  facilities: { kind: "FACILITIES", role: "FACILITIES_CONTRACTOR" },
  vendor: { kind: "VENDOR", role: "VENDOR" },
  contact: { kind: "CONTACT", role: "PROCUREMENT_CONTACT" },
};
const CATEGORY_KEYS = Object.keys(ZOE_CATEGORY_LABEL) as ZoeCategory[];
const ymd = (s: string | undefined): string | null => (s && /^\d{4}-\d{2}-\d{2}$/.test(s.trim()) ? s.trim() : null);

/** Map an import row to a RawOpportunity. Returns null when there's no usable name. */
export function rowToRaw(row: Record<string, string>): RawOpportunity | null {
  const name = (row.name ?? row.title ?? "").trim();
  if (!name) return null;
  const kind = KIND_MAP[(row.kind ?? "").trim().toLowerCase()] ?? "EVENT";
  const categories = (row.categories ?? "")
    .split(/[,|]/).map((c) => c.trim().toLowerCase()).filter(Boolean)
    .filter((c): c is ZoeCategory => (CATEGORY_KEYS as string[]).includes(c));
  const attendance = Number(row.attendance);
  const contactName = (row.contact_name ?? "").trim();
  const roleSpec = ROLE_MAP[(row.contact_role ?? "").trim().toLowerCase()] ?? ROLE_MAP.planner;

  const entities: RawOpportunity["entities"] = [];
  if (contactName) {
    entities.push({ name: contactName, kind: roleSpec.kind, role: roleSpec.role, email: (row.contact_email ?? "").trim() || undefined, isPrimaryTarget: true, evidence: "Provided on import" });
  }
  if ((row.agency ?? "").trim() && (!contactName || kind === "PROCUREMENT")) {
    entities.push({ name: row.agency.trim(), kind: "AGENCY", role: "DIRECT_BUYER", evidence: "Buyer/organizer on import" });
  }

  return {
    externalId: `${name}-${ymd(row.date) ?? ymd(row.deadline) ?? ""}-${(row.city ?? "").trim()}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || undefined,
    kind,
    name,
    description: (row.description ?? "").trim() || undefined,
    sourceUrl: (row.source_url ?? row.url ?? "").trim() || undefined,
    agency: (row.agency ?? "").trim() || undefined,
    city: (row.city ?? "").trim() || undefined,
    state: (row.state ?? "").trim() || undefined,
    estimatedDate: ymd(row.date),
    deadline: ymd(row.deadline),
    expectedAttendance: Number.isFinite(attendance) && attendance > 0 ? attendance : null,
    attendanceConfidence: Number.isFinite(attendance) && attendance > 0 ? "INFERRED" : "UNKNOWN",
    verificationStatus: "INFERRED",
    zoeCategoriesHint: categories.length ? categories : undefined,
    entities: entities.length ? entities : undefined,
  };
}

export interface ImportResult { rows: number; parsed: number; stored: number; errors: string[] }

/** Import already-parsed rows as REAL opportunities. sourceLabel names where they came from. */
export async function runImport(rows: Record<string, string>[], sourceLabel: string, now: Date = new Date()): Promise<ImportResult> {
  const raws = rows.map(rowToRaw).filter((r): r is RawOpportunity => r !== null);
  // Register the manual-import source (real, enabled) so provenance + the registry show it.
  upsertSource({ id: IMPORT_SOURCE_ID, name: `Manual import — ${sourceLabel}`.slice(0, 80), kind: "MANUAL", url: null, region: "DMV", enabled: true, adapter: "manual", isSeed: false }, now);
  const source: OpportunitySource = { id: IMPORT_SOURCE_ID, name: `Manual import — ${sourceLabel}`.slice(0, 80), kind: "MANUAL", acquisitionMethod: "MANUAL", adapter: "manual", isSeed: false, acquire: () => raws };
  const res = await runOpportunitySource(source, now);
  return { rows: rows.length, parsed: raws.length, stored: res.stored, errors: res.errors };
}

/** Parse CSV text and import. */
export async function importCsv(text: string, sourceLabel: string, now: Date = new Date()): Promise<ImportResult> {
  return runImport(parseCsv(text), sourceLabel, now);
}

/** The CSV template header + one example row, for the import UI. */
export const IMPORT_TEMPLATE =
  "name,kind,description,date,deadline,venue,city,state,source_name,source_url,agency,attendance,categories,contact_name,contact_email,contact_role\n" +
  'Example DMV Conference 2027,event,Regional conference with exhibit hall and reception,2027-05-14,,Walter E. Washington Convention Center,Washington,DC,Convention Center calendar,https://example.org/event,Example Association,1200,"tent,tables,chairs,linens",,,planner';
