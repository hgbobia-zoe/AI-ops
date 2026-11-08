// Opportunity Radar — the full page for one opportunity (shareable link / refresh). The board opens the
// same view in a quick view side panel instead; both render OpportunityDetailView.

import { notFound } from "next/navigation";
import { OpportunityDetailView } from "@/components/radar/OpportunityDetailView";

export const dynamic = "force-dynamic";

export default async function OpportunityDetailPage({ params }: { params: Promise<{ id: string }> }): Promise<React.JSX.Element> {
  const { id } = await params;
  const view = await OpportunityDetailView({ id });
  if (!view) notFound();
  return <main className="max-w-[1100px] p-6">{view}</main>;
}
