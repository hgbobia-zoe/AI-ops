// Config-driven access policies. A policy is a named bundle of per-system rules (which adapter, required
// for READY?, and the adapter's honest mode). The UI renders whatever is HERE — it never hard-codes which
// systems a role gets or whether a system is automated. Seeded into the DB on first use (seeded=1) and
// admin-extensible later; this file is the source of the SEED only.
//
// Honesty rule (see the audit): the ONLY system reliably automatable today is the Zoe platform login
// (our own DB). Everything else is manual or future until a real admin API + scope-verified credential
// lands — so those modes say exactly that.

import type { AdapterMode, AccessPolicy, PolicyRule } from "./types";

/** The adapter catalogue — stable ids + display labels. One adapter per external system (plus our own). */
export const ADAPTER_LABEL: Record<string, string> = {
  zoe_platform: "Zoe platform login",
  google: "Google Workspace / SSO",
  slack: "Slack",
  quo: "Quo (OpenPhone)",
  goodshuffle: "Goodshuffle Pro",
  connecteam: "Connecteam",
  gusto: "Gusto",
};

const rule = (adapterId: string, mode: AdapterMode, required: boolean, systemLabel?: string): PolicyRule => ({
  adapterId,
  system: systemLabel ?? ADAPTER_LABEL[adapterId] ?? adapterId,
  required,
  mode,
});

// The seeded policies. Modes mirror the feasibility audit exactly — do not inflate a manual/future system
// to "automated". `required` drives READY: a person is READY only when every required provision task is
// completed (a human may Mark Complete the manual/future ones).
export const SEED_POLICIES: AccessPolicy[] = [
  {
    id: "sales",
    name: "Sales Rep",
    seeded: true,
    rules: [
      rule("zoe_platform", "automated", true),
      rule("goodshuffle", "manual", true),
      rule("quo", "manual", true),
      rule("connecteam", "manual", true),
      rule("slack", "manual", false),
      rule("google", "future", false),
    ],
  },
  {
    id: "warehouse",
    name: "Warehouse",
    seeded: true,
    rules: [rule("connecteam", "manual", true)],
  },
  {
    id: "driver",
    name: "Driver",
    seeded: true,
    rules: [
      rule("connecteam", "manual", true),
      rule("zoe_platform", "automated", true, "Zoe Dispatch login"),
    ],
  },
  {
    id: "operations",
    name: "Operations",
    seeded: true,
    rules: [
      rule("zoe_platform", "automated", true),
      rule("connecteam", "manual", true),
      rule("quo", "manual", false),
      rule("slack", "manual", false),
    ],
  },
  {
    id: "admin",
    name: "Admin / Office",
    seeded: true,
    rules: [
      rule("zoe_platform", "automated", true),
      rule("goodshuffle", "manual", true),
      rule("quo", "manual", false),
      rule("slack", "manual", false),
      rule("gusto", "manual", false),
    ],
  },
  {
    id: "manager",
    name: "Manager",
    seeded: true,
    rules: [
      rule("zoe_platform", "automated", true),
      rule("connecteam", "manual", true),
      rule("quo", "manual", false),
      rule("slack", "manual", false),
    ],
  },
];

/** Look a seed policy up by id. PURE (seed only — the live admin-extensible set is read via the store). */
export function seedPolicy(id: string): AccessPolicy | null {
  return SEED_POLICIES.find((p) => p.id === id) ?? null;
}
