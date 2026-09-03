// Operational History (MVP4) — the factual memory of the operation. An append-only feed of
// what changed and when: risks detected/escalated/resolved, drivers assigned, stops pulled.
// Read-only observer of the other systems — it never decides anything, it just remembers.

import { History, ShieldAlert, Truck, Package, CircleDot } from "lucide-react";
import { getRecentChanges, type ChangeRow } from "@/lib/history/store";

export const dynamic = "force-dynamic";

// One human-readable line + an icon per change kind. Deterministic — no interpretation.
function describe(c: ChangeRow): { icon: React.ReactNode; text: React.ReactNode; tone: string } {
  const risk = <ShieldAlert className="size-4" />;
  const truck = <Truck className="size-4" />;
  const pkg = <Package className="size-4" />;
  const dot = <CircleDot className="size-4" />;
  const target = c.field || c.entityId || "an item";
  switch (c.kind) {
    case "risk_detected":
      return { icon: risk, tone: "text-amber-300", text: <>New risk detected — <b>{target}</b>{c.toValue ? ` (${c.toValue})` : ""}</> };
    case "risk_escalated":
      return { icon: risk, tone: "text-red-300", text: <>Risk escalated — <b>{target}</b> {c.fromValue} → <b>{c.toValue}</b></> };
    case "risk_resolved":
      return { icon: risk, tone: "text-emerald-300", text: <>Risk resolved — <b>{target}</b></> };
    case "risk_regressed":
      return { icon: risk, tone: "text-orange-300", text: <>Risk returned — <b>{target}</b></> };
    case "driver_assigned":
      return { icon: truck, tone: "text-sky-300", text: <>Driver assigned to <b>{c.entityId}</b> — {c.toValue}</> };
    case "driver_reassigned":
      return { icon: truck, tone: "text-sky-300", text: <>Driver changed on <b>{c.entityId}</b> — {c.fromValue} → <b>{c.toValue}</b></> };
    case "driver_cleared":
      return { icon: truck, tone: "text-muted-foreground", text: <>Driver cleared from <b>{c.entityId}</b>{c.fromValue ? ` (was ${c.fromValue})` : ""}</> };
    case "stop_removed":
      return { icon: pkg, tone: "text-muted-foreground", text: <>Stop pulled from route <b>{c.fromValue}</b></> };
    case "event_rescheduled":
      return { icon: dot, tone: "text-sky-300", text: <>Event rescheduled — <b>{target}</b> {c.fromValue} → <b>{c.toValue}</b></> };
    case "booking_value_changed":
      return { icon: dot, tone: "text-emerald-300", text: <>Booking value changed — <b>{target}</b> ${c.fromValue} → <b>${c.toValue}</b></> };
    case "event_completed":
      return { icon: pkg, tone: c.toValue === "complete" ? "text-emerald-300" : "text-amber-300", text: <>Event closed — <b>{target}</b> {c.field}</> };
    default:
      return { icon: dot, tone: "text-muted-foreground", text: <>{c.kind} — {target}</> };
  }
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  const key = (x: Date) => x.toISOString().slice(0, 10);
  if (key(d) === key(today)) return "Today";
  if (key(d) === key(y)) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

const time = (iso: string): string => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

export default async function HistoryPage(): Promise<React.JSX.Element> {
  const changes = getRecentChanges(200);

  // Group by calendar day (already sorted newest-first).
  const groups: { label: string; items: ChangeRow[] }[] = [];
  for (const c of changes) {
    const label = dayLabel(c.ts);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(c);
    else groups.push({ label, items: [c] });
  }

  return (
    <main className="mx-auto max-w-3xl p-5 pb-16 md:p-8">
      <header className="mb-6">
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <History className="size-7" /> Operational History
        </h1>
        <p className="text-sm text-muted-foreground">
          Everything that changed across dispatch and risk — the operation&apos;s memory. Append-only; nothing here is editable.
        </p>
      </header>

      {changes.length === 0 ? (
        <div className="border border-white/10 p-8 text-center text-sm text-muted-foreground">
          No changes recorded yet. As risks are detected, drivers assigned, and stops pulled, they&apos;ll appear here.
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <section key={g.label}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.label}</h2>
              <ul className="space-y-px overflow-hidden border border-white/10">
                {g.items.map((c) => {
                  const d = describe(c);
                  return (
                    <li key={c.id} className="flex items-start gap-3 bg-white/[0.02] px-3 py-2.5 text-sm">
                      <span className={`mt-0.5 shrink-0 ${d.tone}`}>{d.icon}</span>
                      <span className="min-w-0 flex-1">{d.text}</span>
                      <time className="shrink-0 tabular-nums text-xs text-muted-foreground" dateTime={c.ts}>
                        {time(c.ts)}
                      </time>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      <p className="mt-6 text-[11px] text-muted-foreground">
        History is captured automatically by the risk scan and by dispatch actions. Per-event timelines appear in the
        readiness details on the Event Risk page.
      </p>
    </main>
  );
}
