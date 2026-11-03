// Inbound leads by channel, for the Marketing overview. Renders the pure LeadScoreboard (leadSources.ts);
// no logic here beyond formatting. Server-component safe.

import type { LeadScoreboard, LeadChannelStats } from "@/lib/marketing/leadSources";
import { formatYmdLong, ymdInTz, DISPLAY_TZ } from "@/lib/dates";
import { Surface } from "@/components/ui/surface";
import { cn } from "@/lib/utils";

function deltaText(now: number, before: number): { text: string; tone: string } {
  const d = now - before;
  if (d === 0) return { text: "same as the week before", tone: "text-meta" };
  return d > 0
    ? { text: `${d} more than the week before`, tone: "text-status-ready" }
    : { text: `${-d} fewer than the week before`, tone: "text-status-warning" };
}

function lastLead(iso: string | null): string {
  if (!iso) return "none yet";
  return formatYmdLong(ymdInTz(DISPLAY_TZ, new Date(iso)));
}

function WeekBars({ weekly, max, weekStarts, label }: { weekly: number[]; max: number; weekStarts: string[]; label: string }): React.JSX.Element {
  return (
    <div className="flex h-5 items-end gap-[2px]" role="img" aria-label={`${label}, leads per week for the last ${weekly.length} weeks: ${weekly.join(", ")}`}>
      {weekly.map((n, i) => (
        <div
          key={weekStarts[i]}
          title={`Week of ${formatYmdLong(weekStarts[i])}: ${n}`}
          className={cn("w-[6px] rounded-[1px]", n > 0 ? "bg-status-ready" : "bg-[var(--bar)]")}
          style={{ height: n > 0 ? `${Math.max(15, Math.round((n / max) * 100))}%` : "2px" }}
        />
      ))}
    </div>
  );
}

function Row({ c, max, weekStarts }: { c: LeadChannelStats; max: number; weekStarts: string[] }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[1fr_44px_44px] items-center gap-3 border-t border-[var(--row-rule)] px-3 py-2 text-[13px] sm:grid-cols-[1fr_44px_44px_44px_64px]">
      <div className="min-w-0">
        <div className="truncate text-foreground">{c.label}</div>
        <div className="truncate text-[11px] text-meta">Last lead {lastLead(c.lastAt)}</div>
      </div>
      <span className="text-right tabular-nums text-foreground">{c.last7}</span>
      <span className="hidden text-right tabular-nums text-tertiary-text sm:block">{c.prev7}</span>
      <span className="text-right tabular-nums text-tertiary-text">{c.last30}</span>
      <div className="hidden justify-end sm:flex">
        <WeekBars weekly={c.weekly} max={max} weekStarts={weekStarts} label={c.label} />
      </div>
    </div>
  );
}

export function LeadSourceBoard({ sb }: { sb: LeadScoreboard }): React.JSX.Element {
  const max = Math.max(1, ...sb.channels.flatMap((c) => c.weekly));
  const delta = deltaText(sb.total.last7, sb.total.prev7);
  const notes: string[] = [];
  if (sb.repeats30 > 0) notes.push(`${sb.repeats30} repeat ${sb.repeats30 === 1 ? "submission" : "submissions"} counted once`);
  if (sb.internal30 > 0) notes.push(`${sb.internal30} internal test ${sb.internal30 === 1 ? "lead" : "leads"} left out`);

  return (
    <Surface pad="none">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-3 py-2.5">
        <div className="text-[13px] text-foreground">
          <span className="text-[18px] font-semibold tabular-nums">{sb.total.last7}</span>{" "}
          {sb.total.last7 === 1 ? "lead" : "leads"} in the last 7 days
          <span className={cn("ml-2 text-[11.5px]", delta.tone)}>{delta.text}</span>
        </div>
        <span className="text-[11.5px] tabular-nums text-meta">{sb.total.last30} in 30 days</span>
      </div>
      <div className="grid grid-cols-[1fr_44px_44px] gap-3 border-t border-[var(--row-rule)] px-3 py-1.5 text-[11px] text-meta sm:grid-cols-[1fr_44px_44px_44px_64px]">
        <span>Channel</span>
        <span className="text-right">7 days</span>
        <span className="hidden text-right sm:block">Prior 7</span>
        <span className="text-right">30 days</span>
        <span className="hidden text-right sm:block">8 weeks</span>
      </div>
      {sb.channels.map((c) => <Row key={c.key} c={c} max={max} weekStarts={sb.weekStarts} />)}
      {notes.length > 0 && (
        <div className="border-t border-[var(--row-rule)] px-3 py-2 text-[11px] text-meta">Last 30 days: {notes.join(" · ")}.</div>
      )}
    </Surface>
  );
}
