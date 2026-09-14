// Sales OS — Kanban board view. Columns by sales stage; drag cards to move them through the pipeline
// (status persists). Archived cards drop off. Full-width under the shared view switcher.

import { salesBoard } from "@/lib/salesos/board";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";
import { SalesBoard } from "@/components/SalesBoard";

export const dynamic = "force-dynamic";

export default async function SalesBoardPage(): Promise<React.JSX.Element> {
  const showMoney = canSeeFinancials(await viewerRole());
  const { columns, cards } = salesBoard();
  return <SalesBoard columns={columns} initialCards={cards} showMoney={showMoney} />;
}
