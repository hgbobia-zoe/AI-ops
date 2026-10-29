// SEO Growth — Opportunities (Phase 2). The real pipeline: discovered keyword opportunities matched against
// Zoe's site, each with a recommended action (CREATE/IMPROVE/CONSOLIDATE/SKIP), an explainable priority, and
// the first of the three approval gates. Server component — loads the workflow rows + the (freshness-based)
// SERP source health, and the local stage/search filters from the URL so they survive a reload. Hands
// everything to the client view (table + board). FACTS ONLY: empty until a real SERP read runs.

import { listOpportunities } from "@/lib/seo/store";
import { serpHealth } from "@/lib/seo/watcher";
import { SeoOpportunities } from "@/components/seo/SeoOpportunities";
import { isStage } from "@/lib/seo/stages";

export const dynamic = "force-dynamic";

export default async function SeoOpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ stage?: string | string[]; q?: string | string[] }>;
}): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const stageParam = Array.isArray(sp.stage) ? sp.stage[0] : sp.stage;
  const qParam = Array.isArray(sp.q) ? sp.q[0] : sp.q;
  const opportunities = listOpportunities({ limit: 1000 });
  const health = serpHealth();
  return (
    <SeoOpportunities
      opportunities={opportunities}
      health={health}
      initialStage={stageParam && isStage(stageParam) ? stageParam : ""}
      initialQuery={qParam ?? ""}
    />
  );
}
