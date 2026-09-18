// Opportunity Radar — manual import. Feed REAL opportunities from a CSV/spreadsheet/Apify export with
// no API key or scraper. Gated to settings managers.

import Link from "next/link";
import { redirect } from "next/navigation";
import { RadarTabs } from "@/components/RadarTabs";
import { ImportOpportunities } from "@/components/ImportOpportunities";
import { IMPORT_TEMPLATE } from "@/lib/opportunity/import";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export default async function ImportPage(): Promise<React.JSX.Element> {
  if (!canManageSettings(await viewerRole())) redirect("/radar");
  return (
    <main className="max-w-[1000px] p-6">
      <header className="mb-4"><h1 className="text-[22px] font-medium tracking-tight">Opportunity Radar</h1><p className="text-[12.5px] text-meta">Import real opportunities — the fastest way to start. No API key or scraper needed.</p></header>
      <RadarTabs />

      <section className="mb-4 rounded border border-border p-3 text-[12.5px] text-meta">
        <p className="mb-1"><span className="font-medium text-foreground">How to feed real data:</span></p>
        <ol className="ml-4 list-decimal space-y-0.5">
          <li>Download the template, fill a row per opportunity (a conference, an RFP, a gala). Only <code className="text-tertiary-text">name</code> is required; add <code className="text-tertiary-text">contact_name</code>/<code className="text-tertiary-text">contact_email</code> to prospect immediately.</li>
          <li>Paste the rows below and Import. They land as REAL opportunities (not seed), scored and ready.</li>
          <li>Open the <Link href="/radar" className="text-tertiary-text hover:text-foreground">dashboard</Link>, route the good ones into <Link href="/radar/outreach" className="text-tertiary-text hover:text-foreground">prospecting</Link>, and start calling / sequencing.</li>
        </ol>
        <p className="mt-1.5">For ongoing feeds: SAM.gov (set <code className="text-tertiary-text">SAM_API_KEY</code>, then <Link href="/radar/sources" className="text-tertiary-text hover:text-foreground">Run now</Link>) and the browser-agent portals. Once real data is flowing, the demo/seed rows can be ignored (they stay badged SEED).</p>
      </section>

      <ImportOpportunities template={IMPORT_TEMPLATE} />
    </main>
  );
}
