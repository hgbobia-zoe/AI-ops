import { Building2 } from "lucide-react";
import { SeoPlaceholder } from "@/components/seo/SeoPlaceholder";

export const dynamic = "force-dynamic";

export default function SeoCompetitorsPage(): React.JSX.Element {
  return (
    <SeoPlaceholder
      title="Competitors"
      icon={Building2}
      phase="Phase 3 — Competitor intelligence"
      summary="Which rental competitors rank for Zoe's keywords, and where the gaps are."
      points={[
        "Read competitor ranking keywords and keyword gaps from the Ubersuggest MCP.",
        "Validate competitor domains safely (no arbitrary server-side fetching of attacker-supplied URLs).",
        "Surface keyword gaps where competitors rank and Zoe does not.",
      ]}
    />
  );
}
