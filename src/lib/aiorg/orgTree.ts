// AI Org — the org-chart hierarchy builder. A PURE, unit-testable helper that assembles the real
// HUMANS roster + derived AI_EMPLOYEES into a top-down tree for the org-chart UI. It fabricates nothing:
// every node comes from the registry (people + agents + their honest backing/state). The shape is:
//
//   Ownership (Hermann+Cindy, root)
//   ├── Jessie — Sales         → sales agents
//   ├── Lisa — Back Office      → backoffice agents
//   ├── Princess — Marketing    → marketing agents
//   └── Executive (cross-functional, under Ownership) → ops_exec agents
//
// The `owner` field on each AIEmployee already encodes the same mapping; DEPARTMENT_LEAD below is the
// explicit, roster-derived department→lead map the tree is built from, so the two can't drift silently
// (guarded by orgTree.test.ts).

import type { AiBacking, AiDept, AiLiveState, Human } from "./types";

/** Department → the human lead who owns it, derived from the real HUMANS roster roles (Sales=Jessie,
 *  Back Office=Lisa, Marketing=Princess, Ownership/Ops=Hermann+Cindy). ops_exec has no SEPARATE human
 *  lead: it hangs under Ownership as the cross-functional "Executive" branch, whose lead is the owner. */
export const DEPARTMENT_LEAD: Record<AiDept, string> = {
  sales: "Jessie",
  backoffice: "Lisa",
  marketing: "Princess",
  ops_exec: "Hermann+Cindy",
};

/** Human-readable department label (role line on an agent card + the Executive branch role). */
export const DEPT_LABEL: Record<AiDept, string> = {
  sales: "Sales",
  backoffice: "Back Office",
  marketing: "Marketing",
  ops_exec: "Ops / Exec",
};

/** Order the branches render left→right. ops_exec is last (the cross-functional Executive branch). */
const BRANCH_ORDER: AiDept[] = ["sales", "backoffice", "marketing", "ops_exec"];

// ── Tree node shapes ──────────────────────────────────────────────────────────

/** A leaf AI-employee node (all real data, carried through from the derived view). */
export interface OrgAgentNode {
  id: string;
  name: string;
  /** The role line shown under the name (the department label — agents have no separate title field). */
  title: string;
  department: AiDept;
  backing: AiBacking;
  state: AiLiveState;
}

/** A branch: a department's lead (a real person, or the cross-functional "Executive" group under the
 *  owner) plus the AI employees that report into it. */
export interface OrgBranchNode {
  /** Stable key: the human's name, or "executive" for the ops_exec group under Ownership. */
  key: string;
  /** Display name of the branch head ("Jessie", or "Executive"). */
  name: string;
  /** Role/dept label ("Sales", "Ops / Exec"). */
  role: string;
  department: AiDept;
  /** true = a real person leads this branch; false = a cross-functional group that reports to the owner. */
  human: boolean;
  agents: OrgAgentNode[];
}

export interface OrgTree {
  /** The root — the Ownership seat. The combined HUMANS entry ("Hermann+Cindy") is split into co-owner
   *  names for PRESENTATION (two tiles), while the registry keeps the single combined owner untouched. */
  owner: { names: string[]; role: string };
  branches: OrgBranchNode[];
}

/** Split a combined owner label ("Hermann+Cindy", "Hermann & Cindy", "Hermann and Cindy") into co-owner
 *  names. Presentation-only: the registry's HUMANS entry stays the single combined string. PURE. */
export function splitCoOwners(name: string): string[] {
  return name
    .split(/\s*(?:\+|&|\/|,|\band\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The minimal agent shape the tree needs — maps directly from an AiEmployeeView. */
export interface OrgAgentInput {
  id: string;
  name: string;
  department: AiDept;
  backing: AiBacking;
  state: AiLiveState;
}

/** Assemble the org-chart tree from the real roster + derived agents. PURE.
 *  - The root is the Ownership human (role starts with "Ownership"), falling back to DEPARTMENT_LEAD.ops_exec.
 *  - sales/backoffice/marketing render as human-led branches; ops_exec renders as the "Executive" group
 *    under the owner (no duplicate person node).
 *  - Every agent is placed under EXACTLY ONE branch, by its department. Input order is preserved, so the
 *    honest backing/state carried from the view is preserved too. */
export function buildOrgTree(humans: Human[], agents: OrgAgentInput[]): OrgTree {
  const ownerName = DEPARTMENT_LEAD.ops_exec;
  const ownerHuman =
    humans.find((h) => /ownership/i.test(h.role)) ?? humans.find((h) => h.name === ownerName);
  const owner = {
    // Presentation split: "Hermann+Cindy" → ["Hermann", "Cindy"] (two co-owner tiles). Registry unchanged.
    names: splitCoOwners(ownerHuman?.name ?? ownerName),
    role: ownerHuman?.role ?? "Ownership / Operations",
  };

  // Group agents by department, preserving input order.
  const byDept = new Map<AiDept, OrgAgentNode[]>();
  for (const a of agents) {
    const node: OrgAgentNode = {
      id: a.id,
      name: a.name,
      title: DEPT_LABEL[a.department],
      department: a.department,
      backing: a.backing,
      state: a.state,
    };
    const bucket = byDept.get(a.department);
    if (bucket) bucket.push(node);
    else byDept.set(a.department, [node]);
  }

  const branches: OrgBranchNode[] = BRANCH_ORDER.map((dept) => {
    const deptAgents = byDept.get(dept) ?? [];
    if (dept === "ops_exec") {
      // Cross-functional branch under the owner — no separate human lead.
      return { key: "executive", name: "Executive", role: DEPT_LABEL[dept], department: dept, human: false, agents: deptAgents };
    }
    const leadName = DEPARTMENT_LEAD[dept];
    const lead = humans.find((h) => h.name === leadName);
    return {
      key: leadName,
      name: lead?.name ?? leadName,
      role: lead?.role ?? DEPT_LABEL[dept],
      department: dept,
      human: true,
      agents: deptAgents,
    };
  });

  return { owner, branches };
}
