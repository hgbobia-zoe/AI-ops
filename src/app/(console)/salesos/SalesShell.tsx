"use client";

// Sales OS shell (Nocturne redesign). ONE consistent blade header — a "Sales OS" page title, a view-aware
// scope line, and an aligned toolbar (view switcher · state filter · "Needs details" scope · search) —
// sits above whichever view is active (Board / Worklist / Table). The compact AI-employee strip is placed
// AFTER the heading and controls, so the work (not the bots) leads the page. The analytical sub-views
// (Bid / Lost / Trends / Status / Outreach) render themselves full-width; the shell steps aside for them.
//
// The Worklist is rendered by this shell: an action-queue table grouped Act now / Today / Monitor, whose
// row click opens the full lead in the shared overlay side panel (local state — no navigation). The Board
// and Table render as children under the same header.
//
// A single project search bar + the state filter + the "Needs details" (incomplete-record) scope live in
// SalesSearchProvider and are mirrored to the URL, so they survive the Board/Worklist/Table toggle and are
// shareable. Every view filters its own set with the same matchesQuery / matchesState / isIncompleteProject,
// so a query, a state and the incomplete scope mean the same thing everywhere; counts stay honest.

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { List, Table2, Columns3, Target } from "lucide-react";
import type { QueueItem } from "@/lib/salesos/commandCenter";
import { NBA_LABEL } from "@/lib/salesos/nba";
import { matchesQuery, matchesState, isIncompleteProject, relativeEvent } from "@/lib/salesos/search";
import { LeadSidePanel } from "@/components/LeadSidePanel";
import { SalesSearchProvider, SalesSearchBar, StateFilterBar, IncompleteToggle, SearchCount, useSalesSearch, withQuery } from "@/components/SalesSearch";
import { PageHeader, Toolbar } from "@/components/ui/page-header";
import { FigureStrip, ActionVerb, Provenance, tierBar, tierActionTone, tierValueText, tableCls, theadCls, thCls, type Tier, type Figure } from "@/components/console-primitives";

const money = (n: number | null): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));

// Tier from the transparent NBA priority (≥80 act now, ≥45 today, else monitor).
function tierOf(it: QueueItem): Tier {
  const p = it.nba.priority;
  if (p >= 80) return "now";
  if (p >= 45) return "today";
  return "passive";
}
function repliedLabel(mins: number | null): string | null {
  if (mins == null) return null;
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}
const isInferred = (src: string): boolean => src === "inbound_reply" || src === "derived" || src === "inferred";

// A QueueItem projected onto the shared searchable shape (the worklist shows the customer-state label).
const toSearchable = (it: QueueItem) => ({
  id: it.id,
  clientName: it.clientName,
  eventName: it.eventName,
  value: it.value,
  stage: it.stateLabel,
  venue: it.venue,
  location: it.location,
});

type ViewKey = "worklist" | "table" | "board";

const SCOPE: Record<ViewKey, string> = {
  board: "Pipeline by stage — drag a card, or use its Move control, to change a lead's stage.",
  worklist: "Ranked action queue — the highest-value, most time-sensitive work first.",
  table: "Every open project — sort any column, filter by status.",
};

