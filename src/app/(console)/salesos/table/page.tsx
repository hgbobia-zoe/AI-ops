// Sales OS — Table view. Every pipeline lead in one GSPRO-style grid: all the numbers at a glance,
// with status-count pills up top. Rows open the lead in the worklist detail. Money hidden for Members.

import Link from "next/link";
import { salesLeadCards, STATUS_LABEL } from "@/lib/salesos/board";
import { BOARD_COLUMNS } from "@/lib/salesos/board";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

const money = (n: number | null): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
const shortDate = (ymd: string | null): string => {
  if (!ymd) return "—";
  const d = new Date(ymd.length > 10 ? ymd : `${ymd}T00:00:00`);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

const STATUS_CHIP: Record<string, string> = {
  new: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  quote_sent: "border-sky-500/40 bg-sky-500/10 text-sky-200",
  follow_up: "border-violet-500/40 bg-violet-500/10 text-violet-200",
  action_needed: "border-rose-500/40 bg-rose-500/10 text-rose-200",
  signed: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  archived: "border-white/15 bg-white/5 text-muted-foreground",
};

export default async function SalesTablePage(): Promise<React.JSX.Element> {
  const showMoney = canSeeFinancials(await viewerRole());
  const cards = salesLeadCards();
  const counts = Object.fromEntries(BOARD_COLUMNS.map((c) => [c.key, cards.filter((l) => l.status === c.key).length]));

  return (
    <main className="p-5 md:p-6">
      <header className="mb-4">
        <h1 className="text-2xl font-bold tracking-tight">Projects</h1>
        <p className="text-sm text-muted-foreground">{cards.length} open {cards.length === 1 ? "lead" : "leads"} · every detail in one view.</p>
      </header>

      {/* Status pills */}
      <div className="mb-4 flex flex-wrap gap-2">
        {BOARD_COLUMNS.map((c) => (
          <span key={c.key} className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${STATUS_CHIP[c.key]}`}>
            {c.label} <span className="tabular-nums">{counts[c.key]}</span>
          </span>
        ))}
      </div>

      <div className="overflow-x-auto rounded-lg border border-white/10">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="p-2.5">Project</th>
              <th className="p-2.5">Client</th>
              <th className="p-2.5">Status</th>
              {showMoney && <th className="p-2.5 text-right">Quote total</th>}
              {showMoney && <th className="p-2.5 text-right">Net paid</th>}
              {showMoney && <th className="p-2.5 text-right">Remaining</th>}
              <th className="p-2.5">Quote sent</th>
              <th className="p-2.5">Event date</th>
              <th className="p-2.5">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {cards.length === 0 ? (
              <tr><td colSpan={showMoney ? 9 : 6} className="p-8 text-center text-muted-foreground">No open leads — the pipeline is clear.</td></tr>
            ) : (
              cards.map((l) => (
                <tr key={l.id} className="transition-colors hover:bg-white/[0.03]">
                  <td className="p-2.5">
                    <Link href={`/salesos/${l.id}`} className="font-medium hover:underline">{l.eventName || `Project ${l.id}`}</Link>
                  </td>
                  <td className="p-2.5 text-muted-foreground">{l.clientName || "—"}</td>
                  <td className="p-2.5">
                    <span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${STATUS_CHIP[l.status]}`}>{STATUS_LABEL[l.status]}</span>
                  </td>
                  {showMoney && <td className="p-2.5 text-right tabular-nums">{money(l.value)}</td>}
                  {showMoney && <td className="p-2.5 text-right tabular-nums text-emerald-200">{money(l.netPaid)}</td>}
                  {showMoney && <td className="p-2.5 text-right tabular-nums text-amber-200">{money(l.remainingBalance)}</td>}
                  <td className="p-2.5 text-muted-foreground">{shortDate(l.quoteSentDate)}</td>
                  <td className="p-2.5 text-muted-foreground">{shortDate(l.eventDate)}</td>
                  <td className="p-2.5 text-muted-foreground">{shortDate(l.dateCreated)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
