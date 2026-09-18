// Marketing lead-source attribution blade — tag recent bookings with the channel that brought them.

import { LeadSourcesBoard } from "@/components/marketing/LeadSourcesBoard";

export const dynamic = "force-dynamic";

export default function LeadSourcesPage(): React.JSX.Element {
  return <LeadSourcesBoard />;
}
