// OrgChart — the AI Org rendered as a REAL top-down org chart (Nocturne tokens). Server component: it is
// static structure + links, no interaction, so it needs no "use client". The hierarchy is:
//
//   Ownership (root)  →  Jessie / Lisa / Princess / Executive (branch heads, one horizontal rank)
//                        → each branch's AI employees hang beneath it as a vertical report list.
//
// Connectors are drawn with CSS (scoped under .oz-orgchart): the classic nested ul/li ::before/::after
// elbow lines connect the root to the branch heads; a left spine + ticks connects each branch head to its
// AI reports. The whole chart lives in a horizontally-scrollable container so a wide tree never breaks the
// page on a phone.

import type React from "react";
import Link from "next/link";
import type { AiBacking, AiLiveState } from "@/lib/aiorg/types";
import type { OrgTree, OrgAgentNode } from "@/lib/aiorg/orgTree";

const STATE_DOT: Record<AiLiveState, string> = {
  ok: "bg-positive",
  attention: "bg-attention",
  idle: "bg-[var(--bar)]",
  coming: "bg-[var(--bar)]",
};
const STATE_LABEL: Record<AiLiveState, string> = { ok: "Active", attention: "Needs attention", idle: "Idle", coming: "Coming" };

const BACKING_LABEL: Record<AiBacking, string> = { live: "LIVE", seed: "SEED", partial: "PARTIAL", coming: "COMING" };
const BACKING_TONE: Record<AiBacking, string> = {
  live: "border-positive/40 text-positive",
  seed: "border-attention/40 text-attention",
  partial: "border-border text-tertiary-text",
  coming: "border-border text-meta",
};

/** A left tint stripe per department so each branch's reports read as one team. */
const DEPT_TINT: Record<string, string> = {
  sales: "var(--positive)",
  backoffice: "var(--gold)",
  marketing: "var(--attention)",
  ops_exec: "var(--bar-2)",
};

