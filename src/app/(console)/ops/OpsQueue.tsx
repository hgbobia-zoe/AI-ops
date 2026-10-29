"use client";

// The prioritized task queue for the Operations Manager blade. It is interactive (filters +
// expandable evidence) but holds NO data of its own — it receives the already-ranked feed from the
// server and only filters/groups/renders it. Priority/date/owner filters are pure functions shared
// with the server (manager.ts), so the ranking and the counts stay honest and testable.

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ChevronRight,
  ArrowRight,
  Clock,
  UserRound,
  ShieldAlert,
  TrendingUp,
  DollarSign,
  CalendarDays,
} from "lucide-react";
import {
  filterAttention,
  groupAttention,
  ownersOf,
  summarize,
  UNASSIGNED,
  type AttentionItem,
  type AttentionGroup,
  type Priority,
  type DateBucket,
  type ItemStatus,
  type Source,
} from "@/lib/ops/manager";
import { type Tone, STATUS_DOT } from "@/lib/tone";
import { StatusBadge } from "@/components/ui/status";
import { EmptyState } from "@/components/ui/states";
import { Surface } from "@/components/ui/surface";
import { formatYmdLong } from "@/lib/dates";
import { cn } from "@/lib/utils";

// ── Static vocab ─────────────────────────────────────────────────────────────────────────────────

const PRIORITY_ORDER: Priority[] = ["critical", "high", "medium", "info"];
const PRIORITY_LABEL: Record<Priority, string> = { critical: "Critical", high: "High", medium: "Review", info: "Info" };
// Priority → status tone (colour on the indicator only; the label stays crisp/white).
const PRIORITY_TONE: Record<Priority, Tone> = { critical: "critical", high: "attention", medium: "attention", info: "neutral" };
// A second visual channel so High vs Review (both amber) are still distinguishable: the row's left edge.
const PRIORITY_EDGE: Record<Priority, string> = {
  critical: "border-l-critical",
  high: "border-l-attention",
  medium: "border-l-attention/50",
  info: "border-l-transparent",
};

const SOURCE_ICON: Record<Source, typeof ShieldAlert> = {
  risk: ShieldAlert,
  sales: TrendingUp,
  finance: DollarSign,
  customer: UserRound,
};
const SOURCE_LABEL: Record<Source, string> = { risk: "Risk", sales: "Sales", finance: "Finance", customer: "Customer" };

const STATUS_WORD: Record<ItemStatus, string> = { open: "Open", acknowledged: "Acknowledged", in_progress: "In progress" };

const DATE_BUCKETS: { key: DateBucket; label: string }[] = [
  { key: "all", label: "Any date" },
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Today" },
  { key: "soon", label: "≤3 days" },
  { key: "week", label: "This week" },
  { key: "later", label: "Later" },
  { key: "undated", label: "Undated" },
];

function duePhrase(daysUntil: number | null | undefined): string {
  if (daysUntil == null) return "No date";
  if (daysUntil < 0) return `${-daysUntil}d overdue`;
  if (daysUntil === 0) return "Due today";
  if (daysUntil === 1) return "Due tomorrow";
  return `Due in ${daysUntil}d`;
}

function relativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const diffMs = Date.now() - t;
  if (diffMs < 0) return "just now";
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

// ── One row ──────────────────────────────────────────────────────────────────────────────────────

