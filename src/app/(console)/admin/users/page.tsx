// Team management (Owner/Admin). Add teammates, set roles, activate/deactivate. Owner manages
// everyone; Admin manages Members only. The proxy already blocks Members from this route.

import { UserCog } from "lucide-react";
import { listUsers } from "@/lib/auth/users";
import { viewerRole, getSession, authEnabled } from "@/lib/auth/getSession";
import { canManageUsers } from "@/lib/auth/roles";
import { UsersAdmin } from "@/components/UsersAdmin";

export const dynamic = "force-dynamic";

export default async function UsersPage(): Promise<React.JSX.Element> {
  const role = await viewerRole();
  if (!canManageUsers(role)) {
    return <main className="mx-auto max-w-2xl p-8 text-sm text-muted-foreground">You don&apos;t have access to team management.</main>;
  }
  const session = await getSession();
  const users = listUsers();

  return (
    <main className="mx-auto max-w-4xl p-5 pb-16 md:p-8">
      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <UserCog className="size-7" /> Team
        </h1>
        <p className="text-sm text-muted-foreground">
          Roles: <b>Owner</b> (everything), <b>Admin</b> (ops + financials + settings, manages Members), <b>Member</b> (ops only, no money).
        </p>
      </header>

      {!authEnabled() && (
        <div className="mb-5 border border-amber-500/40 bg-amber-500/10 p-3 text-[13px] text-amber-200">
          The access gate is not active yet. Set <b>APP_SESSION_TOKEN</b> and an owner password (OWNER_PASSWORD / OWNER_USERNAME)
          as Fly secrets to turn on sign-in; changes here take effect once it&apos;s on.
        </div>
      )}

      <UsersAdmin initialUsers={users} viewerRole={role} viewerId={session?.uid ?? null} />
    </main>
  );
}
