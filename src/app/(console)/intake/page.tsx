// New Project — the primary entry point for starting a customer project (reached from the "New Project"
// action in the left nav). It hosts the existing guided sales intake: a screen-by-screen discovery that
// ends in a Goodshuffle project shell. Client wizard; all data + the Goodshuffle create go through the API
// routes (server can't call Goodshuffle directly). Inventory is added in Goodshuffle afterward, by design.

import { IntakeWizard } from "@/components/IntakeWizard";

export const dynamic = "force-dynamic";

export default function IntakePage(): React.JSX.Element {
  return (
    <main className="min-w-0 flex-1">
      <IntakeWizard />
    </main>
  );
}
