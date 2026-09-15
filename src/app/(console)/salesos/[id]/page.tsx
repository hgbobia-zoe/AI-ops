// A specific lead under /salesos/[id]: the shell renders the worklist with this lead pre-selected in the
// detail panel; the full board opens as a modal (@modal/(.)[id]) on soft navigation. This route itself
// renders nothing — kept so the URL resolves on a hard load / deep link.

export const dynamic = "force-dynamic";

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }): Promise<null> {
  await params;
  return null;
}
