"use client";

// The Context Pack, rendered — the verified-facts bundle the Tower would hand to Sona. Every section is
// FACT-driven; absent data shows "Unavailable" / "None on file", never a fabricated value. Money is
// redacted for viewers without financial access. Used by the call detail panel and the Voice Lab.

import { ShieldCheck, ShieldAlert, ShieldQuestion, Calendar, FileText, Package, Truck, AlertTriangle, MessageSquare, Wrench } from "lucide-react";
import { StatusMark } from "@/components/console-primitives";
import type { ContextPack } from "@/lib/comms/types";
import { fmtWhen, fmtPhoneDisplay, money, IDENTITY_TONE, IDENTITY_LABEL, LOGISTICS_LABEL } from "./helpers";
import type { ContextLogistics } from "@/lib/comms/types";

function Section({ title, icon: Icon, count, children }: { title: string; icon: typeof Calendar; count?: number; children: React.ReactNode }): React.JSX.Element {
  return (
    <section>
      <h4 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-meta">
        <Icon className="size-3.5" /> {title}
        {count != null && <span className="tabular-nums text-tertiary-text">· {count}</span>}
      </h4>
      {children}
    </section>
  );
}

const IdentityIcon = { CONFIRMED: ShieldCheck, MULTIPLE_MATCHES: ShieldAlert, UNKNOWN: ShieldQuestion } as const;

function Logistics({ label, l }: { label: string; l: ContextLogistics }): React.JSX.Element {
  const tone = l.availability === "UNAVAILABLE" ? "idle" : l.availability === "COMPLETE" ? "positive" : l.availability === "IN_PROGRESS" ? "attention" : "positive";
  return (
    <div className="rounded border border-border p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[12px] text-tertiary-text">{label}</span>
        <StatusMark tone={tone as "positive" | "attention" | "idle"} label={LOGISTICS_LABEL[l.availability]} />
      </div>
      {l.availability !== "UNAVAILABLE" ? (
        <div className="mt-1 space-y-0.5 text-[12px] text-meta">
          {l.window && <div>Window: <span className="text-tertiary-text">{l.window}</span></div>}
          {l.eta && <div>ETA: <span className="text-tertiary-text">{l.eta}</span></div>}
          {l.state && <div>State: <span className="text-tertiary-text">{l.state}</span></div>}
        </div>
      ) : (
        <p className="mt-1 text-[11.5px] text-meta">No matching stop on any dispatch route.</p>
      )}
    </div>
  );
}

