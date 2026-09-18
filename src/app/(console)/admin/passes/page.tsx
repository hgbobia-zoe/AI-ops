// Shift Passes admin (Owner/Admin). The proxy already gates /admin/* to owner/admin; this re-checks so
// the page is safe even if the route ever moves. Generate / text / revoke link-based contractor access.

import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { ShiftPassesAdmin } from "@/components/ShiftPassesAdmin";

export const dynamic = "force-dynamic";

export default async function PassesPage(): Promise<React.JSX.Element> {
  const role = await viewerRole();
  if (!canManageSettings(role)) {
    return <main className="mx-auto max-w-2xl p-8 text-sm text-muted-foreground">You don&apos;t have access to Shift Passes.</main>;
  }
  return <ShiftPassesAdmin />;
}
