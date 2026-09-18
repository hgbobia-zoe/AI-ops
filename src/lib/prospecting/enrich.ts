// Prospecting — contact enrichment. When a target company has no contact email, try to find one via
// Apify (the user already has Apify). DORMANT until APIFY_TOKEN is set: with no token it returns null
// and enrollment proceeds with what we know. NEVER fabricates an email — it only stores what a provider
// actually returns, marked INFERRED for a human to confirm.

import { getDb } from "@/lib/db";

export interface EnrichedContact {
  name?: string;
  email?: string;
  title?: string;
  source: string;
}

export function apifyConfigured(): boolean {
  return Boolean(process.env.APIFY_TOKEN);
}

/**
 * Ask Apify for a business contact for a company. Uses the actor named in APIFY_CONTACT_ACTOR (default
 * a generic contact-scraper) via the run-sync-get-dataset-items endpoint. Never throws; returns null on
 * any failure, no token, or no result. The exact actor/output shape is provider-specific, so we defend
 * against unknown shapes and only accept a plausible email.
 */
export async function findContact(input: { company: string; domain?: string | null }): Promise<EnrichedContact | null> {
  const token = process.env.APIFY_TOKEN;
  if (!token) return null;
  const actor = process.env.APIFY_CONTACT_ACTOR || "vdrmota~contact-info-scraper";
  try {
    const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input.domain ? { startUrls: [{ url: input.domain.startsWith("http") ? input.domain : `https://${input.domain}` }] } : { queries: [input.company] }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return null;
    const items = (await res.json().catch(() => [])) as unknown[];
    for (const it of Array.isArray(items) ? items : []) {
      const row = it as Record<string, unknown>;
      const emails = (row.emails ?? row.email) as unknown;
      const email = Array.isArray(emails) ? (emails[0] as string) : typeof emails === "string" ? emails : undefined;
      if (email && /.+@.+\..+/.test(email)) {
        return { email, name: typeof row.name === "string" ? row.name : undefined, title: typeof row.title === "string" ? row.title : undefined, source: `apify:${actor}` };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Enrich a stored entity's contact email in place (INFERRED). Returns the email found, or null. */
export async function enrichEntityContact(entityId: string): Promise<string | null> {
  const db = getDb();
  const ent = db.prepare("SELECT id, name, email, website FROM radar_entities WHERE id = ?").get(entityId) as { id: string; name: string; email: string | null; website: string | null } | undefined;
  if (!ent || ent.email) return ent?.email ?? null;
  if (!apifyConfigured()) return null;
  const found = await findContact({ company: ent.name, domain: ent.website });
  if (found?.email) {
    db.prepare("UPDATE radar_entities SET email=?, notes=COALESCE(notes,'') || ? , updated_at=? WHERE id=?")
      .run(found.email, ` [contact via ${found.source}]`, new Date().toISOString(), entityId);
    return found.email;
  }
  return null;
}
