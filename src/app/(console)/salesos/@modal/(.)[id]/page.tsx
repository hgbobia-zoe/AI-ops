// Intercepted lead route: on a soft navigation to /salesos/[id] (from the board, table, or worklist),
// render the FULL lead board inside a slide-over modal instead of a page hop. A hard load/refresh of
// /salesos/[id] skips this and renders the page normally (see ../../[id]/page.tsx).

import { LeadModal } from "@/components/LeadModal";
import { LeadBoard } from "../../LeadBoard";

export const dynamic = "force-dynamic";

export default async function InterceptedLeadModal({ params }: { params: Promise<{ id: string }> }): Promise<React.JSX.Element> {
  const { id } = await params;
  return (
    <LeadModal>
      <LeadBoard id={id} />
    </LeadModal>
  );
}
