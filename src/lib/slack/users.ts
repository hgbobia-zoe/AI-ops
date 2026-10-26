// Slack workspace user directory — used ONLY by the /admin "Slack approvers" picker, so an operator can add
// an approver by NAME instead of pasting a raw member id. Server-only: calls Slack's users.list with the bot
// token (SLACK_BOT_TOKEN, scope users:read). Best-effort — any failure (no token, API error, bad shape)
// returns whatever was gathered (often []), and the picker falls back to manual id entry. Never throws.

export interface SlackWorkspaceUser {
  id: string;
  /** The @handle (profile.display_name, else the username). */
  name: string;
  /** The person's real name, for display. */
  realName: string;
}

export async function listWorkspaceUsers(): Promise<SlackWorkspaceUser[]> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return [];
  const out: SlackWorkspaceUser[] = [];
  let cursor = "";
  try {
    // Page through the roster. Cap the loop (the workspace is small) so a misbehaving cursor can't spin.
    for (let page = 0; page < 20; page++) {
      const url = new URL("https://slack.com/api/users.list");
      url.searchParams.set("limit", "200");
      if (cursor) url.searchParams.set("cursor", cursor);
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
      const json = (await res.json()) as {
        ok?: boolean;
        members?: unknown[];
        response_metadata?: { next_cursor?: string };
      };
      if (!json.ok || !Array.isArray(json.members)) break;
      for (const raw of json.members) {
        const m = (raw ?? {}) as Record<string, unknown>;
        if (m.deleted === true || m.is_bot === true || m.id === "USLACKBOT") continue;
        const id = typeof m.id === "string" ? m.id : "";
        if (!id) continue;
        const profile = (m.profile ?? {}) as Record<string, unknown>;
        const name = String(profile.display_name || m.name || "").trim();
        const realName = String(profile.real_name || m.real_name || "").trim();
        out.push({ id, name, realName });
      }
      cursor = json.response_metadata?.next_cursor || "";
      if (!cursor) break;
    }
  } catch {
    return out; // whatever we gathered before the error
  }
  out.sort((a, b) => (a.realName || a.name || a.id).localeCompare(b.realName || b.name || b.id));
  return out;
}
