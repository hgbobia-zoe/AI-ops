// Controlled Automation (MVP8) — the OBSERVE log. Records each proposed action so the UI can show
// how long the platform has been recommending it. This is the ONLY side effect in observe mode:
// writing to this audit table. It never touches dispatch, Connecteam, Goodshuffle, or SMS.

import { getDb } from "@/lib/db";
import type { ProposedAction } from "./actions";

/** Upsert the given proposals into the observe log and return key → first-observed timestamp.
 *  first_observed_at is set once and preserved; last_seen_at + text refresh each pass. */
export function observeProposals(props: ProposedAction[], now: Date = new Date()): Map<string, string> {
  const db = getDb();
  const ts = now.toISOString();
  const up = db.prepare(
    `INSERT INTO automation_proposals
       (proposal_key, tier, target, action_type, title, detail, reversible, outward, first_observed_at, last_seen_at, status)
     VALUES (@key,@tier,@target,@actionType,@title,@detail,@reversible,@outward,@ts,@ts,'observed')
     ON CONFLICT(proposal_key) DO UPDATE SET
       tier=@tier, target=@target, action_type=@actionType, title=@title, detail=@detail,
       reversible=@reversible, outward=@outward, last_seen_at=@ts`,
  );
  const tx = db.transaction(() => {
    for (const p of props)
      up.run({
        key: p.key,
        tier: p.tier,
        target: p.target,
        actionType: p.actionType,
        title: p.title,
        detail: p.detail,
        reversible: p.reversible ? 1 : 0,
        outward: p.outward ? 1 : 0,
        ts,
      });
  });
  tx();

  const out = new Map<string, string>();
  if (props.length === 0) return out;
  const ph = props.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT proposal_key, first_observed_at FROM automation_proposals WHERE proposal_key IN (${ph})`)
    .all(...props.map((p) => p.key)) as Array<{ proposal_key: string; first_observed_at: string }>;
  for (const r of rows) out.set(r.proposal_key, r.first_observed_at);
  return out;
}
