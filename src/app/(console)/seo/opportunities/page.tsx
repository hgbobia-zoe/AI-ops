// SEO Growth — Opportunities (Phase 2). The real pipeline: discovered keyword opportunities matched against
// Zoe's site, each with a recommended action (CREATE/IMPROVE/CONSOLIDATE/SKIP), an explainable priority, and
// the first of the three approval gates. Server component — loads the workflow rows + integration health and
// hands them to the client view (table + board). FACTS ONLY: empty until a real pull runs.

import { listOpportunities } from "@/lib/seo/store";
import { getHealth } from "@/lib/seo/ubersuggest";
import { SeoOpportunities } from "@/components/seo/SeoOpportunities";

export const dynamic = "force-dynamic";

export default function SeoOpportunitiesPage(): React.JSX.Element {
  const opportunities = listOpportunities({ limit: 1000 });
  const health = getHealth();
  return <SeoOpportunities opportunities={opportunities} health={health} />;
}
