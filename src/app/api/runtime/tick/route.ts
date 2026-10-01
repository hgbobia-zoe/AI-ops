// Cloud runtime tick — the unattended heartbeat. A GitHub Actions schedule (the off-machine clock) hits
// this on a timer; it runs every CONFIGURED server-side integration job once and records the results to
// the import ledger. Token-gated (RUNTIME_TOKEN): returns 503 until the token is set (so it can't be run
// anonymously), 401 on a bad token. Browser-bucket jobs (Goodshuffle) are NOT run here — they still need
// a logged-in browser until the cloud-browser path exists. CORS-open (hit by a scheduler, not a browser).

import { NextResponse } from "next/server";
import { runServerJobs } from "@/lib/runtime/jobs";

export const dynamic = "force-dynamic";

async function handle(req: Request): Promise<NextResponse> {
  const token = process.env.RUNTIME_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "not_configured", message: "Set RUNTIME_TOKEN (Fly secret + the GitHub Actions secret) to enable the runtime." }, { status: 503 });
  }
  const auth = req.headers.get("authorization");
  const qp = new URL(req.url).searchParams.get("token");
  if (auth !== `Bearer ${token}` && qp !== token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const ran = await runServerJobs();
  return NextResponse.json({ ok: true, ran, at: new Date().toISOString() });
}

export const GET = handle; // allow a simple scheduled GET
export const POST = handle;
