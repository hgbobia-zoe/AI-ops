// Sales OS — Kanban board view. Columns by sales stage; drag cards to move them through the pipeline
// (status persists). Clicking a tile opens the full lead in the side panel (no page hop). Full-width
// under the shared view switcher.

import { salesBoard } from "@/lib/salesos/board";
import { viewerRole, viewerInitials, viewerQuoUserId, currentActor } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";
import { SalesBoard } from "@/components/SalesBoard";

export const dynamic = "force-dynamic";

export default async function SalesBoardPage(): Promise<React.JSX.Element> {
  const showMoney = canSeeFinancials(await viewerRole());
  const { columns, cards } = salesBoard();
  const [name, quoUserId, initials] = await Promise.all([currentActor(), viewerQuoUserId(), viewerInitials()]);
  const viewer = { name: name.label, quoUserId, initials: initials ?? "" };
  return <SalesBoard columns={columns} initialCards={cards} showMoney={showMoney} viewer={viewer} />;
}
