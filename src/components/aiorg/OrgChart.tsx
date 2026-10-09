"use client";

// OrgChart — the AI Org rendered as a REAL top-down org chart (Nocturne tokens), now INTERACTIVE:
// clicking any tile opens a right-side detail panel showing what that node does, and (owner/admin) an
// operational Pause switch. The hierarchy is:
//
//   Ownership (root)  →  Jessie / Lisa / Princess / Executive (branch heads, one horizontal rank)
//                        → each branch's AI employees hang beneath it as a vertical report list.
//
// COLOR: the chart is deliberately monochrome — Nocturne's single gold accent is RESERVED for human
// leadership (top accent + Lead/Owner tag), the green/amber dots carry live STATE only, and the backing
// badge keeps its reserved tones. AI report cards are neutral; department is read from the role label and
// the grouping, never from a clashing colored stripe (the old per-dept status-color stripes reused the
// reserved green/amber/gold, which is why the chart looked "off"). Connectors are CSS elbow lines.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { X, ExternalLink, Pause, Play, Loader2 } from "lucide-react";
import type { AiBacking, AiLiveState } from "@/lib/aiorg/types";
import type { OrgTree, OrgAgentNode, OrgBranchNode } from "@/lib/aiorg/orgTree";

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

function ago(ts: string | null | undefined): string {
  if (!ts) return "—";
  const min = Math.max(0, Math.round((Date.now() - Date.parse(ts)) / 60_000));
  if (!Number.isFinite(min)) return "—";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

type Selection =
  | { kind: "agent"; id: string }
  | { kind: "person"; name: string; role: string; owner: boolean; reports: OrgAgentNode[] };

export function OrgChart({ tree, canManage = false }: { tree: OrgTree; canManage?: boolean }): React.JSX.Element {
  const [sel, setSel] = useState<Selection | null>(null);
  // Live paused set, seeded from the server view, updated optimistically on toggle.
  const [pausedIds, setPausedIds] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const b of tree.branches) for (const a of b.agents) if (a.paused) s.add(a.id);
    return s;
  });

  // Flat id → agent index (for the detail panel + switching selection from a report list).
  const agentById = useMemo(() => {
    const m = new Map<string, OrgAgentNode>();
    for (const b of tree.branches) for (const a of b.agents) m.set(a.id, a);
    return m;
  }, [tree]);

  // The Executive branch's agents report directly up to Ownership — the owner panel lists them.
  const execBranch = useMemo(() => tree.branches.find((b) => b.department === "ops_exec") ?? null, [tree]);

  const selectAgent = useCallback((id: string) => setSel({ kind: "agent", id }), []);
  const selectBranch = useCallback(
    (b: OrgBranchNode) => setSel({ kind: "person", name: b.name, role: b.role, owner: false, reports: b.agents }),
    [],
  );
  const selectOwner = useCallback(
    (name: string) => setSel({ kind: "person", name, role: tree.owner.role, owner: true, reports: execBranch?.agents ?? [] }),
    [tree.owner.role, execBranch],
  );

  const selectedAgent = sel?.kind === "agent" ? agentById.get(sel.id) ?? null : null;

  return (
    <div className="oz-orgchart">
      <style>{CSS}</style>
      <div className="oz-scroll" role="region" aria-label="AI org chart" tabIndex={0}>
        <ul className="oz-tree">
          {/* Root — Ownership. Hermann + Cindy render as two co-owner tiles tied together; the org branches
              drop from the tie between them. */}
          <li>
            <div className={`oz-coowners${tree.owner.names.length > 1 ? " oz-coowners-tied" : ""}`}>
              {tree.owner.names.map((n) => (
                <PersonTile key={n} name={n} role={tree.owner.role} owner onSelect={() => selectOwner(n)} selected={sel?.kind === "person" && sel.owner && sel.name === n} />
              ))}
            </div>

            {/* Branch heads — one horizontal rank, connected to the root by elbow lines */}
            <ul>
              {tree.branches.map((b) => (
                <li key={b.key}>
                  {b.human ? (
                    <PersonTile name={b.name} role={b.role} onSelect={() => selectBranch(b)} selected={sel?.kind === "person" && !sel.owner && sel.name === b.name} />
                  ) : (
                    <GroupTile name={b.name} role={b.role} onSelect={() => selectBranch(b)} selected={sel?.kind === "person" && !sel.owner && sel.name === b.name} />
                  )}

                  {/* Reports — the AI employees, hanging vertically beneath the branch head */}
                  {b.agents.length > 0 && (
                    <div className="oz-reports">
                      {b.agents.map((a) => (
                        <AgentTile
                          key={a.id}
                          agent={a}
                          paused={pausedIds.has(a.id)}
                          onSelect={() => selectAgent(a.id)}
                          selected={sel?.kind === "agent" && sel.id === a.id}
                        />
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </li>
        </ul>
      </div>

      {sel && (
        <DetailPanel
          onClose={() => setSel(null)}
          onSelectAgent={selectAgent}
          canManage={canManage}
          pausedIds={pausedIds}
          setPausedIds={setPausedIds}
          {...(selectedAgent
            ? { kind: "agent" as const, agent: selectedAgent }
            : sel.kind === "person"
              ? { kind: "person" as const, person: sel }
              : { kind: "empty" as const })}
        />
      )}
    </div>
  );
}

// ── Tiles ────────────────────────────────────────────────────────────────────

/** A human leadership node — gold top accent + "Lead"/"Owner" tag (gold reserved for people). */
function PersonTile({ name, role, owner = false, onSelect, selected }: { name: string; role: string; owner?: boolean; onSelect: () => void; selected?: boolean }): React.JSX.Element {
  return (
    <button type="button" onClick={onSelect} aria-pressed={selected} className={`oz-node oz-person${owner ? " oz-owner" : ""}${selected ? " oz-selected" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[14px] font-medium text-foreground">{name}</span>
        <span className="rounded border border-[var(--gold)]/50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-[var(--gold)]">
          {owner ? "Owner" : "Lead"}
        </span>
      </div>
      <div className="mt-0.5 text-[11px] uppercase tracking-[0.07em] text-meta">{role}</div>
    </button>
  );
}

/** The cross-functional "Executive" branch head (not a single person). Dashed border = a group. */
function GroupTile({ name, role, onSelect, selected }: { name: string; role: string; onSelect: () => void; selected?: boolean }): React.JSX.Element {
  return (
    <button type="button" onClick={onSelect} aria-pressed={selected} className={`oz-node oz-group${selected ? " oz-selected" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[14px] font-medium text-foreground">{name}</span>
        <span className="rounded border border-border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-meta">Group</span>
      </div>
      <div className="mt-0.5 text-[11px] uppercase tracking-[0.07em] text-meta">{role}</div>
    </button>
  );
}

/** A leaf AI-employee node — neutral card, honest backing + live state, an "AI" chip, and a Paused mark
 *  when the operator has turned it off. Clicking opens the detail panel. */
function AgentTile({ agent, paused, onSelect, selected }: { agent: OrgAgentNode; paused: boolean; onSelect: () => void; selected?: boolean }): React.JSX.Element {
  return (
    <button type="button" onClick={onSelect} aria-pressed={selected} className={`oz-node oz-agent${selected ? " oz-selected" : ""}${paused ? " oz-paused" : ""}`}>
      <div className="flex items-center gap-2">
        <span className="oz-ai-chip" aria-hidden>AI</span>
        <span className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-foreground">{agent.name}</span>
        {paused ? (
          <Pause className="size-3 shrink-0 text-meta" aria-label="Paused" />
        ) : (
          <span className={`inline-block size-1.5 shrink-0 rounded-full ${STATE_DOT[agent.state]}`} aria-label={STATE_LABEL[agent.state]} title={STATE_LABEL[agent.state]} />
        )}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-left text-[10.5px] uppercase tracking-[0.06em] text-meta">{paused ? "Paused" : agent.title}</span>
        <span className={`rounded border px-1 py-px text-[8.5px] font-semibold uppercase tracking-[0.08em] ${BACKING_TONE[agent.backing]}`}>{BACKING_LABEL[agent.backing]}</span>
      </div>
    </button>
  );
}

// ── Detail panel (right-side drawer) ───────────────────────────────────────────

type PanelProps = {
  onClose: () => void;
  onSelectAgent: (id: string) => void;
  canManage: boolean;
  pausedIds: Set<string>;
  setPausedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
} & (
  | { kind: "agent"; agent: OrgAgentNode }
  | { kind: "person"; person: Extract<Selection, { kind: "person" }> }
  | { kind: "empty" }
);

function DetailPanel(props: PanelProps): React.JSX.Element {
  const { onClose } = props;
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="oz-drawer-root">
      <div className="oz-overlay" onClick={onClose} aria-hidden />
      <aside className="oz-drawer surface border" role="dialog" aria-modal="true" aria-label="Tile details">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">
            {props.kind === "agent" ? "AI employee" : props.kind === "person" ? (props.person.owner ? "Ownership" : "Team lead") : "Details"}
          </h2>
          <button ref={closeRef} type="button" onClick={onClose} className="rounded p-1 text-meta transition-colors hover:bg-[var(--row-hover)] hover:text-foreground" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>

        <div className="oz-drawer-body px-4 py-4">
          {props.kind === "agent" ? (
            <AgentDetail agent={props.agent} canManage={props.canManage} paused={props.pausedIds.has(props.agent.id)} setPausedIds={props.setPausedIds} />
          ) : props.kind === "person" ? (
            <PersonDetail person={props.person} onSelectAgent={props.onSelectAgent} pausedIds={props.pausedIds} />
          ) : null}
        </div>
      </aside>
    </div>
  );
}

function AgentDetail({ agent, canManage, paused, setPausedIds }: { agent: OrgAgentNode; canManage: boolean; paused: boolean; setPausedIds: React.Dispatch<React.SetStateAction<Set<string>>> }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const metrics = (agent.metrics ?? []).filter((m) => m.value !== "" && m.value != null);
  const coming = agent.backing === "coming";

  const toggle = useCallback(async () => {
    const next = !paused;
    setBusy(true); setErr(null);
    // Optimistic — reflect immediately, roll back on failure.
    setPausedIds((prev) => { const s = new Set(prev); if (next) s.add(agent.id); else s.delete(agent.id); return s; });
    try {
      const r = await fetch("/api/ai-org/agent-settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: agent.id, paused: next }) });
      if (!r.ok) throw new Error(String(r.status));
    } catch {
      setErr("Could not save. Try again.");
      setPausedIds((prev) => { const s = new Set(prev); if (next) s.delete(agent.id); else s.add(agent.id); return s; });
    } finally {
      setBusy(false);
    }
  }, [agent.id, paused, setPausedIds]);

  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="oz-ai-chip" aria-hidden>AI</span>
          <h3 className="text-[16px] font-medium text-foreground">{agent.name}</h3>
          <span className={`rounded border px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] ${BACKING_TONE[agent.backing]}`}>{BACKING_LABEL[agent.backing]}</span>
        </div>
        <div className="mt-1.5 flex items-center gap-2 text-[12px] text-meta">
          {paused ? (
            <span className="inline-flex items-center gap-1.5 text-tertiary-text"><Pause className="size-3" /> Paused</span>
          ) : (
            <span className="inline-flex items-center gap-1.5"><span className={`inline-block size-1.5 rounded-full ${STATE_DOT[agent.state]}`} /> {STATE_LABEL[agent.state]}</span>
          )}
          <span>·</span>
          <span>{agent.title}</span>
          <span>·</span>
          <span>Last run <span className="tabular-nums text-tertiary-text">{ago(agent.lastRunAt)}</span></span>
        </div>
        {agent.mission && <p className="mt-2 text-[13px] text-secondary-text">{agent.mission}</p>}
      </div>

      {/* Today's metrics */}
      {!coming && metrics.length > 0 && (
        <Field label="Today">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
            {metrics.map((m) => (
              <span key={m.label} className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
                <span className="text-[15px] font-medium tabular-nums text-foreground">{m.value}</span>
                <span className="text-[10.5px] uppercase tracking-[0.07em] text-meta">{m.label}</span>
              </span>
            ))}
          </div>
        </Field>
      )}

      {/* What it does */}
      {(agent.responsibilities?.length ?? 0) > 0 && (
        <Field label="What it does">
          <ul className="space-y-1.5 text-[13px] text-secondary-text">
            {agent.responsibilities!.map((r) => (
              <li key={r} className="flex items-start gap-2"><span className="mt-1.5 size-1 shrink-0 rounded-full bg-[var(--bar)]" /><span>{r}</span></li>
            ))}
          </ul>
        </Field>
      )}

      {/* Reads */}
      {(agent.inputs?.length ?? 0) > 0 && (
        <Field label="Reads from">
          <div className="flex flex-wrap gap-1.5">
            {agent.inputs!.map((inp) =>
              inp.href ? (
                <Link key={inp.label} href={inp.href} className="rounded border border-border px-2 py-0.5 text-[11.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">{inp.label}</Link>
              ) : (
                <span key={inp.label} className="rounded border border-border px-2 py-0.5 text-[11.5px] text-meta">{inp.label}</span>
              ),
            )}
          </div>
        </Field>
      )}

      {/* Authority */}
      {(agent.canCount != null || agent.approvalCount != null) && (
        <Field label="Authority">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[12.5px]">
            <span className="inline-flex items-baseline gap-1.5"><span className="text-[15px] font-medium tabular-nums text-foreground">{agent.canCount ?? 0}</span><span className="text-meta">can do unaided</span></span>
            <span className="inline-flex items-baseline gap-1.5"><span className="text-[15px] font-medium tabular-nums text-attention">{agent.approvalCount ?? 0}</span><span className="text-meta">need approval</span></span>
          </div>
        </Field>
      )}

      {/* How value is measured */}
      {agent.valueMeasure && (
        <Field label="Measured by"><p className="text-[12.5px] text-tertiary-text">{agent.valueMeasure}</p></Field>
      )}

      {/* Settings */}
      <div className="border-t border-border pt-4">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Settings</div>
        {canManage ? (
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[13px] text-foreground">{paused ? "Paused" : "Active"}</div>
              <p className="mt-0.5 max-w-[320px] text-[11.5px] text-meta">
                {coming ? "This agent isn’t wired to a data source yet, so there’s nothing to pause." : "Pause stops this agent from proposing anything. It’s an operational on/off switch — it doesn’t change what the agent is built to do."}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void toggle()}
              disabled={busy || coming}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded border px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50 ${paused ? "border-positive/50 text-positive hover:bg-positive/10" : "border-border text-tertiary-text hover:bg-[var(--row-hover)]"}`}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
              {paused ? "Resume" : "Pause"}
            </button>
          </div>
        ) : (
          <p className="text-[12px] text-meta">Only an owner or admin can change this agent’s settings.</p>
        )}
        {err && <p className="mt-2 text-[12px] text-critical">{err}</p>}

        <Link href={`/ai-org/${agent.id}`} className="mt-4 inline-flex items-center gap-1 text-[12.5px] text-[var(--gold)] transition-colors hover:underline">
          Open full profile <ExternalLink className="size-3.5" />
        </Link>
      </div>
    </div>
  );
}

function PersonDetail({ person, onSelectAgent, pausedIds }: { person: Extract<Selection, { kind: "person" }>; onSelectAgent: (id: string) => void; pausedIds: Set<string> }): React.JSX.Element {
  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center gap-2">
          <h3 className="text-[16px] font-medium text-foreground">{person.name}</h3>
          <span className="rounded border border-[var(--gold)]/50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-[var(--gold)]">{person.owner ? "Owner" : "Lead"}</span>
        </div>
        <div className="mt-0.5 text-[11px] uppercase tracking-[0.07em] text-meta">{person.role}</div>
        <p className="mt-2 text-[13px] text-secondary-text">
          {person.owner
            ? "Leads the organization. The cross-functional Executive agents report directly to ownership; each team lead runs their own AI employees below."
            : `Leads the ${person.role} team and the AI employees that report into it.`}
        </p>
      </div>

      <Field label={person.owner ? "Executive agents" : "Direct reports"}>
        {person.reports.length === 0 ? (
          <p className="text-[12.5px] text-meta">No AI employees report here yet.</p>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded border border-border">
            {person.reports.map((a) => {
              const paused = pausedIds.has(a.id);
              return (
                <li key={a.id}>
                  <button type="button" onClick={() => onSelectAgent(a.id)} className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--row-hover)]">
                    <span className="oz-ai-chip" aria-hidden>AI</span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{a.name}</span>
                    {paused ? (
                      <Pause className="size-3 shrink-0 text-meta" aria-label="Paused" />
                    ) : (
                      <span className={`inline-block size-1.5 shrink-0 rounded-full ${STATE_DOT[a.state]}`} aria-label={STATE_LABEL[a.state]} />
                    )}
                    <span className={`shrink-0 rounded border px-1 py-px text-[8.5px] font-semibold uppercase tracking-[0.08em] ${BACKING_TONE[a.backing]}`}>{BACKING_LABEL[a.backing]}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Field>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-tertiary-text">{label}</div>
      {children}
    </div>
  );
}

// Scoped connector CSS. All selectors live under .oz-orgchart so nothing leaks into the rest of the page.
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
.oz-orgchart .oz-tree > li { padding-top: 0; }
.oz-orgchart .oz-tree > li::before, .oz-orgchart .oz-tree > li::after { display: none; }
.oz-orgchart .oz-tree li:first-child::before, .oz-orgchart .oz-tree li:last-child::after { border: 0 none; }
.oz-orgchart .oz-tree li:last-child::before { border-right: 1px solid var(--border); border-radius: 0 4px 0 0; }
.oz-orgchart .oz-tree li:first-child::after { border-radius: 4px 0 0 0; }
.oz-orgchart .oz-tree ul::before {
  content: ""; position: absolute; top: 0; left: 50%; border-left: 1px solid var(--border); width: 0; height: 24px;
}

/* A node card (a button — reset the native look) */
.oz-orgchart .oz-node { position: relative; display: inline-block; vertical-align: top; width: 198px; text-align: left; border: 1px solid var(--border); background: var(--panel); border-radius: 8px; padding: 10px 12px; cursor: pointer; font: inherit; color: inherit; transition: background-color .12s ease, border-color .12s ease, box-shadow .12s ease; }
.oz-orgchart .oz-node:hover { background: var(--row-hover); border-color: var(--bar); }
.oz-orgchart .oz-node:focus-visible { outline: none; border-color: var(--gold); box-shadow: 0 0 0 2px color-mix(in oklab, var(--gold) 35%, transparent); }
.oz-orgchart .oz-selected { border-color: var(--gold); box-shadow: 0 0 0 1px var(--gold); }

/* Co-owners — Hermann + Cindy side by side at the top, tied by a horizontal connector whose midpoint
   drops into the branch bus (so the whole org reports up to the two co-owners). */
.oz-orgchart .oz-coowners { position: relative; display: flex; justify-content: center; align-items: center; gap: 56px; }
.oz-orgchart .oz-coowners-tied::before { content: ""; position: absolute; top: 50%; left: 50%; transform: translateX(-50%); width: 56px; height: 0; border-top: 1px solid var(--border); }
.oz-orgchart .oz-coowners-tied::after { content: ""; position: absolute; top: 50%; left: 50%; transform: translateX(-50%); width: 0; height: 50%; border-left: 1px solid var(--border); }

/* Human leadership — a solid gold top accent so people read differently from AI reports (gold reserved). */
.oz-orgchart .oz-person { border-top: 2px solid var(--gold); }
.oz-orgchart .oz-owner { width: 210px; }
/* The Executive group head — dashed to signal a group, not a seat */
.oz-orgchart .oz-group { border-style: dashed; }

/* Reports: the AI employees stacked vertically under a branch head, hanging off a left spine. */
.oz-orgchart .oz-tree ul > li > .oz-node::after { content: ""; position: absolute; top: 100%; left: 50%; width: 0; height: 14px; border-left: 1px solid var(--border); }
.oz-orgchart .oz-reports { position: relative; display: inline-block; text-align: left; margin-top: 14px; width: 198px; }
.oz-orgchart .oz-reports::after { content: ""; position: absolute; top: 0; left: 14px; width: calc(50% - 14px); height: 0; border-top: 1px solid var(--border); }
.oz-orgchart .oz-reports::before { content: ""; position: absolute; top: 0; left: 14px; width: 0; height: calc(100% - 20px); border-left: 1px solid var(--border); }
.oz-orgchart .oz-reports .oz-node { display: block; width: auto; margin: 0 0 10px 28px; }
.oz-orgchart .oz-reports .oz-node:last-child { margin-bottom: 0; }
.oz-orgchart .oz-reports .oz-node::before { content: ""; position: absolute; top: 20px; left: -14px; width: 14px; height: 0; border-top: 1px solid var(--border); }
/* AI report cards are neutral (NO per-department color stripe — department reads from the label + group) */
.oz-orgchart .oz-reports .oz-agent { border-left: 2px solid var(--bar); }
.oz-orgchart .oz-paused { opacity: 0.62; }

/* The AI chip on every agent card */
.oz-orgchart .oz-ai-chip, .oz-ai-chip { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 15px; padding: 0 3px; border-radius: 3px; background: var(--row-hover); border: 1px solid var(--border); color: var(--bar-2); font-size: 8.5px; font-weight: 700; letter-spacing: 0.06em; }

/* Detail drawer (right-side) */
.oz-drawer-root { position: fixed; inset: 0; z-index: 60; }
.oz-overlay { position: absolute; inset: 0; background: color-mix(in oklab, #000 55%, transparent); }
.oz-drawer { position: absolute; top: 0; right: 0; height: 100%; width: min(440px, 92vw); display: flex; flex-direction: column; border-left: 1px solid var(--border); background: var(--panel); animation: oz-slide-in .16s ease-out; }
.oz-drawer-body { overflow-y: auto; }
@keyframes oz-slide-in { from { transform: translateX(16px); opacity: 0.6; } to { transform: translateX(0); opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .oz-drawer { animation: none; } }
`;
