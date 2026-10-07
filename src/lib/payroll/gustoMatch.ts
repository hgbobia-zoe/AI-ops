// Gusto worker matching — reconcile the Gusto snapshot (payroll SoR for identity + classification) against
// the Connecteam roster, persisting a Gusto mapping onto hr_workers for every EXACT, UNIQUE normalized-name
// match. Ambiguous names (more than one candidate) are NEVER silently matched (spec §2) — they're left for
// manual mapping. On a match we also set the authoritative worker_type + country from Gusto. Idempotent.

import { getUsers } from "@/lib/connecteam";
import { readGustoSnapshot, type GustoSnapshotMember } from "./gustoSnapshot";
import { gustoIsInternational } from "./gusto";
import { ensureWorkerFromConnecteam, updateWorker } from "./store";
import type { WorkerType } from "./types";

function norm(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
function memberNames(m: GustoSnapshotMember): string[] {
  const names: string[] = [];
  const legal = `${m.firstName} ${m.lastName}`.trim();
  if (legal) names.push(norm(legal));
  if (m.preferredName) names.push(norm(m.preferredName));
  return [...new Set(names.filter(Boolean))];
}
function classify(m: GustoSnapshotMember): WorkerType {
  if (m.personType === "employee") return "EMPLOYEE";
  if (m.personType === "contractor") return gustoIsInternational(m.country) ? "INTERNATIONAL_CONTRACTOR" : "US_CONTRACTOR";
  return "UNKNOWN";
}

export interface GustoMatchResult {
  gustoMembers: number;
  connecteamWorkers: number;
  matched: number; // exact-unique name match → gusto_id persisted
  ambiguous: number; // name matched >1 Connecteam worker → left for manual mapping
  unmatchedGusto: number; // Gusto members with no Connecteam counterpart
}

export async function reconcileGustoFromSnapshot(): Promise<GustoMatchResult> {
  const snap = readGustoSnapshot();
  if (!snap) return { gustoMembers: 0, connecteamWorkers: 0, matched: 0, ambiguous: 0, unmatchedGusto: 0 };
  const roster = await getUsers(); // cached Map<userId, CrewMember>

  const nameToUserIds = new Map<string, number[]>();
  for (const m of roster.values()) {
    const k = norm(m.name);
    if (!k) continue;
    nameToUserIds.set(k, [...(nameToUserIds.get(k) ?? []), m.userId]);
  }

  let matched = 0;
  let ambiguous = 0;
  let unmatchedGusto = 0;
  for (const gm of snap.members) {
    const candidates = new Set<number>();
    for (const nm of memberNames(gm)) for (const uid of nameToUserIds.get(nm) ?? []) candidates.add(uid);
    if (candidates.size === 0) { unmatchedGusto++; continue; }
    if (candidates.size > 1) { ambiguous++; continue; } // never silently pick among ambiguous names
    const userId = [...candidates][0];
    const ct = roster.get(userId)!;
    const rec = ensureWorkerFromConnecteam({ connecteamUserId: userId, name: ct.name, email: ct.email ?? null });
    updateWorker(rec.id, {
      gustoId: gm.id,
      gustoEntityType: gm.personType === "contractor" ? "contractor" : "employee",
      workerType: classify(gm),
      country: gm.country ?? rec.country,
    });
    matched++;
  }
  return { gustoMembers: snap.members.length, connecteamWorkers: roster.size, matched, ambiguous, unmatchedGusto };
}
