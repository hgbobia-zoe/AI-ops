// Marketing content calendar blade — passes the team's Confluence + poster links so the plan-here /
// post-there flow is one click either direction.

import { ContentBoard } from "@/components/marketing/ContentBoard";
import { getChannelLinks } from "@/lib/marketing/store";

export const dynamic = "force-dynamic";

export default function ContentPage(): React.JSX.Element {
  const links = getChannelLinks();
  return <ContentBoard confluenceUrl={links.confluence || undefined} posterUrl={links.poster || undefined} />;
}
