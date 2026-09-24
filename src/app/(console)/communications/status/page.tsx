// Integrations — observable communications health (Quo connected, Sona not, Context API available).

import { IntegrationsView } from "@/components/communications/IntegrationsView";
import { getCommsHealth } from "@/lib/comms/health";

export const dynamic = "force-dynamic";

export default function CommunicationsStatusPage(): React.JSX.Element {
  return <IntegrationsView integrations={getCommsHealth()} />;
}
