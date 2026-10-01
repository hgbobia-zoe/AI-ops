import { ClipboardCheck } from "lucide-react";
import { SeoPlaceholder } from "@/components/seo/SeoPlaceholder";

export const dynamic = "force-dynamic";

export default function SeoReviewQueuePage(): React.JSX.Element {
  return (
    <SeoPlaceholder
      title="Review Queue"
      icon={ClipboardCheck}
      phase="Phase 4 — Approval workflow"
      summary="Human go/no-go on recommended opportunities and finished drafts before anything ships."
      points={[
        "Approve, defer or reject each analyzed opportunity, with the decision recorded in its history.",
        "Review generated drafts and request changes before publishing.",
        "Every transition is logged to the opportunity's decision history (already modeled in Phase 1).",
      ]}
    />
  );
}
