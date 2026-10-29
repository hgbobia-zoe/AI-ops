// SEO Growth — office-runner INGEST endpoint. Google blocks our Fly (datacenter) IP, so the OFFICE MACHINE
// reads live Google SERPs for pending keywords and PUSHES the observed results here (meta.source = "serp"). The
// app computes the competitive gap. CORS-restricted, token-gated in-handler, fail-OPEN until the token is set.
// The payload is DATA, never code. (A legacy keyword-metrics shape — meta.source absent — still parses, for
// back-compat with rows pulled before the SERP pivot.)
//
//   POST  body { keywords: [{ keyword, category, location, intent, rawResult }], meta?: { source, zoeDomain,
//               blocked, limitHit, quota, error, toolName, retrievedAt } }  → parse + upsert + analyze
//   GET   ?pending=<n>  → the next <n> seed keywords NOT yet read (what the runner should read next)

import { NextResponse } from "next/server";
import { ingestKeywordResults, pendingSeedKeywords, type SeoIngestBatch } from "@/lib/seo/discovery";
import { alertLimitHit } from "@/lib/seo/watcher";
import { insertAudit } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-seo-token",
    Vary: "Origin",
  };
}

/** Shared token gate — identical contract to /api/seo/cron: fails OPEN until SEO_INGEST_TOKEN is set, then
 *  requires the x-seo-token header or ?token=. Returns null when authorized. */
function unauthorized(req: Request, headers: Record<string, string>): NextResponse | null {
  const token = process.env.SEO_INGEST_TOKEN;
  if (!token) return null;
  const provided = req.headers.get("x-seo-token") || new URL(req.url).searchParams.get("token") || "";
  if (provided !== token) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  return null;
}

export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: cors(req) });
}

export async function GET(req: Request): Promise<NextResponse> {
  const headers = cors(req);
  const denied = unauthorized(req, headers);
  if (denied) return denied;
  const nParam = Number(new URL(req.url).searchParams.get("pending") ?? "25");
  const limit = Number.isFinite(nParam) && nParam > 0 ? Math.min(nParam, 200) : 25;
  const pending = pendingSeedKeywords({ limit });
  return NextResponse.json({ ok: true, pending, count: pending.length }, { headers });
}

export async function POST(req: Request): Promise<NextResponse> {
  const headers = cors(req);
  const denied = unauthorized(req, headers);
  if (denied) return denied;

  let body: SeoIngestBatch;
  try {
    body = (await req.json()) as SeoIngestBatch;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers });
  }
  if (!body || (!Array.isArray(body.keywords) && !body.meta)) {
    return NextResponse.json({ error: "expected { keywords: [...] , meta?: {...} }" }, { status: 400, headers });
  }

  const result = ingestKeywordResults(body);

  // Free-tier limit → a deduped alert (the watcher handles cooldown). Never blocks the response on Slack.
  let alerted = false;
  if (result.limitHit) {
    const a = await alertLimitHit({ quota: body.meta?.quota });
    alerted = a.alerted;
  }

  insertAudit({
    actor: "office-runner (seo)",
    action: "seo.ingest",
    entity: "seo",
    entityId: body.meta?.source ?? "serp",
    after: { received: result.received, created: result.created, updated: result.updated, skipped: result.skipped, errors: result.errors, limitHit: result.limitHit, blocked: result.blocked, source: body.meta?.source ?? null, toolName: body.meta?.toolName ?? null },
  });

  return NextResponse.json({ ok: true, result, alerted }, { headers });
}
