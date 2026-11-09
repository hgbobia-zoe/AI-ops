// Opportunity Radar — one purchased list: its funnel, the approved push to the cold email tool, its
// details, and every contact with why it can or can't be emailed. Replies are logged here; an interested
// reply becomes a Radar opportunity. Owner/admin only.

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { FigureStrip, tableCls, theadCls, thCls, type Figure } from "@/components/console-primitives";
import { ListPushPanel, ListSettings, ListContactOutcome } from "@/components/radar/PurchasedLists";
import {
  getList, screenedContacts, listStats, convertedOpportunityIds, listCampaign, SEGMENT_LABEL, CONTACT_STATUS_LABEL, MAX_PUSH,
  type ScreenedContact,
} from "@/lib/prospecting/lists";
import { activeProvider, providerApiKey, unsupportedProvider, PROVIDER_LABEL } from "@/lib/prospecting/sequencer";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

const PAGE = 100;
const SHOW = {
  all: { label: "All", test: () => true },
  ready: { label: "Ready", test: (c: ScreenedContact) => c.eligible },
  blocked: { label: "Can't send", test: (c: ScreenedContact) => c.status === "new" && !c.eligible },
  emailed: { label: "Emailed", test: (c: ScreenedContact) => c.pushedAt != null },
  replies: { label: "Replies", test: (c: ScreenedContact) => ["replied", "interested", "not_interested", "bounced", "unsubscribed"].includes(c.status) },
} as const;
type Show = keyof typeof SHOW;

const usd = (n: number | null) => (n == null ? "—" : `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 })}`);