export function OrgChart({ tree }: { tree: OrgTree }): React.JSX.Element {
  return (
    <div className="oz-orgchart">
      <style>{CSS}</style>
      <div className="oz-scroll" role="region" aria-label="AI org chart" tabIndex={0}>
        <ul className="oz-tree">
          {/* Root — Ownership (an only-child li, so it has no connector above it). Hermann + Cindy render
              as two co-owner tiles tied together; the org branches drop from the tie between them. */}
          <li>
            <div className={`oz-coowners${tree.owner.names.length > 1 ? " oz-coowners-tied" : ""}`}>
              {tree.owner.names.map((n) => (
                <PersonCard key={n} name={n} role={tree.owner.role} owner />
              ))}
            </div>

            {/* Branch heads — one horizontal rank, connected to the root by elbow lines */}
            <ul>
              {tree.branches.map((b) => (
                <li key={b.key}>
                  {b.human ? <PersonCard name={b.name} role={b.role} /> : <GroupCard name={b.name} role={b.role} />}

                  {/* Reports — the AI employees, hanging vertically beneath the branch head */}
                  {b.agents.length > 0 && (
                    <div className="oz-reports" style={{ ["--tint" as string]: DEPT_TINT[b.department] ?? "var(--bar)" }}>
                      {b.agents.map((a) => (
                        <AgentCard key={a.id} agent={a} />
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </li>
        </ul>
      </div>
    </div>
  );
}

/** A human leadership node. Distinguished from AI nodes by a solid gold accent bar + "Lead"/"Owner" tag. */
function PersonCard({ name, role, owner = false }: { name: string; role: string; owner?: boolean }): React.JSX.Element {
  return (
    <div className={`oz-node oz-person${owner ? " oz-owner" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[14px] font-medium text-foreground">{name}</span>
        <span className="rounded border border-[var(--gold)]/50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-[var(--gold)]">
          {owner ? "Owner" : "Lead"}
        </span>
      </div>
      <div className="mt-0.5 text-[11px] uppercase tracking-[0.07em] text-meta">{role}</div>
    </div>
  );
}

/** The cross-functional "Executive" branch head (not a single person). Dashed border = a group, not a seat. */
function GroupCard({ name, role }: { name: string; role: string }): React.JSX.Element {
  return (
    <div className="oz-node oz-group">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[14px] font-medium text-foreground">{name}</span>
        <span className="rounded border border-border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-meta">Group</span>
      </div>
      <div className="mt-0.5 text-[11px] uppercase tracking-[0.07em] text-meta">{role}</div>
    </div>
  );
}

/** A leaf AI-employee node — links to its detail page, shows the honest backing + live state, and carries
 *  an "AI" chip so it is always clear this report is an agent, not a person. */
function AgentCard({ agent }: { agent: OrgAgentNode }): React.JSX.Element {
  return (
    <Link href={`/ai-org/${agent.id}`} className="oz-node oz-agent group">
      <div className="flex items-center gap-2">
        <span className="oz-ai-chip" aria-hidden>AI</span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{agent.name}</span>
        <span className={`inline-block size-1.5 shrink-0 rounded-full ${STATE_DOT[agent.state]}`} aria-label={STATE_LABEL[agent.state]} title={STATE_LABEL[agent.state]} />
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-[10.5px] uppercase tracking-[0.06em] text-meta">{agent.title}</span>
        <span className={`rounded border px-1 py-px text-[8.5px] font-semibold uppercase tracking-[0.08em] ${BACKING_TONE[agent.backing]}`}>{BACKING_LABEL[agent.backing]}</span>
      </div>
    </Link>
  );
}

// Scoped connector CSS. All selectors live under .oz-orgchart so nothing leaks into the rest of the page.
// The root→branch-heads elbows use the classic nested-ul/li technique; the branch-head→reports uses a left
// spine with per-report ticks.
const CSS = `
.oz-orgchart .oz-scroll { overflow-x: auto; overflow-y: hidden; padding: 8px 4px 20px; -webkit-overflow-scrolling: touch; }
.oz-orgchart .oz-scroll:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }

.oz-orgchart .oz-tree, .oz-orgchart .oz-tree ul { display: flex; justify-content: center; list-style: none; margin: 0; padding: 0; }
.oz-orgchart .oz-tree ul { padding-top: 24px; }
.oz-orgchart .oz-tree li { position: relative; list-style: none; padding: 24px 12px 0; text-align: center; }

/* The elbow connectors between a parent and its row of children (classic CSS org-chart technique) */
.oz-orgchart .oz-tree li::before, .oz-orgchart .oz-tree li::after {
  content: ""; position: absolute; top: 0; width: 50%; height: 24px; border-top: 1px solid var(--border);
}
.oz-orgchart .oz-tree li::before { right: 50%; }
.oz-orgchart .oz-tree li::after { left: 50%; border-left: 1px solid var(--border); }
/* an only-child (the root) has nothing above it */
.oz-orgchart .oz-tree > li { padding-top: 0; }
.oz-orgchart .oz-tree > li::before, .oz-orgchart .oz-tree > li::after { display: none; }
/* trim the overhanging bus ends on the outermost children; last-child draws the corner down-line */
.oz-orgchart .oz-tree li:first-child::before, .oz-orgchart .oz-tree li:last-child::after { border: 0 none; }
.oz-orgchart .oz-tree li:last-child::before { border-right: 1px solid var(--border); border-radius: 0 4px 0 0; }
.oz-orgchart .oz-tree li:first-child::after { border-radius: 4px 0 0 0; }
/* the single vertical line from the root down into the branch-head bus (nested ul only) */
.oz-orgchart .oz-tree ul::before {
  content: ""; position: absolute; top: 0; left: 50%; border-left: 1px solid var(--border); width: 0; height: 24px;
}

/* A node card */
.oz-orgchart .oz-node { position: relative; display: inline-block; vertical-align: top; width: 198px; text-align: left; border: 1px solid var(--border); background: var(--panel); border-radius: 8px; padding: 10px 12px; }
.oz-orgchart a.oz-node { transition: background-color .12s ease, border-color .12s ease; }
.oz-orgchart a.oz-node:hover { background: var(--row-hover); border-color: var(--bar); }

/* Co-owners — Hermann + Cindy side by side at the top, tied by a horizontal connector whose midpoint
   drops into the branch bus (so the whole org reports up to the two co-owners). */
.oz-orgchart .oz-coowners { position: relative; display: flex; justify-content: center; align-items: center; gap: 56px; }
.oz-orgchart .oz-coowners-tied::before { content: ""; position: absolute; top: 50%; left: 50%; transform: translateX(-50%); width: 56px; height: 0; border-top: 1px solid var(--border); }
.oz-orgchart .oz-coowners-tied::after { content: ""; position: absolute; top: 50%; left: 50%; transform: translateX(-50%); width: 0; height: 50%; border-left: 1px solid var(--border); }

/* Human leadership — a solid gold top accent so people read differently from AI reports */
.oz-orgchart .oz-person { border-top: 2px solid var(--gold); }
.oz-orgchart .oz-owner { width: 210px; }
/* The Executive group head — dashed to signal a group, not a seat */
.oz-orgchart .oz-group { border-style: dashed; }

/* Reports: the AI employees stacked vertically under a branch head, hanging off a left spine.
   The head connects to the spine with an elbow: a drop from the head's bottom-centre (node::after) into
   a short horizontal connector (reports::after) that meets the spine top (reports::before). */
.oz-orgchart .oz-tree ul > li > .oz-node::after { content: ""; position: absolute; top: 100%; left: 50%; width: 0; height: 14px; border-left: 1px solid var(--border); }
.oz-orgchart .oz-reports { position: relative; display: inline-block; text-align: left; margin-top: 14px; width: 198px; }
/* the horizontal connector from the head's drop (centre) to the spine (left) */
.oz-orgchart .oz-reports::after { content: ""; position: absolute; top: 0; left: 14px; width: calc(50% - 14px); height: 0; border-top: 1px solid var(--border); }
/* the spine: a vertical line down the left, from the connector to the last report's tick */
.oz-orgchart .oz-reports::before { content: ""; position: absolute; top: 0; left: 14px; width: 0; height: calc(100% - 20px); border-left: 1px solid var(--border); }
.oz-orgchart .oz-reports .oz-node { display: block; width: auto; margin: 0 0 10px 28px; }
.oz-orgchart .oz-reports .oz-node:last-child { margin-bottom: 0; }
/* each report's horizontal tick off the spine */
.oz-orgchart .oz-reports .oz-node::before { content: ""; position: absolute; top: 20px; left: -14px; width: 14px; height: 0; border-top: 1px solid var(--border); }
/* a department tint stripe down the left edge of each report card */
.oz-orgchart .oz-reports .oz-agent { border-left: 3px solid var(--tint, var(--bar)); }

/* The AI chip on every agent card */
.oz-orgchart .oz-ai-chip { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 15px; padding: 0 3px; border-radius: 3px; background: var(--row-hover); border: 1px solid var(--border); color: var(--bar-2); font-size: 8.5px; font-weight: 700; letter-spacing: 0.06em; }
`;
