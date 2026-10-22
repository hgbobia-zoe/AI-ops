// Inventory Automation blade — bulk-copy a partner's Goodshuffle catalog into Zoe's own inventory for
// sub-rental (and, later, bulk inventory cleanup). Owner/admin only — gated in the proxy (isInventory)
// and the /api/inventory/plan handler (canManageSettings). The interactive work lives in the client
// component; this page is just the entry point.

import { InventoryAutomation } from "@/components/inventory/InventoryAutomation";

export const dynamic = "force-dynamic";

export default function InventoryPage(): React.JSX.Element {
  return <InventoryAutomation />;
}
