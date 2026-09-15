"use client";

// Sales OS worklist (Nocturne redesign): an action-queue table grouped Act now / Today / Monitor,
// beside a 420px detail panel that previews the selected lead (state, next-best-action, evidence). Row
// click selects into the panel (local state — no navigation); "Open full lead" opens the full board in
// the modal. The analytical sub-views (Bid/Lost/Trends) and the Table/Board views render full-width.
// All data is the existing QueueItem[]; nothing is fetched here.

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { List, Table2, Columns3 } from "lucide-react";
import type { QueueItem } from "@/lib/salesos/commandCenter";
import { NBA_LABEL } from "@/lib/salesos/nba";
import { LeadSidePanel } from "@/components/LeadSidePanel";
import { FigureStrip, ActionVerb, tierBar, tierActionTone, tierValueText, tableCls, theadCls, thCls, type Tier, type Figure } from "@/components/console-primitives";

const money = (n: number | null): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));

// Tier from the transparent NBA priority (≥80 act now, ≥45 today, else monitor).
function tierOf(it: QueueItem): Tier {
  const p = it.nba.priority;
  if (p >= 80) return "now";
  if (p >= 45) return "today";
  return "passive";
}
function eventWhen(dte: number | null): { text: string; hot: boolean } {
  if (dte == null) return { text: "no date", hot: false };
  if (dte < 0) return { text: `${Math.abs(dte)}d ago`, hot: false };
  if (dte === 0) return { text: "today", hot: true };
  if (dte === 1) return { text: "tomorrow", hot: true };
  return { text: `in ${dte}d`, hot: dte <= 14 };
}
function repliedLabel(mins: number | null): string | null {
  if (mins == null) return null;
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}
const isInferred = (src: string): boolean => src === "inbound_reply" || src === "derived" || src === "inferred";

type ViewKey = "worklist" | "table" | "board";

export function SalesShell({
  queue,
  showMoney,
  justReplied,
  totalPotential,
  viewer,
  children,
}: {
  queue: QueueItem[];
  showMoney: boolean;
  needAttention: number;
  justReplied: number;
  totalPotential: number | null;
  viewer: { name: string; quoUserId: string | null; initials: string };
  children: React.ReactNode;
}): React.JSX.Element {
  const pathname = usePathname();
  const [selected, setSelected] = useState<string | null>(null);

  const seg = pathname.split("/")[2] ?? "";
  if (seg === "bid" || seg === "lost" || seg === "trends") return <>{children}</>;

  const view: ViewKey = seg === "table" ? "table" : seg === "board" ? "board" : "worklist";
  // Table + Board are full-width views; a lead-id path (deep link / "Open full lead") renders the full
  // lead board as children. Both sit under the shared view switcher.
  if (view !== "worklist" || seg) {
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <ViewSwitcher active={view} />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    );
  }

  const now = queue.filter((q) => tierOf(q) === "now");
  const today = queue.filter((q) => tierOf(q) === "today");
  const monitor = queue.filter((q) => tierOf(q) === "passive");

  const figures: Figure[] = [
    { label: "Act now", value: now.length, tone: now.length ? "critical" : "default" },
    { label: "Today", value: today.length, tone: today.length ? "attention" : "default" },
    { label: "Replied 24h", value: justReplied },
    ...(showMoney
      ? ([{ label: "Open", value: queue.length, sep: true }, { label: "Pipeline", value: money(totalPotential) }] as Figure[])
      : ([{ label: "Open", value: queue.length, sep: true }] as Figure[])),
  ];

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <ViewSwitcher active="worklist" />
      <div className="flex flex-wrap items-end justify-between gap-4 px-6 pt-4 pb-3">
        <h1 className="text-[22px] font-medium tracking-tight">Sales OS</h1>
        <FigureStrip figures={figures} />
      </div>

      {/* Action queue — full width. Clicking a row opens the full lead in an overlay side panel. */}
      <div className="min-w-0 flex-1 overflow-auto border-t border-border">
        {queue.length === 0 ? (
          <p className="px-6 py-16 text-center text-[13.5px] text-muted-foreground">No active opportunities.</p>
        ) : (
          <table className={tableCls}>
            <colgroup>
              <col style={{ width: "88px" }} />
              <col />
              <col style={{ width: "150px" }} />
              <col style={{ width: "180px" }} />
              <col style={{ width: "150px" }} />
              <col style={{ width: "96px" }} />
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
    </div>
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
        const when = eventWhen(it.daysToEvent);
        const replied = repliedLabel(it.repliedMinutesAgo);
        return (
          <tr
            key={it.id}
            onClick={() => onSelect(it.id)}
            aria-current={on ? "true" : undefined}
            className={`cursor-pointer border-t border-[var(--row-rule)] transition-colors ${on ? "bg-lifted" : "hover:bg-[var(--row-hover)]"}`}
          >
            <td className={`px-2.5 py-2.5 text-right text-[15px] font-medium tabular-nums ${tierValueText(tier)} ${tierBar(tier)}`}>{showMoney ? money(it.value) : "—"}</td>
            <td className="px-2.5 py-2.5">
              <div className={`truncate text-[14px] font-medium ${tierValueText(tier)}`} title={it.eventName || it.clientName}>{it.eventName || it.clientName || `Project ${it.id}`}</div>
              <div className="truncate text-[12px] text-meta">{it.clientName || "Unknown client"}</div>
            </td>
            <td className="px-2.5 py-2.5">
              <div className="text-[13px] text-tertiary-text">{it.stateLabel}</div>
              <div className="text-[12px] text-meta">{isInferred(it.state.source) ? `Inferred · ${it.state.confidence.toFixed(2)}` : "Verified"}</div>
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
              <div className={`text-[13px] tabular-nums ${when.hot ? "text-critical" : "text-tertiary-text"}`}>{when.text}</div>
            </td>
          </tr>
        );
      })}
    </tbody>
  );
}

function ViewSwitcher({ active }: { active: ViewKey }): React.JSX.Element {
  const items: { key: ViewKey; label: string; href: string; icon: typeof List }[] = [
    { key: "worklist", label: "Worklist", href: "/salesos", icon: List },
    { key: "table", label: "Table", href: "/salesos/table", icon: Table2 },
    { key: "board", label: "Board", href: "/salesos/board", icon: Columns3 },
  ];
  return (
    <div className="flex items-center gap-5 px-6 pt-4">
      {items.map((it) => {
        const on = active === it.key;
        const Icon = it.icon;
        return (
          <Link key={it.key} href={it.href} aria-current={on ? "page" : undefined} className={`flex items-center gap-1.5 text-[13.5px] transition-colors ${on ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            <Icon className="size-4" /> {it.label}
          </Link>
        );
      })}
    </div>
  );
}
