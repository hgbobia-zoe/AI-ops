// Operational History (MVP4): the factual memory of the operation. One append-only feed of what changed,
// what people did and what the platform did on its own: risks, drivers, stops, bookings, Goodshuffle
// write-backs, AI approval decisions and crew/route actions. Every row says who did it.
// Read only. Times are in the operating timezone (Eastern).

import Link from "next/link";
import { History, Search } from "lucide-react";
import { historyFeed, byLabel, FEED_AREAS, FEED_AREA_LABEL, type FeedArea, type FeedItem, type Who } from "@/lib/history/feed";
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

const PAGE_SIZE = 150;
const WHO: { value: Who | null; label: string }[] = [
  { value: null, label: "Everyone" },
  { value: "person", label: "People" },
  { value: "platform", label: "Platform" },
];

type Params = { area?: string | null; who?: string | null; q?: string | null; before?: string | null };

function href(p: Params): string {
  const sp = new URLSearchParams();
  if (p.area) sp.set("area", p.area);
  if (p.who) sp.set("who", p.who);
  if (p.q) sp.set("q", p.q);
  if (p.before) sp.set("before", p.before);
  const s = sp.toString();
  return s ? `/history?${s}` : "/history";
}

function Row({ d }: { d: FeedItem }): React.JSX.Element {
  const inner = (
    <>
      <span className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", STATUS_DOT[d.tone])} aria-hidden />
      <span className="min-w-0 flex-1 text-[13px]">
        <span className="text-foreground">{d.title}</span>
        {d.subject && <span className="font-medium text-foreground">: {d.subject}</span>}
        {d.detail && <span className="text-secondary-text"> ({d.detail})</span>}
        <span className={cn("ml-1.5 text-[11.5px]", d.by.who === "person" ? "text-secondary-text" : "text-meta")}>{byLabel(d.by)}</span>
      </span>
      <time className="shrink-0 tabular-nums text-[11.5px] text-meta" dateTime={d.ts}>
        {opsTime(d.ts)}
      </time>
    </>
  );
  const cls = "flex items-start gap-3 px-3 py-2";
  return (
    <li className="border-b border-rule/60 last:border-0">
      {d.eventId ? (
        <Link href={`/history/${encodeURIComponent(d.eventId)}`} className={cn(cls, "hover:bg-row-hover")}>
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
  searchParams: Promise<{ area?: string; who?: string; q?: string; before?: string }>;
}): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const area = FEED_AREAS.includes(sp.area as FeedArea) ? (sp.area as FeedArea) : null;
  const who = sp.who === "person" || sp.who === "platform" ? (sp.who as Who) : null;
  const q = (sp.q ?? "").trim().slice(0, 100) || null;
  const before = sp.before || null;
  const showMoney = canSeeFinancials(await viewerRole());

  const { items, nextBefore } = historyFeed({ area, who, q, before, limit: PAGE_SIZE, showMoney });

  // Group by calendar day in the operating timezone (items are already newest first).
  const today = todayInOpsTz();
  const groups: { label: string; items: FeedItem[] }[] = [];
  for (const it of items) {
    const label = opsDayLabel(it.ts, today);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(it);
    else groups.push({ label, items: [it] });
  }

  const chip = (active: boolean): string =>
    cn("border px-2.5 py-1 text-[12px]", active ? "border-foreground/40 bg-row-hover text-foreground" : "border-border text-secondary-text hover:bg-row-hover");

  const filtered = Boolean(area || who || q);

  const main = (
    <div className="space-y-4">
      <Toolbar>
        <nav className="flex flex-wrap gap-1.5" aria-label="Filter by area">
          <Link href={href({ who, q })} className={chip(!area)}>
            All
          </Link>
          {FEED_AREAS.map((a) => (
            <Link key={a} href={href({ area: a, who, q })} className={chip(area === a)}>
              {FEED_AREA_LABEL[a]}
            </Link>
          ))}
        </nav>
      </Toolbar>
      <Toolbar>
        <nav className="flex flex-wrap gap-1.5" aria-label="Filter by who did it">
          {WHO.map((w) => (
            <Link key={w.label} href={href({ area, who: w.value, q })} className={chip(who === w.value)}>
              {w.label}
            </Link>
          ))}
        </nav>
        <form action="/history" method="get" className="flex items-center gap-1.5">
          {area && <input type="hidden" name="area" value={area} />}
          {who && <input type="hidden" name="who" value={who} />}
          <label className="relative">
            <span className="sr-only">Search history</span>
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-meta" aria-hidden />
            <input
              name="q"
              defaultValue={q ?? ""}
              placeholder="Event, client, route or person"
              className="h-8 w-56 border border-border bg-transparent pr-2 pl-7 text-[12.5px] text-foreground outline-none placeholder:text-meta focus-visible:border-ring"
            />
          </label>
          <button type="submit" className="h-8 border border-border px-2.5 text-[12px] text-foreground hover:bg-row-hover">
            Search
          </button>
        </form>
      </Toolbar>

      {items.length === 0 ? (
        <EmptyState
          icon={<History className="size-5" />}
          title={filtered ? "Nothing matches" : "Nothing recorded yet"}
          body={filtered ? "Try another filter or search." : "As risks are detected, drivers assigned, bookings change and the platform acts, they appear here."}
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
                  {g.items.map((d) => (
                    <Row key={d.id} d={d} />
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
            <Link href={href({ area, who, q })} className="text-secondary-text hover:text-foreground">
              Back to newest
            </Link>
          )}
          {nextBefore && (
            <Link href={href({ area, who, q, before: nextBefore })} className="border border-border px-2.5 py-1 text-foreground hover:bg-row-hover">
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
          <b className="text-foreground">Crew &amp; drivers:</b> drivers assigned on Dispatch, shifts published to Connecteam, and asset prep taken off truck routes.
        </li>
        <li>
          <b className="text-foreground">Routes &amp; stops:</b> stops pulled, driver closeouts and reported problems, routes closed for a handoff, and how each event was delivered.
        </li>
        <li>
          <b className="text-foreground">Bookings:</b> moved dates, value changes and cancellations seen in the Goodshuffle pull.
        </li>
        <li>
          <b className="text-foreground">Goodshuffle write-backs:</b> changes the app made in Goodshuffle that landed or failed. Note copies of texts and calls stay in the Sales timeline.
        </li>
        <li>
          <b className="text-foreground">AI approvals:</b> who approved or rejected each AI draft, and AI employees paused or resumed.
        </li>
      </ul>
      <p className="border-t border-rule pt-2 text-[11.5px] text-meta">
        Each row says who did it: a person by name, &ldquo;someone&rdquo; when the record kept no name, or the platform. Nothing here can be
        edited. Times are Eastern.
      </p>
    </Surface>
  );

  return (
    <BladeMain>
      <PageHeader title="Operational History" icon={<History className="size-6" />} subtitle="What changed, what people did, and what the platform did on its own" />
      <OverviewLayout main={main} context={context} />
    </BladeMain>
  );
}
