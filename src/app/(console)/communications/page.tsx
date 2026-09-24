// Communications — the live/recent call + SMS queue (the blade's landing view). Money in the caller
// context is redacted for viewers without financial access.

import { CommsQueue } from "@/components/communications/CommsQueue";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export default async function CommunicationsPage(): Promise<React.JSX.Element> {
  const role = await viewerRole();
  return <CommsQueue showMoney={canSeeFinancials(role)} />;
}
