// Deployment observability (audit gate 8). A PUBLIC, read-only endpoint that reports which build is live —
// the git commit, when it was deployed, and process start. The self-improvement controller reads this to
// confirm that the commit it merged is actually the one now running ("deployed", not just "merged"), and
// external monitoring can watch it too. No secrets, no auth needed — it only states the build identity.

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Captured once when this server process starts — a change in startedAt across two reads means a redeploy
// (or restart) happened.
const STARTED_AT = new Date().toISOString();

export function GET(): NextResponse {
  return NextResponse.json({
    ok: true,
    commit: process.env.GIT_COMMIT || "unknown", //   set at deploy time (deploy.yml --build-arg/env)
    deployedAt: process.env.DEPLOYED_AT || null, //    set at deploy time
    startedAt: STARTED_AT,
    region: process.env.FLY_REGION || null,
  });
}
