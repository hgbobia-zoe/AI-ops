// Design-system showcase — a dev/ops reference for the Nocturne shared tokens + primitives.
// Admin-only (under /admin, already gated by the proxy; self-guarded here too) and deliberately NOT
// in the console nav — it is an internal reference surface, not a product route. Fixture content only.

import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { DesignShowcase } from "./DesignShowcase";

export const dynamic = "force-dynamic";

export default async function DesignSystemPage(): Promise<React.JSX.Element> {
  const role = await viewerRole();
  if (!canManageSettings(role)) {
    return (
      <main className="mx-auto max-w-2xl p-8 text-sm text-muted-foreground">
        You don&apos;t have access to the design-system reference.
      </main>
    );
  }
  return <DesignShowcase />;
}