function ItemRow({
  item,
  expanded,
  onToggle,
}: {
  item: AttentionItem;
  expanded: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const Icon = SOURCE_ICON[item.source];
  const panelId = `ops-ev-${item.key.replace(/[^a-zA-Z0-9]/g, "-")}`;
  // Relative time depends on the clock, so it differs between the SSR pass and hydration — that one
  // text node is allowed to differ (suppressHydrationWarning) rather than gating render on a mount effect.
  const evaluated = relativeTime(item.evaluatedAt);

  return (
    <div className={cn("border-l-2 bg-panel", PRIORITY_EDGE[item.priority])}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={panelId}
        className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight
          className={cn("mt-0.5 size-4 shrink-0 text-meta transition-transform", expanded && "rotate-90")}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusBadge tone={PRIORITY_TONE[item.priority]} size="sm">
              {PRIORITY_LABEL[item.priority]}
            </StatusBadge>
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-foreground">{item.title}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-meta">
            <span className="inline-flex items-center gap-1">
              <Icon className="size-3 shrink-0" aria-hidden /> {SOURCE_LABEL[item.source]}
            </span>
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3 shrink-0" aria-hidden /> {duePhrase(item.daysUntil)}
            </span>
            <span>Status: {STATUS_WORD[item.status]}</span>
            <span className="inline-flex items-center gap-1">
              <UserRound className="size-3 shrink-0" aria-hidden /> {item.owner ?? "Unassigned"}
            </span>
          </div>
        </div>
      </button>

      {expanded && (
        <div id={panelId} className="space-y-2.5 border-t border-rule px-3 pb-3 pt-2.5 pl-10 text-[12.5px]">
          <div>
            <div className="text-[10.5px] uppercase tracking-[0.07em] text-meta">Problem</div>
            <p className="mt-0.5 text-secondary-text">{item.problem}</p>
          </div>
          <div>
            <div className="text-[10.5px] uppercase tracking-[0.07em] text-meta">Impact</div>
            <p className="mt-0.5 text-secondary-text">{item.impact}</p>
          </div>
          <div>
            <div className="text-[10.5px] uppercase tracking-[0.07em] text-meta">Why it is prioritized</div>
            <ul className="mt-0.5 flex flex-wrap gap-x-2 gap-y-1 text-secondary-text">
              {item.reasons.map((r, i) => (
                <li key={i} className="after:ml-2 after:text-meta after:content-['·'] last:after:content-['']">
                  {r}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="text-[10.5px] uppercase tracking-[0.07em] text-meta">Next action</div>
            <p className="mt-0.5 text-secondary-text">{item.nextAction}</p>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-0.5">
            <a
              href={item.focusHref}
              className="inline-flex items-center gap-1 text-[12.5px] font-medium text-foreground underline-offset-2 hover:underline"
            >
              {item.focusLabel} <ArrowRight className="size-3.5" aria-hidden />
            </a>
            {item.source === "risk" && item.focusHref !== "/risk" && (
              <a href="/risk" className="text-[11.5px] text-meta underline-offset-2 hover:text-foreground hover:underline">
                Acknowledge or resolve on the risk board
              </a>
            )}
            {evaluated && (
              <span suppressHydrationWarning className="ml-auto text-[11px] text-meta">
                Evaluated {evaluated}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Group (a same-day cluster, or a single standalone item) ───────────────────────────────────────

function GroupBlock({
  group,
  expandedKeys,
  toggle,
}: {
  group: AttentionGroup;
  expandedKeys: Set<string>;
  toggle: (k: string) => void;
}): React.JSX.Element {
  if (group.kind === "single") {
    const item = group.items[0];
    return <ItemRow item={item} expanded={expandedKeys.has(item.key)} onToggle={() => toggle(item.key)} />;
  }
  return (
    <section className="surface overflow-hidden border border-border" aria-label={`Signals for ${group.date}`}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-rule bg-row px-3 py-2">
        <CalendarDays className="size-4 shrink-0 text-meta" aria-hidden />
        <span className="text-[13px] font-medium text-foreground">{group.date ? formatYmdLong(group.date) : "Grouped"}</span>
        <span className="text-[11.5px] text-meta">{group.items.length} related signals</span>
        <span className="ml-auto">
          <StatusBadge tone={PRIORITY_TONE[group.topPriority]} size="sm">
            {PRIORITY_LABEL[group.topPriority]}
          </StatusBadge>
        </span>
      </header>
      <div className="divide-y divide-rule/60">
        {group.items.map((item) => (
          <ItemRow key={item.key} item={item} expanded={expandedKeys.has(item.key)} onToggle={() => toggle(item.key)} />
        ))}
      </div>
    </section>
  );
}

// ── The queue ──────────────────────────────────────────────────────────────────────────────────────

export function OpsQueue({
  items,
  initialPriority,
  initialDate,
  initialOwner,
}: {
  items: AttentionItem[];
  initialPriority: Priority | null;
  initialDate: DateBucket | null;
  initialOwner: string | null;
}): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [priority, setPriority] = React.useState<Priority | null>(initialPriority);
  const [dateBucket, setDateBucket] = React.useState<DateBucket>(initialDate ?? "all");
  const [owner, setOwner] = React.useState<string>(initialOwner ?? "all");
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  // Keep the URL in sync so filters are shareable and the documented ?p= deep link is preserved.
  React.useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (priority) params.set("p", priority);
    else params.delete("p");
    if (dateBucket !== "all") params.set("d", dateBucket);
    else params.delete("d");
    if (owner !== "all") params.set("o", owner);
    else params.delete("o");
    const qs = params.toString();
    router.replace(qs ? `/ops?${qs}` : "/ops", { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priority, dateBucket, owner]);

  const { owners, hasUnassigned } = React.useMemo(() => ownersOf(items), [items]);

  // Tile counts reflect the current date+owner scope (NOT the priority filter itself), so clicking a
  // priority tile narrows within what's already in view. The "showing N of M" line explains the rest.
  const scopedForTiles = React.useMemo(
    () => filterAttention(items, { dateBucket, owner }),
    [items, dateBucket, owner]
  );
  const tileCounts = React.useMemo(() => summarize(scopedForTiles), [scopedForTiles]);

  const shown = React.useMemo(
    () => filterAttention(items, { priority, dateBucket, owner }),
    [items, priority, dateBucket, owner]
  );
  const groups = React.useMemo(() => groupAttention(shown), [shown]);

  const anyFilter = priority != null || dateBucket !== "all" || owner !== "all";

  function toggle(k: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }
  function clearFilters(): void {
    setPriority(null);
    setDateBucket("all");
    setOwner("all");
  }

  if (items.length === 0) {
    return (
      <EmptyState
        title="All clear"
        body="No active risks, near-term booking gaps, capacity constraints, or labor overruns right now."
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Priority tiles — also the priority filter. Counts match the current date/owner scope. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label="Filter by priority">
        {PRIORITY_ORDER.map((p) => {
          const on = priority === p;
          return (
            <button
              key={p}
              type="button"
              aria-pressed={on}
              onClick={() => setPriority(on ? null : p)}
              className={cn(
                "surface border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                on ? "border-foreground/50 bg-row" : "border-border hover:bg-row-hover"
              )}
            >
              <div className="flex items-center gap-1.5 text-[11px] tracking-[0.04em] text-meta">
                <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[PRIORITY_TONE[p]])} aria-hidden />
                {PRIORITY_LABEL[p]}
              </div>
              <div className="mt-1.5 text-[20px] font-semibold tabular-nums text-foreground">{tileCounts[p]}</div>
            </button>
          );
        })}
      </div>

      {/* Date + owner filters */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by due date">
          {DATE_BUCKETS.map((b) => {
            const on = dateBucket === b.key;
            return (
              <button
                key={b.key}
                type="button"
                aria-pressed={on}
                onClick={() => setDateBucket(b.key)}
                className={cn(
                  "rounded border px-2 py-1 text-[11.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  on ? "border-foreground/50 bg-row text-foreground" : "border-border text-secondary-text hover:bg-row-hover hover:text-foreground"
                )}
              >
                {b.label}
              </button>
            );
          })}
        </div>

        {(owners.length > 0 || hasUnassigned) && (
          <label className="flex items-center gap-1.5 text-[11.5px] text-meta">
            Owner
            <select
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              aria-label="Filter by owner"
              className="rounded border border-input bg-panel px-2 py-1 text-[12px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="all">All owners</option>
              {owners.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
              {hasUnassigned && <option value={UNASSIGNED}>Unassigned</option>}
            </select>
          </label>
        )}

        {anyFilter && (
          <button
            type="button"
            onClick={clearFilters}
            className="text-[11.5px] text-meta underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Scope line — filtered vs full-system totals, kept explicit so a count is never ambiguous. */}
      <p className="text-[12px] text-meta" aria-live="polite">
        {anyFilter ? (
          <>
            Showing <span className="font-medium text-secondary-text">{shown.length}</span> of {items.length} items
            (full system). Counts above reflect the current date and owner filter.
          </>
        ) : (
          <>
            Showing all <span className="font-medium text-secondary-text">{items.length}</span> items across every system.
          </>
        )}
      </p>

      {/* Grouped, expandable rows */}
      {shown.length === 0 ? (
        <Surface pad="lg" className="text-center">
          <p className="text-[13px] text-secondary-text">No items match the current filters.</p>
          <button
            type="button"
            onClick={clearFilters}
            className="mt-2 text-[12px] text-foreground underline underline-offset-2"
          >
            Clear filters
          </button>
        </Surface>
      ) : (
        <div className="space-y-2">
          {groups.map((g) => (
            <GroupBlock key={g.key} group={g} expandedKeys={expanded} toggle={toggle} />
          ))}
        </div>
      )}
    </div>
  );
}
