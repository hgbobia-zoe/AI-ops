// One row per person in the scheduling pickers and the Day schedule.
//
// Connecteam can hold two user records for the same person (for example an owner login plus a separate
// regular user made the same day), so the roster listed that name twice. This keeps ONE record per name and
// prefers the regular "user" account (the one crew shifts are made for). A record that is actually on a
// shift that day is never dropped, so a name lookup or an existing assignment can't break. Pure.

import type { CrewMember } from "@/lib/connecteam";

const nameKey = (m: CrewMember): string => m.name.trim().replace(/\s+/g, " ").toLowerCase();

/** Lower is better: a regular user account first, then any other non owner type, the owner login last. */
function rank(m: CrewMember): number {
  const t = (m.userType ?? "").toLowerCase();
  if (t === "user") return 0;
  if (t === "owner") return 2;
  return 1;
}

export function dedupeRosterByName(roster: CrewMember[], onShiftUserIds: Iterable<number> = []): CrewMember[] {
  const keep = new Set(onShiftUserIds);
  const best = new Map<string, CrewMember>();
  for (const m of roster) {
    const k = nameKey(m);
    const cur = best.get(k);
    if (!cur || rank(m) < rank(cur) || (rank(m) === rank(cur) && m.userId < cur.userId)) best.set(k, m);
  }
  return roster.filter((m) => keep.has(m.userId) || best.get(nameKey(m))?.userId === m.userId);
}
