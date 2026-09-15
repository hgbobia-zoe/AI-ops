// Sales OS — Table view. Every pipeline lead in one GSPRO-style grid (sortable columns, clickable
// status filters). Rows open the lead in the worklist detail. Money hidden for Members.

import { salesLeadCards } from "@/lib/salesos/board";
import { viewerRole, viewerForPanel } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";
import { SalesTable } from "@/components/SalesTable";

export const dynamic = "force-dynamic";

export default async function SalesTablePage(): Promise<React.JSX.Element> {
  const showMoney = canSeeFinancials(await viewerRole());
  const viewer = await viewerForPanel();
  return <SalesTable cards={salesLeadCards()} showMoney={showMoney} viewer={viewer} />;
}
