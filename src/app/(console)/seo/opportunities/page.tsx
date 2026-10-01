import { Search } from "lucide-react";
import { SeoPlaceholder } from "@/components/seo/SeoPlaceholder";

export const dynamic = "force-dynamic";

export default function SeoOpportunitiesPage(): React.JSX.Element {
  return (
    <SeoPlaceholder
      title="Opportunities"
      icon={Search}
      phase="Phase 2 — Opportunity matching"
      summary="Keyword opportunities, matched against Zoe's site, with a recommended action."
      points={[
        "Pull keyword ideas + volume/difficulty/intent from the Ubersuggest MCP for Zoe's categories and geographies.",
        "Match each keyword to an existing Zoe URL (or none) and recommend CREATE, IMPROVE, CONSOLIDATE or SKIP.",
        "De-duplicate on keyword + intent + geography so re-pulls never create duplicate opportunities.",
        "Queue each opportunity for human analysis and approval.",
      ]}
    />
  );
}
