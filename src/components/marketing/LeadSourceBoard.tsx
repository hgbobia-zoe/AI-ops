// Inbound leads by channel, for the Marketing overview. Renders the pure LeadScoreboard (leadSources.ts);
// no logic here beyond formatting. Server-component safe (the sync button is its own client island).

import type { LeadScoreboard, LeadChannelStats } from "@/lib/marketing/leadSources";
import { formatYmdLong, ymdInTz, DISPLAY_TZ } from "@/lib/dates";
import { Surface } from "@/components/ui/surface";
import { LeadLogSyncButton } from "./LeadLogSyncButton";
import { cn } from "@/lib/utils";

export interface LeadLogStatus {
  lastRunAt: string | null;
  ok: boolean | null;
  detail: string | null;
  saved: number;
}

const MONTH = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
function monthLabel(ym: string): string {
  return MONTH.format(new Date(`${ym}-01T00:00:00Z`));
}

function day(ymdOrIso: string | null): string {
  if (!ymdOrIso) return "";
  const ymd = ymdOrIso.length > 10 ? ymdInTz(DISPLAY_TZ, new Date(ymdOrIso)) : ymdOrIso;
  return formatYmdLong(ymd);
}

function ago(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function deltaText(now: number, before: number | null): { text: string; tone: string } | null {
  if (before == null) return null;
  const d = now - before;
  if (d === 0) return { text: "same as the week before", tone: "text-meta" };
  return d > 0
    ? { text: `${d} more than the week before`, tone: "text-status-ready" }
    : { text: `${-d} fewer than the week before`, tone: "text-status-warning" };
}

function MonthBars({ monthly, max, months, label }: { monthly: number[]; max: number; months: string[]; label: string }): React.JSX.Element {
  return (
    <div className="flex h-5 items-end gap-[2px]" role="img" aria-label={`${label}, leads per month for the last ${monthly.length} months: ${monthly.join(", ")}`}>
      {monthly.map((n, i) => (
        <div
          key={months[i]}
          title={`${monthLabel(months[i])}: ${n}`}
          className={cn("w-[5px] rounded-[1px]", n > 0 ? "bg-status-ready" : "bg-[var(--bar)]")}
          style={{ height: n > 0 ? `${Math.max(15, Math.round((n / max) * 100))}%` : "2px" }}
        />
      ))}
    </div>
  );
}

const COLS = "grid-cols-[1fr_40px_48px] sm:grid-cols-[1fr_40px_44px_44px_52px_70px]";

function Row({ c, max, months }: { c: LeadChannelStats; max: number; months: string[] }): React.JSX.Element {
  return (
    <div className={cn("grid items-center gap-3 border-t border-[var(--row-rule)] px-3 py-2 text-[13px]", COLS)}>
      <div className="min-w-0">
        <div className="truncate text-foreground">{c.label}</div>
        <div className="truncate text-[11px] text-meta">
          {c.since ? `Tracked since ${day(c.since)} · last ${day(c.lastAt)}` : "No leads recorded yet"}
        </div>
      </div>
      <span className="text-right tabular-nums text-foreground">{c.last7}</span>
      <span className="hidden text-right tabular-nums text-tertiary-text sm:block">{c.prev7 ?? "–"}</span>
      <span className="hidden text-right tabular-nums text-tertiary-text sm:block">{c.last30}</span>
      <span className="text-right tabular-nums text-tertiary-text">{c.allTime}</span>
      <div className="hidden justify-end sm:flex">
        <MonthBars monthly={c.monthly} max={max} months={months} label={c.label} />
      </div>
    </div>
  );
}

export function LeadSourceBoard({ sb, status }: { sb: LeadScoreboard; status: LeadLogStatus }): React.JSX.Element {
  const max = Math.max(1, ...sb.channels.flatMap((c) => c.monthly));
  const delta = deltaText(sb.total.last7, sb.total.prev7);
  const notes: string[] = [];
  if (sb.repeatsAll > 0) notes.push(`${sb.repeatsAll} repeat ${sb.repeatsAll === 1 ? "submission" : "submissions"} counted once`);
  if (sb.testsAll > 0) notes.push(`${sb.testsAll} test ${sb.testsAll === 1 ? "lead" : "leads"} left out`);

  return (
    <Surface pad="none">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-3 py-2.5">
        <div className="text-[13px] text-foreground">
          <span className="text-[18px] font-semibold tabular-nums">{sb.total.last7}</span>{" "}
          {sb.total.last7 === 1 ? "lead" : "leads"} in the last 7 days
          {delta && <span className={cn("ml-2 text-[11.5px]", delta.tone)}>{delta.text}</span>}
        </div>
        <span className="text-[11.5px] tabular-nums text-meta">
          {sb.total.allTime} all time{sb.total.since ? ` since ${day(sb.total.since)}` : ""}
        </span>
      </div>
      <div className={cn("grid gap-3 border-t border-[var(--row-rule)] px-3 py-1.5 text-[11px] text-meta", COLS)}>
        <span>Channel</span>
        <span className="text-right">7 days</span>
        <span className="hidden text-right sm:block">Prior 7</span>
        <span className="hidden text-right sm:block">30 days</span>
        <span className="text-right">All time</span>
        <span className="hidden text-right sm:block">12 months</span>
      </div>
      {sb.channels.map((c) => <Row key={c.key} c={c} max={max} months={sb.months} />)}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--row-rule)] px-3 py-2 text-[11px] text-meta">
        <span>
          {status.lastRunAt
            ? status.ok
              ? `Synced from #new-leads ${ago(status.lastRunAt)} · ${status.saved} saved`
              : `Last sync failed ${ago(status.lastRunAt)}: ${status.detail ?? "unknown error"}`
            : "Not synced from #new-leads yet"}
          {notes.length > 0 && ` · ${notes.join(" · ")}`}
        </span>
        <LeadLogSyncButton />
      </div>
    </Surface>
  );
}
