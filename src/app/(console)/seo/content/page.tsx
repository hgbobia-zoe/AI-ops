import { FileText } from "lucide-react";
import { SeoPlaceholder } from "@/components/seo/SeoPlaceholder";

export const dynamic = "force-dynamic";

export default function SeoContentStudioPage(): React.JSX.Element {
  return (
    <SeoPlaceholder
      title="Content Studio"
      icon={FileText}
      phase="Phase 4 — Content production"
      summary="Draft SEO content for approved opportunities, with imagery from the existing Creative Engine."
      points={[
        "Generate a draft brief + copy for an approved opportunity (human-approved before anything is used).",
        "Reuse the existing Creative Engine (src/lib/creative) for imagery — no new image generator is built.",
        "Link drafts to the Marketing content calendar rather than duplicating it.",
        "Hand finished drafts to the Review Queue for approval.",
      ]}
    />
  );
}
