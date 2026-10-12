// People Lifecycle — shared types. The canonical Employee SPINE plus the access-policy + task shapes. Kept
// free of DB/IO so the pure modules (machine, policy) and the store share one vocabulary.

import type { Role } from "@/lib/auth/roles";

/** The whole-person lifecycle state. Happy path HIRE → ONBOARD → READY → ACTIVE, with OFFBOARD a trip
 *  state reachable from any live state (like CANCELLED on the event machine) and OFFBOARDED terminal. */
export type LifecycleState = "HIRE" | "ONBOARD" | "READY" | "ACTIVE" | "OFFBOARD" | "OFFBOARDED";

/** How honestly a provisioning adapter can act. `automated` is reserved for actions a scope-verified
 *  credential can truly perform; everything else degrades to a tracked manual/future task. */
export type AdapterMode = "automated" | "partial" | "manual" | "future";

/** A provisioning task either grants (provision) or removes (revoke) access to one system. */
export type TaskKind = "provision" | "revoke";

/** The task lifecycle. `manual_required` = waiting on a human to do it in the external system and confirm;
 *  `completed` requires evidence (an adapter result or a verified human Mark Complete), never a bare ack. */
export type TaskStatus =
  | "pending" //          queued; an automated action awaits its approval gate
  | "in_progress" //      approval raised / execution started
  | "completed" //        done (automated result OR verified human completion)
  | "failed" //           an automated attempt errored (retryable)
  | "manual_required" //  no admin API — a human must act in the external system, then Mark Complete
  | "skipped" //          deliberately not applicable for this person
  | "blocked"; //         waiting on a precondition (e.g. a future-dated termination not yet effective)

/** Who/what can carry a task to completion. */
export type TaskSource = "automated" | "manual";

/** The canonical Employee spine — links the disjoint person populations; never folds into users/hr_workers. */
export interface Employee {
  id: string;
  displayName: string;
  workEmail: string | null;
  lifecycleState: LifecycleState;
  role: Role;
  department: string | null; // access_policy.id
  startDate: string | null;
  endDate: string | null;
  userId: string | null;
  hrWorkerId: string | null;
  connecteamUserId: number | null;
  instaworkWorker: string | null;
  openphoneUserId: string | null;
  gustoId: string | null;
  aiOrgHumanName: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One system rule inside an access policy (the config that drives provision/revoke, not hard-coded UI). */
export interface PolicyRule {
  adapterId: string;
  system: string;
  required: boolean;
  mode: AdapterMode;
}

export interface AccessPolicy {
  id: string;
  name: string;
  seeded: boolean;
  rules: PolicyRule[];
}

export interface LifecycleTask {
  id: string;
  employeeId: string;
  adapterId: string;
  system: string;
  kind: TaskKind;
  title: string;
  status: TaskStatus;
  mode: AdapterMode;
  required: boolean;
  source: TaskSource;
  changeKey: string;
  externalRef: string | null;
  error: string | null;
  retryable: boolean;
  approvalId: string | null;
  actor: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** The result an adapter returns from automate()/revoke() — maps directly onto a task's next status. */
export interface ProvisioningResult {
  ok: boolean;
  status: TaskStatus;
  externalRef?: string;
  detail: string;
}