export function SalesShell({
  queue,
  showMoney,
  justReplied,
  totalPotential,
  viewer,
  agentStrip,
  children,
}: {
  queue: QueueItem[];
  showMoney: boolean;
  needAttention: number;
  justReplied: number;
  totalPotential: number | null;
  viewer: { name: string; quoUserId: string | null; initials: string };
  /** The compact AI-employee strip, rendered by the (server) layout and placed AFTER the heading. */
  agentStrip?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  const pathname = usePathname();
  const seg = pathname.split("/")[2] ?? "";
  // Analytical / full-width sub-views render themselves; the shared header + master-detail step aside.
  if (seg === "bid" || seg === "lost" || seg === "trends" || seg === "status" || seg === "outreach") return <>{children}</>;

  // Board is the default view (/salesos redirects to /salesos/board). The worklist is rendered by this
  // shell; every other path (board, table, a lead-id deep link) renders its own page as children under
  // the shared header (view switcher + filters + search).
  const view: ViewKey = seg === "worklist" ? "worklist" : seg === "table" ? "table" : "board";

  return (
    <SalesSearchProvider>
      <div className="flex min-w-0 flex-1 flex-col">
        <SalesHeader active={view} />
        {agentStrip && <div className="px-6 pt-3">{agentStrip}</div>}
        {view === "worklist" ? (
          <WorklistBody queue={queue} showMoney={showMoney} justReplied={justReplied} totalPotential={totalPotential} viewer={viewer} />
        ) : (
          <div className="min-w-0 flex-1">{children}</div>
        )}
      </div>
    </SalesSearchProvider>
  );
}

function SalesHeader({ active }: { active: ViewKey }): React.JSX.Element {
  return (
    <div className="px-6 pt-4">
      <PageHeader title="Sales OS" icon={<Target className="size-5" />} subtitle={SCOPE[active]} className="mb-3" />
      <Toolbar>
        <ViewSwitcher active={active} />
        <div className="flex flex-wrap items-center gap-2">
          {/* The Table view carries its own richer status chips (all five states + counts), so the shared
              header filter would be redundant there; everywhere else it's the single state control. */}
          {active !== "table" && <StateFilterBar />}
          <IncompleteToggle />
          <SalesSearchBar />
        </div>
      </Toolbar>
    </div>
  );
}

function WorklistBody({
  queue,
  showMoney,
  justReplied,
  totalPotential,
  viewer,
}: {
  queue: QueueItem[];
  showMoney: boolean;
  justReplied: number;
  totalPotential: number | null;
  viewer: { name: string; quoUserId: string | null; initials: string };
}): React.JSX.Element {
  const { query, stateFilter, incompleteOnly } = useSalesSearch();
  const [selected, setSelected] = useState<string | null>(null);

  // Search, state filter and the incomplete scope compose: a row must match the query AND (if set) the
  // selected lead state AND (if the "Needs details" scope is on) be an incomplete record.
  const filtered = useMemo(
    () =>
      queue.filter(
        (q) =>
          matchesQuery(toSearchable(q), query) &&
          matchesState(q.boardStatus, stateFilter) &&
          (!incompleteOnly || isIncompleteProject(q)),
      ),
    [queue, query, stateFilter, incompleteOnly],
  );

  const now = filtered.filter((q) => tierOf(q) === "now");
  const today = filtered.filter((q) => tierOf(q) === "today");
  const monitor = filtered.filter((q) => tierOf(q) === "passive");

  // Figures reflect the filtered set so the header never contradicts the rows below it.
  const filteredPotential = showMoney ? filtered.reduce<number | null>((sum, q) => (q.value != null ? (sum ?? 0) + q.value : sum), null) : null;
  const figures: Figure[] = [
    { label: "Act now", value: now.length, tone: now.length ? "critical" : "default" },
    { label: "Today", value: today.length, tone: today.length ? "attention" : "default" },
    { label: "Replied 24h", value: justReplied },
    ...(showMoney
      ? ([{ label: "Open", value: filtered.length, sep: true }, { label: "Pipeline", value: money(query.trim() || incompleteOnly ? filteredPotential : totalPotential) }] as Figure[])
      : ([{ label: "Open", value: filtered.length, sep: true }] as Figure[])),
  ];

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 pt-4 pb-3">
        <SearchCount shown={filtered.length} total={queue.length} />
        <FigureStrip figures={figures} />
      </div>

      {/* Action queue — full width. Clicking a row opens the full lead in an overlay side panel. */}
      <div className="min-w-0 flex-1 overflow-auto border-t border-border">
        {queue.length === 0 ? (
          <p className="px-6 py-16 text-center text-[13.5px] text-muted-foreground">No active opportunities.</p>
        ) : filtered.length === 0 ? (
          <p className="px-6 py-16 text-center text-[13.5px] text-muted-foreground">
            {query.trim() ? (
              <>No projects match &ldquo;{query.trim()}&rdquo;{stateFilter ? " in this state" : ""}{incompleteOnly ? " needing details" : ""}.</>
            ) : incompleteOnly ? (
              "No incomplete projects in this scope."
            ) : (
              "No projects in this state."
            )}
          </p>
        ) : (
          <table className={tableCls}>
            <colgroup>
              <col style={{ width: "88px" }} />
              <col />
              <col style={{ width: "150px" }} />
              <col style={{ width: "180px" }} />
              <col style={{ width: "150px" }} />
              <col style={{ width: "120px" }} />
            </colgroup>
            <thead className={theadCls}>
              <tr>
                <th className={`${thCls} text-right`}>Value</th>
                <th className={thCls}>Opportunity</th>
                <th className={thCls}>State</th>
                <th className={thCls}>Last signal</th>
                <th className={thCls}>Next action</th>
                <th className={thCls}>Event</th>
              </tr>
            </thead>
            <Group label="Act now" tone="text-critical" items={now} activeId={selected} onSelect={setSelected} showMoney={showMoney} />
            <Group label="Today" tone="text-attention" items={today} activeId={selected} onSelect={setSelected} showMoney={showMoney} />
            <Group label="Monitor" tone="text-muted-foreground" items={monitor} activeId={selected} onSelect={setSelected} showMoney={showMoney} />
          </table>
        )}
      </div>

      {selected && <LeadSidePanel id={selected} viewer={viewer} onClose={() => setSelected(null)} />}
    </>
  );
}

