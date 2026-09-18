// Capability Profile admin (Owner/Admin). The proxy already gates /admin/* + /api/pursuit to owner/admin;
// this re-checks so the page is safe even if the route ever moves. The reusable company record behind bid
// pursuit — fill once, drawn from by every capability statement / solicitation response.

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
