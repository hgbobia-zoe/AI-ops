// Publish a new kiosk APK as an OTA update. One authenticated POST writes the APK +
// manifest to the volume; every tablet picks it up on its next check (≤6h) and self-
// installs. This is what makes "push an update" a single command instead of touching
// each tablet.
//
// Security: gated by the KIOSK_PUBLISH_TOKEN secret (endpoint is disabled — 503 —
// until it's set). Even with the token, a pushed APK can only INSTALL over the running
// app if it's signed with the same Zoe release key (Android enforces signature match on
// update), and that key never leaves the maintainer's machine. So the token alone can't
// push a malicious build. The server also records the sha256 for download integrity.

import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { kioskDir } from "@/lib/kioskDist";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const token = process.env.KIOSK_PUBLISH_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "publishing disabled (set KIOSK_PUBLISH_TOKEN)" }, { status: 503 });
  }
  if (req.headers.get("x-publish-token") !== token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }

  const apk = form.get("apk");
  const versionCode = Number(form.get("versionCode"));
  const versionName = String(form.get("versionName") || "").trim();
  const notes = String(form.get("notes") || "").trim();

  if (!(apk instanceof File) || !Number.isInteger(versionCode) || versionCode <= 0 || !versionName) {
    return NextResponse.json(
      { error: "apk (file), versionCode (positive int), versionName (string) required" },
      { status: 400 },
    );
  }

  const buf = Buffer.from(await apk.arrayBuffer());
  if (buf.length === 0) return NextResponse.json({ error: "empty apk" }, { status: 400 });
  const sha256 = createHash("sha256").update(buf).digest("hex");

  const dir = kioskDir();
  writeFileSync(join(dir, "app-release.apk"), buf);
  const manifest = { versionCode, versionName, sha256, notes };
  writeFileSync(join(dir, "latest.json"), JSON.stringify(manifest, null, 2));

  return NextResponse.json({ ok: true, ...manifest, size: buf.length });
}
