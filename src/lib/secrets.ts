// Provider credential store (API keys/tokens + non-secret provider config such as
// from-numbers and base URLs). Kept OUT of the openly-returned app settings: secret
// fields are never sent to the client in plaintext — the admin API returns only whether
// each is set. Keys are namespaced `<providerId>.<field>` (e.g. "samsara.apiToken").
//
// Server-only (better-sqlite3).

import { getDb } from "@/lib/db";

/** Read one credential value, or null if unset/blank. */
export function getSecret(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM secrets WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  const v = row?.value?.trim();
  return v ? v : null;
}

/** Set (or, with an empty value, delete) one credential. */
export function setSecret(key: string, value: string | null | undefined): void {
  const db = getDb();
  const v = (value ?? "").trim();
  if (!v) {
    db.prepare("DELETE FROM secrets WHERE key = ?").run(key);
    return;
  }
  db.prepare(
    `INSERT INTO secrets (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, v, new Date().toISOString());
}

export function hasSecret(key: string): boolean {
  return getSecret(key) !== null;
}

/** Namespaced key for a provider field. */
export function providerKey(providerId: string, field: string): string {
  return `${providerId}.${field}`;
}

/** Read all of a provider's stored field values as a plain object (server-side use). */
export function getProviderConfig(providerId: string, fields: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = getSecret(providerKey(providerId, f));
    if (v) out[f] = v;
  }
  return out;
}
