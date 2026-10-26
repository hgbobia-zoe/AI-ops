// Slack approver allowlist — WHO may approve/decide an AI action from Slack (the Block Kit buttons on an
// approval card). PURE (no DB, no implicit env): the list is normalized here and stored in app settings
// (editable in /admin → "Slack approvers"), with the SLACK_APPROVER_USER_IDS env var as the bootstrap
// default. Executing an approved op can message real customers, so the gate is deliberately strict + opt-in
// (empty → NOBODY, and the decision stays in the app).

export interface SlackApprover {
  /** Slack member id (e.g. "U09FK6KJ7GS"). The gate matches on THIS; it is what makes someone an approver. */
  id: string;
  /** Optional display name — for the admin UI only, never used by the gate. */
  name: string;
}

// Human Slack ids start with U (regular) or W (enterprise grid) and are uppercase alphanumeric. We validate
// loosely — enough to drop obvious junk (emails, names, blanks, bot/channel ids) without risking a real id —
// never for security (the gate is the membership check, not the format).
const ID_RE = /^[UW][A-Z0-9]{2,}$/;

export function isSlackUserId(v: unknown): v is string {
  return typeof v === "string" && ID_RE.test(v.trim());
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object";
}

/** Normalize an arbitrary stored/posted value into a clean approver list: valid ids only, trimmed names,
 *  de-duped by id (first wins, keeping its name). Accepts either bare id strings or `{ id, name }` objects.
 *  Returns `fallback` when the value isn't an array. Never throws. */
export function coerceSlackApprovers(v: unknown, fallback: SlackApprover[]): SlackApprover[] {
  if (!Array.isArray(v)) return fallback;
  const seen = new Set<string>();
  const out: SlackApprover[] = [];
  for (const raw of v) {
    const id = typeof raw === "string" ? raw.trim() : isRecord(raw) ? String(raw.id ?? "").trim() : "";
    if (!isSlackUserId(id) || seen.has(id)) continue;
    const name = isRecord(raw) && typeof raw.name === "string" ? raw.name.trim() : "";
    seen.add(id);
    out.push({ id, name });
  }
  return out;
}

/** Parse the SLACK_APPROVER_USER_IDS env var (comma-separated ids) into approvers (no names). This is the
 *  bootstrap default before anyone edits the list in /admin. */
export function approversFromEnv(raw: string | undefined): SlackApprover[] {
  return coerceSlackApprovers(
    (raw || "").split(",").map((s) => s.trim()).filter(Boolean),
    [],
  );
}

/** Just the ids — what the gate checks. */
export function approverIds(list: SlackApprover[]): string[] {
  return list.map((a) => a.id);
}