export default async function PurchasedListPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ show?: string; page?: string }> }): Promise<React.JSX.Element> {
  if (!canManageSettings(await viewerRole())) redirect("/radar");
  const { id } = await params;
  const sp = await searchParams;
  const list = getList(id);
  if (!list) notFound();

  const contacts = screenedContacts(id);
  const stats = listStats(list, contacts, convertedOpportunityIds());
  const show: Show = sp.show && sp.show in SHOW ? (sp.show as Show) : "all";
  const filtered = contacts.filter(SHOW[show].test);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const page = Math.min(pages, Math.max(1, Number(sp.page) || 1));
  const shown = filtered.slice((page - 1) * PAGE, page * PAGE);
  const href = (patch: { show?: Show; page?: number }) => {
    const q = new URLSearchParams();
    const s = patch.show ?? show;
    const p = patch.page ?? (patch.show ? 1 : page);
    if (s !== "all") q.set("show", s);
    if (p > 1) q.set("page", String(p));
    const qs = q.toString();
    return `/radar/lists/${id}${qs ? `?${qs}` : ""}`;
  };

  const provider = activeProvider();
  const tool = PROVIDER_LABEL[provider];
  const campaign = listCampaign(list, provider);
  const campaignLabel = campaign
    ? `Into ${list.campaignId ? "this list's" : "the default"} campaign ${campaign}.`
    : "No campaign yet: add one to this list (Edit list) or a default one in the cold email settings.";

  const figures: Figure[] = [
    { label: "Contacts", value: stats.total },
    { label: "Ready", value: stats.ready, tone: stats.ready ? "attention" : "default" },
    { label: "Can't send", value: stats.blocked },
    { label: "Emailed", value: stats.pushed, sep: true },
    { label: "Replied", value: stats.replied },
    { label: "Interested", value: stats.interested, tone: stats.interested ? "positive" : "default" },
    { label: "Won", value: stats.converted },
  ];

  return (
    <main className="max-w-[1200px] p-4 sm:p-6">
      <div className="mb-3 text-[12px] text-meta"><Link href="/radar/lists" className="hover:text-foreground">Purchased lists</Link> / {list.name}</div>
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-medium tracking-tight">{list.name}</h1>
          <p className="text-[12.5px] text-meta">
            {[SEGMENT_LABEL[list.segment], list.vendor && `from ${list.vendor}`, list.purchasedAt && `bought ${list.purchasedAt}`, list.cost != null && `${usd(list.cost)} paid`].filter(Boolean).join(" · ")}
            {list.cost != null && ` · ${usd(stats.costPerContact)} per contact, ${usd(stats.costPerReply)} per reply, ${usd(stats.costPerInterested)} per interested lead`}
          </p>
        </div>
        <FigureStrip figures={figures} />
      </header>

      <ListPushPanel listId={id} ready={stats.ready} provider={tool} connected={Boolean(providerApiKey(provider) && campaign && !unsupportedProvider())} campaignLabel={campaignLabel} maxPush={MAX_PUSH} />
      <div className="mb-4"><ListSettings list={list} canDelete={stats.pushed === 0} /></div>
      {list.notes && <p className="mb-4 whitespace-pre-wrap text-[12.5px] text-tertiary-text">{list.notes}</p>}

      <nav className="mb-2 flex flex-wrap gap-1 text-[12px]" aria-label="Filter contacts">
        {(Object.keys(SHOW) as Show[]).map((k) => (
          <Link key={k} href={href({ show: k })} scroll={false} aria-current={show === k ? "page" : undefined}
            className={`rounded border px-2 py-0.5 ${show === k ? "border-ring text-foreground" : "border-border text-tertiary-text hover:text-foreground"}`}>
            {SHOW[k].label} · {contacts.filter(SHOW[k].test).length}
          </Link>
        ))}
      </nav>

      {shown.length === 0 ? (
        <p className="text-[13px] text-meta">Nobody here.</p>
      ) : (
        <div className="overflow-x-auto border border-border">
          <table className={`${tableCls} min-w-[880px]`}>
            <colgroup><col /><col style={{ width: "230px" }} /><col style={{ width: "140px" }} /><col style={{ width: "230px" }} /><col style={{ width: "150px" }} /></colgroup>
            <thead className={theadCls}>
              <tr><th className={thCls}>Contact</th><th className={thCls}>Company</th><th className={thCls}>Location</th><th className={thCls}>Status</th><th className={thCls}>Reply</th></tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.id} className="border-t border-[var(--row-rule)] align-top transition-colors hover:bg-[var(--row-hover)]">
                  <td className="px-2.5 py-2">
                    <div className="text-foreground">{[c.firstName, c.lastName].filter(Boolean).join(" ") || <span className="text-meta">No name</span>}</div>
                    <div className="break-all text-[12px] text-meta">{c.email}{c.title ? ` · ${c.title}` : ""}</div>
                  </td>
                  <td className="px-2.5 py-2 text-[12.5px] text-tertiary-text">{c.company ?? "—"}{c.phone && <div className="text-[11.5px] text-meta">{c.phone}</div>}</td>
                  <td className="px-2.5 py-2 text-[12.5px] text-tertiary-text">{[c.city, c.state].filter(Boolean).join(", ") || "—"}</td>
                  <td className="px-2.5 py-2 text-[12.5px]">
                    {c.status === "new"
                      ? c.eligible ? <span className="text-positive">Ready</span> : <span className="text-critical">Can&apos;t send: {c.blockers.join("; ")}</span>
                      : <span className="text-tertiary-text">{CONTACT_STATUS_LABEL[c.status]}{c.pushedAt ? ` · ${c.pushedAt.slice(0, 10)}` : ""}</span>}
                    {c.skipReason && <div className="text-[11.5px] text-meta">{c.skipReason}</div>}
                  </td>
                  <td className="px-2.5 py-2">
                    {c.opportunityId
                      ? <Link href={`/radar/${c.opportunityId}`} className="text-[12px] text-tertiary-text hover:text-foreground">Open opportunity</Link>
                      : c.pushedAt || c.status !== "new" ? <ListContactOutcome contactId={c.id} /> : <span className="text-[12px] text-meta">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <div className="mt-3 flex items-center gap-2 text-[12px] text-meta">
          {page > 1 && <Link href={href({ page: page - 1 })} className="text-tertiary-text hover:text-foreground">Previous</Link>}
          <span>Page {page} of {pages}</span>
          {page < pages && <Link href={href({ page: page + 1 })} className="text-tertiary-text hover:text-foreground">Next</Link>}
        </div>
      )}
    </main>
  );
}
