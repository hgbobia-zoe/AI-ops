// Operational History (MVP4): the factual memory of the operation. An append-only feed of what changed and
// when: risks detected, escalated and resolved, drivers assigned, stops pulled, bookings moved or cancelled.
// Read only. It never decides anything, it only remembers. Times are in the operating timezone (Eastern).

import Link from "next/link";
import { History, Search } from "lucide-react";
import { queryChanges, type ChangeRow } from "@/lib/history/store";
import { describeChange, AREA_KINDS, AREA_LABEL, type HistoryArea } from "@/lib/history/describe";
import { opsDayLabel, opsTime } from "@/lib/history/format";
import { todayInOpsTz } from "@/lib/dates";
import { STATUS_DOT } from "@/lib/tone";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";
import { cn } from "@/lib/utils";
import { PageHeader, Toolbar } from "@/components/ui/page-header";
import { BladeMain, OverviewLayout } from "@/components/ui/layouts";
import { Surface } from "@/components/ui/surface";
import { EmptyState } from "@/components/ui/states";

export const dynamic = "force-dynamic";

const AREAS = Object.keys(AREA_KINDS) as HistoryArea[];
const PAGE_SIZE = 150;

function href(p: { area?: string | null; q?: string | null; before?: string | null }): string {
  const sp = new URLSearchParams();
  if (p.area) sp.set("area", p.area);
  if (p.q) sp.set("q", p.q);
  if (p.before) sp.set("before", p.before);
  const s = sp.toString();
  return s ? `/history?${s}` : "/history";
}

function Row({ c, showMoney }: { c: ChangeRow; showMoney: boolean }): React.JSX.Element {
  const d = describeChange(c, { showMoney });
  const inner = (
    <>
      <span className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", STATUS_DOT[d.tone])} aria-hidden />
      <span className="min-w-0 flex-1 text-[13px]">
        <span className="text-foreground">{d.title}</span>
        {d.subject && <span className="font-medium text-foreground">: {d.subject}</span>}
        {d.detail && <span className="text-secondary-text"> ({d.detail})</span>}
      </span>
      <time className="shrink-0 tabular-nums text-[11.5px] text-meta" dateTime={c.ts}>
        {opsTime(c.ts)}
      </time>
    </>
  );
  const cls = "flex items-start gap-3 px-3 py-2";
  return (
    <li className="border-b border-rule/60 last:border-0">
      {c.eventId ? (
        <Link href={`/history/${encodeURIComponent(c.eventId)}`} className={cn(cls, "hover:bg-row-hover")}>
          {inner}
        </Link>
      ) : (
        <div className={cls}>{inner}</div>
      )}
    </li>
  );
}

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ area?: string; q?: string; before?: string }>;
}): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const area = AREAS.includes(sp.area as HistoryArea) ? (sp.area as HistoryArea) : null;
  const q = (sp.q ?? "").trim().slice(0, 100) || null;
  const before = sp.before || null;
  const showMoney = canSeeFinancials(await viewerRole());

  const { rows, nextBefore } = queryChanges({ kinds: area ? AREA_KINDS[area] : undefined, q: q ?? undefined, before: before ?? undefined, limit: PAGE_SIZE });

  // Group by calendar day in the operating timezone (rows are already newest first).
  const today = todayInOpsTz();
  const groups: { label: string; items: ChangeRow[] }[] = [];
  for (const c of rows) {
    const label = opsDayLabel(c.ts, today);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(c);
    else groups.push({ label, items: [c] });
  }

  const chip = (active: boolean): string =>
    cn("border px-2.5 py-1 text-[12px]", active ? "border-foreground/40 bg-row-hover text-foreground" : "border-border text-secondary-text hover:bg-row-hover");

  const filtered = Boolean(area || q);

  const main = (
    <div className="space-y-4">
      <Toolbar>
        <nav className="flex flex-wrap gap-1.5" aria-label="Filter by area">
          <Link href={href({ q })} className={chip(!area)}>
            All
          </Link>
          {AREAS.map((a) => (
            <Link key={a} href={href({ area: a, q })} className={chip(area === a)}>
              {AREA_LABEL[a]}
            </Link>
          ))}
        </nav>
        <form action="/history" method="get" className="flex items-center gap-1.5">
          {area && <input type="hidden" name="area" value={area} />}
          <label className="relative">
            <span className="sr-only">Search history</span>
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-meta" aria-hidden />
            <input
              name="q"
              defaultValue={q ?? ""}
              placeholder="Event, client or route"
              className="h-8 w-56 border border-border bg-transparent pr-2 pl-7 text-[12.5px] text-foreground outline-none placeholder:text-meta focus-visible:border-ring"
            />
          </label>
          <button type="submit" className="h-8 border border-border px-2.5 text-[12px] text-foreground hover:bg-row-hover">
            Search
          </button>
        </form>
      </Toolbar>

      {rows.length === 0 ? (
        <EmptyState
          icon={<History className="size-5" />}
          title={filtered ? "Nothing matches" : "No changes recorded yet"}
          body={
            filtered
              ? "Try another area or search."
              : "As risks are detected, drivers assigned, stops pulled and bookings change, they appear here."
          }
          action={
            filtered ? (
              <Link href="/history" className="text-[12px] text-foreground underline">
                Clear filters
              </Link>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-5">
          {groups.map((g, i) => (
            <section key={`${g.label}-${i}`}>
              <h2 className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.07em] text-meta">{g.label}</h2>
              <Surface pad="none">
                <ul>
                  {g.items.map((c) => (
                    <Row key={c.id} c={c} showMoney={showMoney} />
                  ))}
                </ul>
              </Surface>
            </section>
          ))}
        </div>
      )}

      {(nextBefore || before) && (
        <div className="flex items-center gap-3 text-[12px]">
          {before && (
            <Link href={href({ area, q })} className="text-secondary-text hover:text-foreground">
              Back to newest
            </Link>
          )}
          {nextBefore && (
            <Link href={href({ area, q, before: nextBefore })} className="border border-border px-2.5 py-1 text-foreground hover:bg-row-hover">
              Show older
            </Link>
          )}
        </div>
      )}
    </div>
  );

  const context = (
    <Surface pad="md" className="space-y-2">
      <div className="text-[11px] uppercase tracking-[0.07em] text-meta">What gets recorded</div>
      <ul className="space-y-1.5 text-[12px] text-secondary-text">
        <li>
          <b className="text-foreground">Risks:</b> found, worse, resolved or back, from the risk scan, plus decisions made on Event Risk.
        </li>
        <li>
          <b className="text-foreground">Drivers:</b> assigned, changed or removed on Dispatch.
        </li>
        <li>
          <b className="text-foreground">Routes &amp; stops:</b> stops pulled, and how each event was delivered when its route closed.
        </li>
        <li>
          <b className="text-foreground">Bookings:</b> moved dates, value changes and cancellations seen in the Goodshuffle pull.
        </li>
      </ul>
      <p className="border-t border-rule pt-2 text-[11.5px] text-meta">
        Nothing here can be edited. Click a change to see that event&apos;s full timeline. Times are Eastern.
      </p>
    </Surface>
  );

  return (
    <BladeMain>
      <PageHeader title="Operational History" icon={<History className="size-6" />} subtitle="Everything that changed across dispatch, risk and bookings" />
      <OverviewLayout main={main} context={context} />
    </BladeMain>
  );
}
