"use client";

// Sales OS worklist (Nocturne redesign): an action-queue table grouped Act now / Today / Monitor,
// beside a 420px detail panel that previews the selected lead (state, next-best-action, evidence). Row
// click selects into the panel (local state — no navigation); "Open full lead" opens the full board in
// the modal. The analytical sub-views (Bid/Lost/Trends) and the Table/Board views render full-width.
// All data is the existing QueueItem[]; nothing is fetched here.

import { useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { List, Table2, Columns3, ExternalLink } from "lucide-react";
import type { QueueItem } from "@/lib/salesos/commandCenter";
import { NBA_LABEL } from "@/lib/salesos/nba";
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
  children,
}: {
  queue: QueueItem[];
  showMoney: boolean;
  needAttention: number;
  justReplied: number;
  totalPotential: number | null;
  children: React.ReactNode;
}): React.JSX.Element {
  const pathname = usePathname();
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(null);

  const seg = pathname.split("/")[2] ?? "";
  if (seg === "bid" || seg === "lost" || seg === "trends") return <>{children}</>;

  const view: ViewKey = seg === "table" ? "table" : seg === "board" ? "board" : "worklist";
  if (view !== "worklist") {
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
  const urlId = seg || null; // a hard-load of /salesos/[id] pre-selects that lead in the panel
  const activeId = selected ?? urlId ?? queue[0]?.id ?? null;
  const active = queue.find((q) => q.id === activeId) ?? null;

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

      <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_420px]">
        {/* Action queue */}
        <div className="min-w-0 overflow-auto border-t border-border">
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
              <Group label="Act now" tone="text-critical" items={now} activeId={activeId} onSelect={setSelected} showMoney={showMoney} />
              <Group label="Today" tone="text-attention" items={today} activeId={activeId} onSelect={setSelected} showMoney={showMoney} />
              <Group label="Monitor" tone="text-muted-foreground" items={monitor} activeId={activeId} onSelect={setSelected} showMoney={showMoney} />
            </table>
          )}
        </div>

        {/* Detail panel */}
        <aside className="hidden min-w-0 flex-col border-l border-t border-border bg-panel xl:flex">
          {active ? <DetailPanel it={active} showMoney={showMoney} onOpenFull={() => router.push(`/salesos/${active.id}`)} /> : <p className="p-6 text-[13.5px] text-muted-foreground">Select an opportunity.</p>}
        </aside>
      </div>
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

function DetailPanel({ it, showMoney, onOpenFull }: { it: QueueItem; showMoney: boolean; onOpenFull: () => void }): React.JSX.Element {
  const when = eventWhen(it.daysToEvent);
  const inferred = isInferred(it.state.source);
  const tier: Tier = it.nba.priority >= 80 ? "now" : it.nba.priority >= 45 ? "today" : "passive";
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* Sticky header */}
      <div className="sticky top-0 z-10 border-b border-border bg-panel p-5">
        <div className="text-[22px] font-medium tracking-tight">{it.eventName || it.clientName || `Project ${it.id}`}</div>
        <div className="mt-0.5 flex items-baseline gap-3">
          {showMoney && <span className="text-[20px] font-medium tabular-nums">{money(it.value)}</span>}
          <span className="text-[14px] text-tertiary-text">{it.clientName || "Unknown client"}</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <button onClick={onOpenFull} className="flex items-center gap-1.5 rounded border border-foreground/80 px-3 py-1.5 text-[12.5px] text-foreground transition-colors hover:bg-[var(--row-hover)]">Open full lead</button>
          <a href={`https://pro.goodshuffle.com/app/project/detail?id=${it.id}`} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 rounded border border-[var(--bar)] px-3 py-1.5 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)]">
            <ExternalLink className="size-3.5" /> Goodshuffle
          </a>
        </div>
      </div>

      <div className="space-y-5 p-5">
        {/* NEXT / WHY / OBJECTIVE / DO NOT */}
        <div className="space-y-3">
          <Field label="Next">
            <span className={`text-[16px] font-semibold ${tierActionTone(tier)}`}>{NBA_LABEL[it.nba.action]}</span>
          </Field>
          {it.nba.reason && <Field label="Why"><span className="text-[13.5px] text-tertiary-text">{it.nba.reason}</span></Field>}
          <Field label="Objective"><span className="text-[13.5px]">{it.nba.objective}</span></Field>
          {it.nba.doNot && <Field label="Do not"><span className="text-[13.5px] text-attention">{it.nba.doNot}</span></Field>}
        </div>

        {/* Facts */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-[var(--row-rule)] pt-4">
          <Fact label="State" value={it.stateLabel} meta={inferred ? `Inferred · ${it.state.confidence.toFixed(2)}` : "Verified"} />
          <Fact label="Event date" value={it.eventDate ?? "Not set"} meta={when.text} metaHot={when.hot} />
          {showMoney && <Fact label="Value" value={money(it.value)} />}
          <Fact label="Last reply" value={repliedLabel(it.repliedMinutesAgo) ? `${repliedLabel(it.repliedMinutesAgo)}` : "—"} />
        </div>

        {/* Evidence */}
        {inferred && it.state.evidence && (
          <div className="border-t border-[var(--row-rule)] pt-4">
            <div className="mb-1.5 text-[10.5px] uppercase tracking-[0.1em] text-meta">Evidence</div>
            <p className="border-l-2 border-[var(--bar-2)] pl-3 text-[13.5px] italic text-secondary-text">“{it.state.evidence}”</p>
          </div>
        )}

        <p className="border-t border-[var(--row-rule)] pt-4 text-[12px] text-meta">
          State is FACT from Goodshuffle where known, otherwise inferred from the customer&apos;s own reply. Review before acting — nothing sends on its own.
        </p>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[104px_1fr] gap-3">
      <div className="pt-0.5 text-[10.5px] uppercase tracking-[0.1em] text-meta">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
function Fact({ label, value, meta, metaHot }: { label: string; value: string; meta?: string; metaHot?: boolean }): React.JSX.Element {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-[0.1em] text-meta">{label}</div>
      <div className="mt-0.5 text-[15px] tabular-nums">{value}</div>
      {meta && <div className={`text-[12px] ${metaHot ? "text-critical" : "text-meta"}`}>{meta}</div>}
    </div>
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
