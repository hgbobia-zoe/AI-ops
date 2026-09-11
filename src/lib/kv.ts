// Tiny JSON key/value store over the settings table — for small bits of durable state like the
// history-import cursor. Namespaced keys (e.g. "coaching.callImport") keep it out of app settings.

import { getDb } from "@/lib/db";

export function getJson<T>(key: string, fallback: T): T {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setJson(key: string, value: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, JSON.stringify(value), new Date().toISOString());
}
