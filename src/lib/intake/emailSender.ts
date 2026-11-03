// Who Goodshuffle client emails go out as. Goodshuffle has no sender field: an email is sent as whoever is
// signed in to the session that drains the outbox. So the outbox hands email ops (welcome template, email
// replies) only to a drainer that checks it is signed in as this person; any other session leaves them
// pending. Owner call 2026-11-03: Jessie Medalla, until a dedicated automation seat exists ($49/mo each).
//
// GS_EMAIL_SENDER overrides: a full name ("First Last") or an email; "any" (or "off") turns the hold off.

export const DEFAULT_EMAIL_SENDER = "Jessie Medalla";
export const EMAIL_OPS: ReadonlySet<string> = new Set(["email_send", "email_template"]);

/** The required sender, or null when any signed-in session may send. */
export function emailSenderName(env: Record<string, string | undefined> = process.env): string | null {
  const v = (env.GS_EMAIL_SENDER ?? "").trim();
  if (!v) return DEFAULT_EMAIL_SENDER;
  if (/^(any|off|none|false|0)$/i.test(v)) return null;
  return v;
}

/** The ops a drainer may see. A drainer that does not enforce the sender hold (older extension or
 *  bookmarklet copies, no ?senderHold=1) gets no email ops while a sender is required. */
export function opsForDrainer<T extends { op: string }>(ops: T[], honorsSenderHold: boolean, sender: string | null): T[] {
  if (!sender || honorsSenderHold) return ops;
  return ops.filter((o) => !EMAIL_OPS.has(o.op));
}
