// AI Control Plane — the one bridge from a session to a mutation. A session NEVER writes operational data
// itself. When it wants to act, it calls proposeFromSession(), which (1) creates an ai_approvals row via
// the EXISTING createApproval (same six-field card, same idempotency, same action types), and (2) links
// it to the session. A human then decides it with the EXISTING decideApproval, which routes an approve to
// the proven gs_outbox path — respecting EMAIL_SEND_ENABLED and leaving money/pricing/schedule/hiring/
// instawork FORBIDDEN to execute. Nothing new executes; this only ties a session to the governed queue.
//
// Governing law: RULES CALCULATE, AI INTERPRETS. The card fields are filled by the caller from real,
// already-computed facts — this helper adds no interpretation of its own.

import { createApproval, type NewApproval, type AiApproval } from "@/lib/aiorg/approvals";
import { linkSessionApproval, getSession, appendEvent } from "@/lib/ai/sessions";

/** Create an approval request on behalf of a session and link it. Idempotent end to end (createApproval
 *  dedupes on the idempotency key; linkSessionApproval dedupes on the pair). The session flips to
 *  awaiting_approval. Returns the approval, or null if the session does not exist / is already closed. */
export function proposeFromSession(
  sessionId: string,
  input: NewApproval,
  actor?: string,
): AiApproval | null {
  const session = getSession(sessionId);
  if (!session) return null;
  if (session.status === "done" || session.status === "failed" || session.status === "cancelled") {
    // A closed session cannot raise new actions — record the attempt honestly and refuse.
    appendEvent(sessionId, { kind: "error", actor: actor ?? null, label: "Proposal refused: session is closed" });
    return null;
  }
  const approval = createApproval(input);
  linkSessionApproval(sessionId, approval.id, actor);
  return approval;
}
