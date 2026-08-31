// OTA manifest for the Android kiosk shell. The tablet polls this; if versionCode is
// newer than the running build it downloads /api/kiosk/download and self-installs.
// 204 when nothing has been published yet (the volume has no APK/manifest).

import { NextResponse } from "next/server";
import { readManifest, apkSize } from "@/lib/kioskDist";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const m = readManifest();
  const size = apkSize();
  if (!m || size == null) return new NextResponse(null, { status: 204 });

  const base = (process.env.PUBLIC_BASE_URL || new URL(req.url).origin).replace(/\/$/, "");
  return NextResponse.json({
    versionCode: m.versionCode,
    versionName: m.versionName,
    sha256: m.sha256,
    notes: m.notes ?? "",
    size,
    url: `${base}/api/kiosk/download`,
  });
}
