// Voice Lab — simulate a call to validate context assembly before going on a real line.

import { VoiceLab } from "@/components/communications/VoiceLab";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export default async function VoiceLabPage(): Promise<React.JSX.Element> {
  const role = await viewerRole();
  return <VoiceLab showMoney={canSeeFinancials(role)} />;
}
