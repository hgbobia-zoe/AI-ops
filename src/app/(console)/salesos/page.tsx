// Sales OS index — the master-detail default view: the shell (layout) renders the ranked worklist on
// the left; here we open the top-ranked lead's board on the right so the operator lands on the single
// most important thing to do, no click required. Empty state when the pipeline is clear.

import { Sparkles } from "lucide-react";
import { salesCommandCenter } from "@/lib/salesos/commandCenter";
import { LeadBoard } from "./LeadBoard";

export const dynamic = "force-dynamic";

export default async function SalesOsIndex(): Promise<React.JSX.Element> {
  const top = salesCommandCenter().items[0];
  if (!top) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-8 text-center">
        <Sparkles className="size-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No open leads — the pipeline is clear.</p>
      </div>
    );
  }
  return <LeadBoard id={top.id} />;
}
