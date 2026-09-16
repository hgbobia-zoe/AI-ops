// Guided Sales Intake blade — the screen-by-screen sales-call workflow. Client wizard; all data + the
// Goodshuffle create go through the API routes (server can't call Goodshuffle directly).

import { IntakeWizard } from "@/components/IntakeWizard";

export const dynamic = "force-dynamic";

export default function IntakePage(): React.JSX.Element {
  return (
    <main className="min-w-0 flex-1">
      <IntakeWizard />
    </main>
  );
}
