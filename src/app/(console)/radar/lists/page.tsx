// Opportunity Radar — purchased contact lists (venues, planners, corporate, associations). Import a bought
// list, see how each one performs (cost per reply and per interested lead), and open one to send it to the
// cold email tool. Owner/admin only: lists hold bought contact data and what Zoe paid.

import Link from "next/link";
import { redirect } from "next/navigation";
import { FigureStrip, tableCls, theadCls, thCls, type Figure } from "@/components/console-primitives";
import { ListImport } from "@/components/radar/PurchasedLists";
import { listSummaries, SEGMENT_LABEL, LIST_TEMPLATE } from "@/lib/prospecting/lists";
import { activeProvider, sequencerConfigured, PROVIDER_LABEL } from "@/lib/prospecting/sequencer";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

const usd = (n: number | null) => (n == null ? "—" : `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 })}`);

export default async function PurchasedListsPage(): Promise<React.JSX.Element> {
  if (!canManageSettings(await viewerRole())) redirect("/radar");
  const rows = listSummaries();
  const sum = (k: "total" | "ready" | "pushed" | "replied" | "interested") => rows.reduce((a, r) => a + r.stats[k], 0);
  const figures: Figure[] = [
    { label: "Lists", value: rows.length },
    { label: "Contacts", value: sum("total") },
    { label: "Ready to send", value: sum("ready"), tone: sum("ready") ? "attention" : "default", sep: true },
    { label: "Emailed", value: sum("pushed") },
    { label: "Replied", value: sum("replied") },
    { label: "Interested", value: sum("interested"), tone: sum("interested") ? "positive" : "default" },
  ];
  const tool = PROVIDER_LABEL[activeProvider()];

  return (
    <main className="p-4 sm:p-6">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-medium tracking-tight">Purchased lists</h1>
          <p className="text-[12.5px] text-meta">
            Bought contact lists of venues, planners and other buyers, emailed through {tool} from the warmed outreach inboxes. The same do-not-contact list and Sales OS ownership rules apply as for everything Radar finds.
          </p>
        </div>
        <FigureStrip figures={figures} />
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-3 text-[11.5px] text-meta">
        <span>Cold email: {tool} <span className={sequencerConfigured() ? "text-positive" : "text-attention"}>{sequencerConfigured() ? "connected" : "not connected"}</span></span>
        <Link href="/radar/outreach" className="text-tertiary-text hover:text-foreground">Cold email settings</Link>
      </div>

      <div className="mb-6"><ListImport template={LIST_TEMPLATE} /></div>

      {rows.length === 0 ? (
        <p className="text-[13px] text-meta">No lists yet. Import one above; nothing is emailed until you review and approve a push.</p>
      ) : (
        <div className="overflow-x-auto border border-border">
          <table className={`${tableCls} min-w-[860px]`}>
            <colgroup><col /><col style={{ width: "90px" }} /><col style={{ width: "80px" }} /><col style={{ width: "80px" }} /><col style={{ width: "80px" }} /><col style={{ width: "90px" }} /><col style={{ width: "90px" }} /><col style={{ width: "120px" }} /></colgroup>
            <thead className={theadCls}>
              <tr>
                <th className={thCls}>List</th>
                <th className={`${thCls} text-right`}>Contacts</th>
                <th className={`${thCls} text-right`}>Ready</th>
                <th className={`${thCls} text-right`}>Emailed</th>
                <th className={`${thCls} text-right`}>Replied</th>
                <th className={`${thCls} text-right`}>Interested</th>
                <th className={`${thCls} text-right`}>Cost</th>
                <th className={`${thCls} text-right`}>Per interested</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ list, stats }) => (
                <tr key={list.id} className="border-t border-[var(--row-rule)] transition-colors hover:bg-[var(--row-hover)]">
                  <td className="px-2.5 py-2.5">
                    <Link href={`/radar/lists/${list.id}`} className="font-medium text-foreground hover:underline">{list.name}</Link>
                    <div className="text-[12px] text-meta">{[SEGMENT_LABEL[list.segment], list.vendor, list.purchasedAt].filter(Boolean).join(" · ")}</div>
                  </td>
                  <td className="px-2.5 py-2.5 text-right tabular-nums text-tertiary-text">{stats.total}</td>
                  <td className="px-2.5 py-2.5 text-right tabular-nums text-tertiary-text">{stats.ready}</td>
                  <td className="px-2.5 py-2.5 text-right tabular-nums text-tertiary-text">{stats.pushed}</td>
                  <td className="px-2.5 py-2.5 text-right tabular-nums text-tertiary-text">{stats.replied}</td>
                  <td className="px-2.5 py-2.5 text-right tabular-nums text-tertiary-text">{stats.interested}</td>
                  <td className="px-2.5 py-2.5 text-right tabular-nums text-tertiary-text">{usd(list.cost)}</td>
                  <td className="px-2.5 py-2.5 text-right tabular-nums text-tertiary-text">{usd(stats.costPerInterested)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
