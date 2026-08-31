// Kiosk APK distribution — serves the Android shell's OTA updates. The signed APK
// and a small version manifest live on the persistent volume (next to the SQLite DB
// and POD files), so publishing a new native build is just "drop two files on the
// volume" — no web rebuild/redeploy needed.
//
//   <db-dir>/kiosk/app-release.apk   the signed APK the tablets download
//   <db-dir>/kiosk/latest.json       { versionCode, versionName, sha256, notes? }
//
// The tablet polls /api/kiosk/latest; if versionCode there is newer than the one it's
// running, it downloads /api/kiosk/download, verifies the sha256, and (as device
// owner) installs it silently. See android OtaUpdater.kt.

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export interface KioskManifest {
  versionCode: number;
  versionName: string;
  sha256: string;
  notes?: string;
}

export function kioskDir(): string {
  const dbPath = process.env.DATABASE_PATH || "./data/dispatch.db";
  const base = dbPath === ":memory:" ? "./data" : dirname(dbPath);
  const dir = join(base, "kiosk");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const APK_NAME = "app-release.apk";

/** The published manifest, or null if nothing has been published yet. */
export function readManifest(): KioskManifest | null {
  const path = join(kioskDir(), "latest.json");
  if (!existsSync(path)) return null;
  try {
    const m = JSON.parse(readFileSync(path, "utf8")) as Partial<KioskManifest>;
    if (typeof m.versionCode !== "number" || !m.versionName || !m.sha256) return null;
    return { versionCode: m.versionCode, versionName: m.versionName, sha256: m.sha256, notes: m.notes };
  } catch {
    return null;
  }
}

export function apkPath(): string {
  return join(kioskDir(), APK_NAME);
}

/** Size in bytes of the published APK, or null if it isn't there. */
export function apkSize(): number | null {
  const p = apkPath();
  return existsSync(p) ? statSync(p).size : null;
}
