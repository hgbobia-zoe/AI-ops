import { Rocket } from "lucide-react";
import { SeoPlaceholder } from "@/components/seo/SeoPlaceholder";

export const dynamic = "force-dynamic";

export default function SeoPerformancePage(): React.JSX.Element {
  return (
    <SeoPlaceholder
      title="Performance"
      icon={Rocket}
      phase="Phase 5 — Publishing & outcomes"
      summary="What went live, and how it actually performed — measured, never estimated."
      points={[
        "Track published content and the external hop to the (separate WordPress) marketing website.",
        "Record real ranking / traffic outcomes once a measurement source is connected — no fabricated metrics.",
        "Close the loop from opportunity to published page to measured result.",
      ]}
    />
  );
}
