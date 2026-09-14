// Sales OS master-detail shell: the ranked action worklist (left) beside the selected lead's board
// (right), full-bleed. The queue is built once here and handed to the client shell, which handles
// selection highlight, filtering, and the mobile drawer without a page navigation. The analytical
// sub-views (/salesos/bid, /salesos/lost, /salesos/trends) render inside this shell too, but the shell
// steps aside for them and shows them full-width.

import { salesCommandCenter } from "@/lib/salesos/commandCenter";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";
import { SalesShell } from "./SalesShell";

export const dynamic = "force-dynamic";

export default async function SalesOsLayout({ children, modal }: { children: React.ReactNode; modal: React.ReactNode }): Promise<React.JSX.Element> {
  const showMoney = canSeeFinancials(await viewerRole());
  const cc = salesCommandCenter();
  return (
    <>
      <SalesShell queue={cc.items} showMoney={showMoney} needAttention={cc.needAttention} justReplied={cc.justReplied} totalPotential={cc.totalPotential}>
        {children}
      </SalesShell>
      {modal}
    </>
  );
}
