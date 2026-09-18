// Zoe Capability Profile — server store. The reusable company facts behind bid pursuit (capability
// statements, solicitation responses, subcontractor outreach all draw from this ONE record). Filled once
// in the app (Admin → Capability Profile), stored as a JSON blob in the settings table under its own key.
// FACTS ONLY — nothing is generated here. Pure shape + options live in ./capabilityProfileShape.

import { getDb } from "@/lib/db/index";
import { emptyProfile, type CapabilityProfile } from "./capabilityProfileShape";

export { emptyProfile, profileCompleteness, CERT_OPTIONS } from "./capabilityProfileShape";
export type { CapabilityProfile, PastProject } from "./capabilityProfileShape";

const KEY = "capability_profile";

export function getCapabilityProfile(): CapabilityProfile {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
  let stored: Partial<CapabilityProfile> | null = null;
  if (row) {
    try {
      stored = JSON.parse(row.value) as Partial<CapabilityProfile>;
    } catch {
      stored = null;
    }
  }
  const merged = { ...emptyProfile(), ...(stored ?? {}) };
  if (!Array.isArray(merged.certifications)) merged.certifications = [];
  if (!Array.isArray(merged.pastPerformance)) merged.pastPerformance = [];
  return merged;
}

/** Persist the profile. Trims strings, drops empty past-performance rows, stamps updatedAt. */
export function saveCapabilityProfile(input: CapabilityProfile): CapabilityProfile {
  const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const next: CapabilityProfile = {
    ...emptyProfile(),
    ...input,
    legalName: s(input.legalName), dba: s(input.dba), website: s(input.website), phone: s(input.phone),
    email: s(input.email), address: s(input.address), foundedYear: s(input.foundedYear), serviceArea: s(input.serviceArea),
    uei: s(input.uei), cageCode: s(input.cageCode), naicsCodes: s(input.naicsCodes),
    certifications: Array.isArray(input.certifications) ? input.certifications.filter((c) => typeof c === "string") : [],
    certificationsOther: s(input.certificationsOther),
    generalLiability: s(input.generalLiability), autoLiability: s(input.autoLiability), workersComp: s(input.workersComp), umbrella: s(input.umbrella),
    coreCompetencies: s(input.coreCompetencies), capacitySummary: s(input.capacitySummary), differentiators: s(input.differentiators),
    pastPerformance: (Array.isArray(input.pastPerformance) ? input.pastPerformance : [])
      .map((p) => ({ name: s(p?.name), detail: s(p?.detail), year: s(p?.year) }))
      .filter((p) => p.name || p.detail),
    bidContactName: s(input.bidContactName), bidContactTitle: s(input.bidContactTitle), bidContactEmail: s(input.bidContactEmail), bidContactPhone: s(input.bidContactPhone),
    samRegistered: !!input.samRegistered,
    providesAdditionalInsured: !!input.providesAdditionalInsured,
    updatedAt: new Date().toISOString(),
  };
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(KEY, JSON.stringify(next), next.updatedAt);
  return next;
}
