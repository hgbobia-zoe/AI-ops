// One time repair: outbound calls that landed on lead timelines as INBOUND.
//
// Quo sends a call's summary in a later webhook event that carries no direction, and the timeline write
// used to default a missing direction to "inbound". So a rep's follow up call with a summary read as the
// client calling us: it held leads in morning outreach ("client waiting on us"), marked them "just
// replied" and put them in the recent inbound feed. The ingest is fixed; this corrects the stored rows.
//
// The stored call row often has no direction either, so the truth comes from Quo (GET /calls/<id>).
// Bounded per request and resumable with `before`; dry run unless apply is set.

import { getDb } from "@/lib/db";
import { getBookingById } from "@/lib/db/repo";
import { getCallDetails, getOpenphonePhoneNumbers, listOpenphoneCalls, type QuoCall, type QuoNumber } from "@/lib/comms/openphone";

/** Quo's GET /calls/<id> returns nothing for many calls, but its per number call list has them. Match a
 *  stored call there by id, else by time (within 2 minutes). The list is read once per lead. */
const LIST_PAGES = 3;
const MATCH_MS = 120_000;

async function leadCalls(leadId: string, numbers: QuoNumber[], cache: Map<string, QuoCall[]>): Promise<QuoCall[]> {
  const hit = cache.get(leadId);
  if (hit) return hit;
  const d10 = (getBookingById(leadId)?.clientPhone ?? "").replace(/\D/g, "").slice(-10);
  const out: QuoCall[] = [];
  if (d10.length === 10) {
    for (const n of numbers) {
      let token: string | null = null;
      for (let p = 0; p < LIST_PAGES; p++) {
        const page: { calls: QuoCall[]; nextPageToken: string | null } = await listOpenphoneCalls(n.id, `+1${d10}`, token).catch(() => ({ calls: [] as QuoCall[], nextPageToken: null }));
        out.push(...page.calls);
        token = page.nextPageToken;
        if (!token) break;
      }
    }
  }
  cache.set(leadId, out);
  return out;
}

export function matchListedCall(calls: QuoCall[], callId: string, at: string): QuoCall | null {
  const byId = calls.find((c) => c.id === callId);
  if (byId) return byId;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return null;
  let best: QuoCall | null = null;
  let gap = MATCH_MS;
  for (const c of calls) {
    const d = c.occurredAt ? Math.abs(Date.parse(c.occurredAt) - t) : Infinity;
    if (d < gap) {
      gap = d;
      best = c;
    }
  }
  return best;
}

export interface CallDirectionRepairResult {
  apply: boolean;
  checked: number;
  outbound: number; // stored inbound, Quo says outgoing (fixed when apply)
  inbound: number; //  Quo confirms incoming
  unknown: number; //  Quo returned nothing for the call
  /** Pass back as `before` to continue; null when there is nothing older left. */
  nextBefore: string | null;
  fixedLeads: string[];
}

interface Row {
  id: string;
  provider_id: string;
  lead_id: string | null;
  at: string;
}

export async function repairCallDirections(opts: { apply: boolean; limit: number; before?: string | null }): Promise<CallDirectionRepairResult> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, provider_id, lead_id, COALESCE(occurred_at, ts) AS at FROM comms_events
        WHERE channel = 'call' AND direction = 'inbound' AND provider_id LIKE 'call:%'
          AND (@before IS NULL OR COALESCE(occurred_at, ts) < @before)
        ORDER BY COALESCE(occurred_at, ts) DESC LIMIT @limit`,
    )
    .all({ before: opts.before ?? null, limit: opts.limit }) as Row[];

  const res: CallDirectionRepairResult = { apply: opts.apply, checked: 0, outbound: 0, inbound: 0, unknown: 0, nextBefore: null, fixedLeads: [] };
  const fixComms = db.prepare("UPDATE comms_events SET direction = 'outbound' WHERE id = ? AND direction = 'inbound'");
  const fillCall = db.prepare("UPDATE call_events SET direction = ? WHERE provider_id = ? AND direction IS NULL");

  const cache = new Map<string, QuoCall[]>();
  let numbers: QuoNumber[] | null = null;
  for (const r of rows) {
    res.checked++;
    const callId = r.provider_id.slice("call:".length);
    const det = await getCallDetails(callId).catch(() => null);
    let dir = det?.direction ?? null;
    if (!dir && r.lead_id) {
      numbers ??= await getOpenphonePhoneNumbers().catch(() => []);
      dir = matchListedCall(await leadCalls(r.lead_id, numbers, cache), callId, r.at)?.direction ?? null;
    }
    if (dir === "outgoing") {
      res.outbound++;
      if (r.lead_id && !res.fixedLeads.includes(r.lead_id)) res.fixedLeads.push(r.lead_id);
      if (opts.apply) {
        fixComms.run(r.id);
        fillCall.run("outgoing", callId);
      }
    } else if (dir === "incoming") {
      res.inbound++;
      if (opts.apply) fillCall.run("incoming", callId);
    } else {
      res.unknown++;
    }
  }
  res.nextBefore = rows.length === opts.limit ? rows[rows.length - 1].at : null;
  return res;
}
