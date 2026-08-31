// Streams the published kiosk APK from the volume. Paired with /api/kiosk/latest.

import { existsSync, readFileSync } from "node:fs";
import { apkPath } from "@/lib/kioskDist";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const p = apkPath();
  if (!existsSync(p)) return new Response("no apk published", { status: 404 });
  const buf = readFileSync(p);
  return new Response(buf, {
    headers: {
      "content-type": "application/vnd.android.package-archive",
      "content-length": String(buf.length),
      "content-disposition": 'attachment; filename="app-release.apk"',
      "cache-control": "no-store",
    },
  });
}
