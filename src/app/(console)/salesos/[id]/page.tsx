// A specific lead under /salesos/[id] — the full lead board (deep link / "Open full lead"). The shell
// renders this as the detail for a lead-id path; the worklist owns the index and the board/table have
// their own side-drawer preview.

import { LeadBoard } from "../LeadBoard";

export const dynamic = "force-dynamic";

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }): Promise<React.JSX.Element> {
  const { id } = await params;
  return <LeadBoard id={id} />;
}
