// Sales autopsy (Phase 12) — the post-mortem for one lost deal. Deterministic facts + process
// breakpoints, plus an AI narrative (why it slipped + the elite-rep move) labelled as inference.
// Never fabricates a cause; where the data is silent it says so.

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, TrendingDown, AlertTriangle, Lightbulb, Phone, Info } from "lucide-react";
import { getAutopsy } from "@/lib/salesos/autopsyService";
import { formatYmdLong } from "@/lib/dates";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

const money = (n: number | null): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));

export default async function AutopsyPage({ params }: { params: Promise<{ id: string }> }): Promise<React.JSX.Element> {
  const { id } = await params;
  const showMoney = canSeeFinancials(await viewerRole());
  const a = await getAutopsy(id);
  if (!a) notFound();
  const { autopsy: d } = a;

  return (
    <main className="mx-auto max-w-2xl p-5 pb-16 md:p-8">
      <Link href="/salesos/lost" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Lost quotes
      </Link>

      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <TrendingDown className="size-6" /> {a.eventName || a.clientName || `Project ${a.id}`}
        </h1>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{a.clientName || "Unknown client"}</span>
          {a.eventDate && <span>{formatYmdLong(a.eventDate)}</span>}
          {showMoney && <span className="text-amber-200">{money(a.value)} lost</span>}
          {a.statusLabel && <span>Goodshuffle: {a.statusLabel}</span>}
        </div>
      </header>

      {/* What we know — FACTs */}
      <section className="surface mb-4 border border-white/10 p-4">
        <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">What we know (fact)</div>
        <dl className="space-y-1.5 text-sm">
          <Row label="Recorded loss reason" value={d.recordedReason ?? "Not tagged"} />
          <Row label="Quote lead time" value={d.quoteLeadDays == null ? "Unknown" : `${d.quoteLeadDays} days before the event`} />
          <Row label="Contact attempts logged" value={String(d.comms.attempts)} />
          <Row label="Channels tried" value={d.comms.channels.length ? d.comms.channels.join(", ") : "—"} />
          <Row label="Last contact" value={d.comms.lastContact ?? "—"} />
        </dl>
      </section>

      {/* Where the process broke — deterministic */}
      <section className="surface mb-4 border border-white/10 p-4">
        <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">Where the process likely broke</div>
        <ul className="space-y-2">
          {d.breakpoints.map((b, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-300" />
              <span><span className="font-medium">{b.area}.</span> <span className="text-muted-foreground">{b.detail}</span></span>
            </li>
          ))}
        </ul>
      </section>

      {/* AI narrative — INFERENCE */}
      {a.narrative ? (
        <section className="surface mb-4 border border-white/10 p-4">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
            <Lightbulb className="size-3.5" /> Why we likely lost it <span className="text-[10px] normal-case opacity-70">· inference{a.narrative.model ? ` · ${a.narrative.model}` : ""}</span>
          </div>
          <p className="text-sm">{a.narrative.why}</p>
          {a.narrative.eliteMove && (
            <div className="mt-3">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">What an elite Zoe rep would have done</div>
              <p className="mt-0.5 text-sm">{a.narrative.eliteMove}</p>
            </div>
          )}
        </section>
      ) : (
        <section className="mb-4 flex items-start gap-2 border border-white/10 bg-white/[0.03] p-3 text-sm text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" /> AI narrative unavailable — showing the facts and process analysis above.
        </section>
      )}

      {/* The contact log itself */}
      {a.internalNotes && (
        <section className="surface border border-white/10 p-4">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
            <Phone className="size-3.5" /> Contact log (from Goodshuffle)
          </div>
          <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap border border-white/5 bg-white/[0.02] p-2.5 text-xs text-muted-foreground">{a.internalNotes}</pre>
        </section>
      )}
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right tabular-nums">{value}</dd>
    </div>
  );
}
