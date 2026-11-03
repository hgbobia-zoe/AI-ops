// Connecteam write access record. The Connecteam adapter only automates when `connecteam.provisioningScope`
// is "verified", and the ONLY thing that sets it is a real probe of the API key (connecteamWriteProbe,
// which creates nobody). A failed probe, or a scope denial at run time, clears it again, so the record
// always matches what the key can actually do.
//
// Flipping the record also moves the open Connecteam checklist steps between "waiting for approval"
// (automated) and "do by hand" (manual), so the checklist shows the real capability.

import { connecteamConfigured, connecteamWriteProbe } from "@/lib/connecteam";
import { getSecret, setSecret } from "@/lib/secrets";
import { getJson, setJson } from "@/lib/kv";
import { insertAudit } from "@/lib/db/repo";
import { tasksByStatus, updateTask } from "./store";

const SCOPE_KEY = "connecteam.provisioningScope";
const META_KEY = "people.connecteamScope";

export interface ConnecteamScopeMeta {
  checkedAt: string;
  by: string;
  ok: boolean;
  detail: string;
}

export interface ConnecteamScopeStatus {
  configured: boolean;
  verified: boolean;
  last: ConnecteamScopeMeta | null;
}

export function connecteamScopeStatus(): ConnecteamScopeStatus {
  return {
    configured: connecteamConfigured(),
    verified: getSecret(SCOPE_KEY) === "verified",
    last: getJson<ConnecteamScopeMeta | null>(META_KEY, null),
  };
}

function audit(actor: string, action: string, after: unknown): void {
  try {
    insertAudit({ actor, action, entity: "people_system", entityId: "connecteam", before: null, after });
  } catch {
    /* audit best effort */
  }
}

/** Move the open Connecteam steps to match the capability. Returns how many changed. */
function syncOpenConnecteamTasks(automated: boolean): number {
  let n = 0;
  for (const kind of ["provision", "revoke"] as const) {
    const from = automated ? (["manual_required"] as const) : (["pending"] as const);
    for (const t of tasksByStatus(kind, [...from])) {
      if (t.adapterId !== "connecteam") continue;
      updateTask(t.id, automated
        ? { status: "pending", mode: "automated", source: "automated", error: null }
        : { status: "manual_required", mode: "manual", source: "manual" });
      n++;
    }
  }
  return n;
}

/** Probe the key and set or clear the verified record from the result. Creates nothing in Connecteam. */
export async function verifyConnecteamScope(actor: string): Promise<ConnecteamScopeMeta & { tasksUpdated: number }> {
  const probe = await connecteamWriteProbe();
  const meta: ConnecteamScopeMeta = { checkedAt: new Date().toISOString(), by: actor, ok: probe.ok, detail: probe.detail };
  setJson(META_KEY, meta);
  const was = getSecret(SCOPE_KEY) === "verified";
  let tasksUpdated = 0;
  if (probe.ok) {
    setSecret(SCOPE_KEY, "verified");
    tasksUpdated = syncOpenConnecteamTasks(true);
  } else if (probe.scopeMissing) {
    // Only a definite "no write scope" clears it; an unreachable API proves nothing either way.
    setSecret(SCOPE_KEY, null);
    if (was) tasksUpdated = syncOpenConnecteamTasks(false);
  }
  audit(actor, probe.ok ? "CONNECTEAM_SCOPE_VERIFIED" : "CONNECTEAM_SCOPE_CHECK_FAILED", { ...meta, httpStatus: probe.status });
  return { ...meta, tasksUpdated };
}

/** Clear the record after Connecteam refused a real write. */
export function clearConnecteamScope(actor: string, reason: string): void {
  if (getSecret(SCOPE_KEY) !== "verified") return;
  setSecret(SCOPE_KEY, null);
  const meta: ConnecteamScopeMeta = { checkedAt: new Date().toISOString(), by: actor, ok: false, detail: reason };
  setJson(META_KEY, meta);
  syncOpenConnecteamTasks(false);
  audit(actor, "CONNECTEAM_SCOPE_CLEARED", meta);
}