export function ContextPackView({ pack, showMoney }: { pack: ContextPack; showMoney: boolean }): React.JSX.Element {
  const id = pack.caller;
  const IdIcon = IdentityIcon[id.confidence];
  const idTone = IDENTITY_TONE[id.confidence];
  const toneText = idTone === "positive" ? "text-positive" : idTone === "attention" ? "text-attention" : "text-critical";

  return (
    <div className="space-y-4">
      {/* Identity — always explicit */}
      <section className={`rounded border p-3 ${id.confidence === "CONFIRMED" ? "border-border" : id.confidence === "MULTIPLE_MATCHES" ? "border-attention/40 bg-attention/[0.04]" : "border-critical/40 bg-critical/[0.04]"}`}>
        <div className="flex items-center gap-2">
          <IdIcon className={`size-4 ${toneText}`} />
          <span className={`text-[12px] font-medium uppercase tracking-[0.06em] ${toneText}`}>Identity: {IDENTITY_LABEL[id.confidence]}</span>
        </div>
        <p className="mt-1 text-[12.5px] text-tertiary-text">{id.reason}</p>
        {id.matches.length > 1 && (
          <ul className="mt-2 space-y-1">
            {id.matches.map((m) => (
              <li key={m.bookingId} className="flex items-center justify-between text-[12px]">
                <span className="text-foreground">{m.name}</span>
                <span className="text-meta">{m.eventDate ?? "no date"} · {m.status || "—"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Customer */}
      <Section title="Customer" icon={ShieldCheck}>
        {pack.customer ? (
          <div className="rounded border border-border p-2.5 text-[13px]">
            <div className="font-medium text-foreground">{pack.customer.name}</div>
            <div className="mt-0.5 text-[12px] text-meta">{fmtPhoneDisplay(pack.customer.phone)}{pack.customer.email ? ` · ${pack.customer.email}` : ""}</div>
          </div>
        ) : (
          <p className="text-[12.5px] text-meta">Unknown caller — no customer matched. Treat all details as unverified.</p>
        )}
      </Section>

      {/* Events */}
      <Section title="Events" icon={Calendar} count={pack.events.length}>
        {pack.events.length ? (
          <ul className="space-y-1">
            {pack.events.map((e) => (
              <li key={e.bookingId} className="flex items-center justify-between rounded border border-border px-2.5 py-1.5 text-[12.5px]">
                <span className="min-w-0 truncate text-foreground">{e.name}</span>
                <span className="shrink-0 text-meta">{e.eventDate ?? "no date"} · {e.signed ? "Signed" : "Quote"}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12.5px] text-meta">None on file.</p>
        )}
      </Section>

      {/* Active quotes + orders */}
      <div className="grid grid-cols-1 gap-4 @md:grid-cols-2">
        <Section title="Active quotes" icon={FileText} count={pack.activeQuotes.length}>
          {pack.activeQuotes.length ? (
            <ul className="space-y-1">
              {pack.activeQuotes.map((q) => (
                <li key={q.bookingId} className="rounded border border-border px-2.5 py-1.5 text-[12.5px]">
                  <div className="truncate text-foreground">{q.name}</div>
                  <div className="mt-0.5 text-[11.5px] text-meta">{q.eventDate ?? "no date"} · {money(q.total, showMoney)}{q.quoteSentDate ? ` · sent ${q.quoteSentDate}` : ""}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12.5px] text-meta">None.</p>
          )}
        </Section>
        <Section title="Orders" icon={Package} count={pack.orders.length}>
          {pack.orders.length ? (
            <ul className="space-y-1">
              {pack.orders.map((o) => (
                <li key={o.bookingId} className="rounded border border-border px-2.5 py-1.5 text-[12.5px]">
                  <div className="truncate text-foreground">{o.name}</div>
                  <div className="mt-0.5 text-[11.5px] text-meta">{money(o.total, showMoney)} · due {money(o.amountDue, showMoney)}</div>
                  <div className="mt-0.5 text-[11px] text-meta">{o.lineItems == null ? "Line items: Unavailable" : `${o.lineItems.length} item(s)`}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12.5px] text-meta">None.</p>
          )}
        </Section>
      </div>

      {/* Delivery + pickup */}
      <Section title="Delivery & pickup" icon={Truck}>
        <div className="grid grid-cols-1 gap-2 @md:grid-cols-2">
          <Logistics label="Delivery" l={pack.delivery} />
          <Logistics label="Pickup" l={pack.pickup} />
        </div>
      </Section>

      {/* Operational risk */}
      <Section title="Operational risk" icon={AlertTriangle} count={pack.operationalRisk.length}>
        {pack.operationalRisk.length ? (
          <ul className="space-y-1">
            {pack.operationalRisk.map((r, i) => (
              <li key={i} className="flex items-center gap-2 rounded border border-attention/30 bg-attention/[0.03] px-2.5 py-1.5 text-[12.5px]">
                <span className="text-attention">{r.severity}</span>
                <span className="min-w-0 truncate text-tertiary-text">{r.title}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12.5px] text-meta">No open operational risk on the caller&apos;s events.</p>
        )}
      </Section>

      {/* Open items */}
      <Section title="Open items" icon={AlertTriangle} count={pack.openIssues.length}>
        {pack.openIssues.length ? (
          <ul className="space-y-1">
            {pack.openIssues.map((it, i) => (
              <li key={i} className="rounded border border-border px-2.5 py-1.5 text-[12.5px]">
                <span className="text-foreground capitalize">{it.label}</span>
                {it.detail && <span className="ml-1.5 text-meta">— {it.detail}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12.5px] text-meta">None.</p>
        )}
      </Section>

      {/* Recent interactions */}
      <Section title="Recent interactions" icon={MessageSquare} count={pack.recentInteractions.length}>
        {pack.recentInteractions.length ? (
          <ul className="space-y-1">
            {pack.recentInteractions.slice(0, 8).map((it, i) => (
              <li key={i} className="flex items-start gap-2 text-[12.5px]">
                <span className="mt-0.5 w-10 shrink-0 text-[10.5px] uppercase tracking-wide text-meta">{it.channel}</span>
                <span className="min-w-0 flex-1 truncate text-tertiary-text">{it.preview || "—"}</span>
                <span className="shrink-0 text-[11px] text-meta">{fmtWhen(it.when)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12.5px] text-meta">None on file.</p>
        )}
      </Section>

      {/* Allowed actions */}
      <Section title="Allowed actions (still permission-gated)" icon={Wrench} count={pack.allowedActions.length}>
        <div className="flex flex-wrap gap-1.5">
          {pack.allowedActions.map((a) => (
            <span key={a} className="rounded border border-border px-1.5 py-0.5 text-[11px] text-meta">{a}</span>
          ))}
        </div>
      </Section>

      {/* Honest caveats */}
      {pack.notes.length > 0 && (
        <section className="rounded border border-border bg-[var(--row)] p-2.5">
          <div className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-meta">Caveats</div>
          <ul className="mt-1 space-y-0.5 text-[11.5px] text-meta">
            {pack.notes.map((n, i) => <li key={i}>· {n}</li>)}
          </ul>
        </section>
      )}
    </div>
  );
}
