// A specific lead's board inside the Sales OS master-detail. Thin wrapper — the worklist rail comes
// from the shell (layout); all the lead content lives in LeadBoard, shared with the index view.

import { LeadBoard } from "../LeadBoard";

export const dynamic = "force-dynamic";

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }): Promise<React.JSX.Element> {
  const { id } = await params;
  return <LeadBoard id={id} />;
}
