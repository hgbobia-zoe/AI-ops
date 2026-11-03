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
import { getCallDetails } from "@/lib/comms/openphone";

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

  for (const r of rows) {
    res.checked++;
    const callId = r.provider_id.slice("call:".length);
    const det = await getCallDetails(callId).catch(() => null);
    const dir = det?.direction ?? null;
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