function Group({
  label,
  tone,
  items,
  activeId,
  onSelect,
  showMoney,
}: {
  label: string;
  tone: string;
  items: QueueItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  showMoney: boolean;
}): React.JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <tbody>
      <tr>
        <td colSpan={6} className="bg-background px-2.5 pt-4 pb-1.5">
          <span className={`text-[11px] font-medium uppercase tracking-[0.12em] ${tone}`}>{label}</span>
          <span className="ml-2 text-[11px] tabular-nums text-meta">{items.length}</span>
        </td>
      </tr>
      {items.map((it) => {
        const tier = it.nba.priority >= 80 ? "now" : it.nba.priority >= 45 ? "today" : ("passive" as Tier);
        const on = it.id === activeId;
        const when = relativeEvent(it.daysToEvent);
        const replied = repliedLabel(it.repliedMinutesAgo);
        const title = it.eventName || it.clientName || `Project ${it.id}`;
        return (
          <tr
            key={it.id}
            onClick={() => onSelect(it.id)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(it.id); } }}
            role="button"
            tabIndex={0}
            aria-current={on ? "true" : undefined}
            aria-label={`${title}, ${it.clientName || "unknown client"}, ${it.stateLabel}`}
            className={`cursor-pointer border-t border-[var(--row-rule)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${on ? "bg-lifted" : "hover:bg-[var(--row-hover)]"}`}
          >
            <td className={`px-2.5 py-2.5 text-right text-[15px] font-medium tabular-nums ${tierValueText(tier)} ${tierBar(tier)}`}>{showMoney ? money(it.value) : "—"}</td>
            <td className="px-2.5 py-2.5">
              <div className={`truncate text-[14px] font-medium ${tierValueText(tier)}`} title={title}>{title}</div>
              <div className="truncate text-[12px] text-meta">{it.clientName || "Unknown client"}</div>
            </td>
            <td className="px-2.5 py-2.5">
              <div className="text-[13px] text-tertiary-text">{it.stateLabel}</div>
              <Provenance kind={isInferred(it.state.source) ? "inferred" : "verified"} detail={isInferred(it.state.source) ? it.state.confidence.toFixed(2) : undefined} />
            </td>
            <td className="px-2.5 py-2.5">
              {replied && it.lastReplyPreview ? (
                <>
                  <div className="truncate text-[13px] text-tertiary-text" title={it.lastReplyPreview}>{it.lastReplyPreview}</div>
                  <div className="text-[12px] text-meta">replied {replied}</div>
                </>
              ) : (
                <span className="text-[13px] text-meta">—</span>
              )}
            </td>
            <td className="px-2.5 py-2.5">
              <ActionVerb primary={NBA_LABEL[it.nba.action]} tone={tierActionTone(tier)} />
            </td>
            <td className="px-2.5 py-2.5">
              <div className={`text-[13px] tabular-nums ${when.urgent ? "text-critical" : "text-tertiary-text"}`}>{it.eventDate ? when.text : "no date"}</div>
            </td>
          </tr>
        );
      })}
    </tbody>
  );
}

function ViewSwitcher({ active }: { active: ViewKey }): React.JSX.Element {
  const { query, stateFilter, incompleteOnly } = useSalesSearch();
  const items: { key: ViewKey; label: string; href: string; icon: typeof List }[] = [
    { key: "board", label: "Board", href: "/salesos/board", icon: Columns3 },
    { key: "worklist", label: "Worklist", href: "/salesos/worklist", icon: List },
    { key: "table", label: "Table", href: "/salesos/table", icon: Table2 },
  ];
  return (
    <div role="tablist" aria-label="Sales OS view" className="flex items-center gap-5">
      {items.map((it) => {
        const on = active === it.key;
        const Icon = it.icon;
        return (
          <Link
            key={it.key}
            href={withQuery(it.href, query, stateFilter, incompleteOnly)}
            role="tab"
            aria-selected={on}
            aria-current={on ? "page" : undefined}
            className={`flex items-center gap-1.5 text-[13.5px] transition-colors ${on ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            <Icon className="size-4" /> {it.label}
          </Link>
        );
      })}
    </div>
  );
}
