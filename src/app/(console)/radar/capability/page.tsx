// Capability Profile — the reusable company record behind bid pursuit, living under Opportunity Radar
// (the pursuit/BD house) rather than Settings. Owner/Admin only: /api/pursuit is settings-gated and this
// page re-checks. Fill once; every capability statement / solicitation response draws from it.

import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { CapabilityProfileForm } from "@/components/CapabilityProfileForm";

export const dynamic = "force-dynamic";

export default async function CapabilityPage(): Promise<React.JSX.Element> {
  const role = await viewerRole();
  if (!canManageSettings(role)) {
    return <main className="mx-auto max-w-2xl p-8 text-sm text-muted-foreground">You don&apos;t have access to the Capability Profile.</main>;
  }
  return <CapabilityProfileForm />;
}
