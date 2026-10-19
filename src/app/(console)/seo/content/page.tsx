// SEO Growth — Content Studio. Produce + preview structured landing-page drafts for APPROVED opportunities.
// Server component: loads the producible opportunities (+ their draft summaries) and hands them to the client
// view. FACTS ONLY — drafts state verified facts and mark everything else for human review; nothing publishes.

import { contentStudioRows } from "@/lib/seo/produce";
import { SeoContentStudio } from "@/components/seo/SeoContentStudio";

export const dynamic = "force-dynamic";

export default function SeoContentStudioPage(): React.JSX.Element {
  return <SeoContentStudio rows={contentStudioRows()} />;
}
