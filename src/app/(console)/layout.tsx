// The back-office console shell: a persistent left-nav of blades beside the active
// feature. Wraps Dashboard / Dispatch / Event Risk / Settings. The tablet (/kiosk,
// /route, /select) and customer (/track) pages live outside this group — no shell.

import { redirect } from "next/navigation";
import { ConsoleNav } from "@/components/ConsoleNav";
import { PullHealthBanner } from "@/components/PullHealthBanner";
import { ExtensionSync } from "@/components/ExtensionSync";
import { AppHeader } from "@/components/shell/AppHeader";
import { GuestShellBar } from "@/components/GuestShellBar";
import { viewerRole, currentActor, getSession } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { getShiftPass, touchShiftPass } from "@/lib/db/repo";
import { isPassLive, passIdFromUid } from "@/lib/auth/pass";
import { pullBannerState } from "@/lib/pull/state";
import { computeConnections, type Connection } from "@/lib/health/connections";
import { refreshConnecteamHealth } from "@/lib/connecteam";

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const role = await viewerRole();
  const actor = await currentActor();

  // Shift Pass holder → confirm the pass is still live (this is where a REVOKE takes effect — the cookie
  // carries expiry, but revocation is a DB fact), then render a stripped, board-only shell. No nav blades,
  // no health banners, no integrations: a contractor sees the board and nothing else.
  if (role === "guest") {
    const session = await getSession();
    const pass = getShiftPass(passIdFromUid(session?.uid) ?? "");
    if (!isPassLive(pass)) redirect("/pass-expired");
    touchShiftPass(pass.id);
    return (
      <div className="flex min-h-dvh flex-col">
        <GuestShellBar name={pass.name} expiresAt={pass.expiresAt} />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    );
  }
  // Only staff who can act on it (open GSPRO / manage the pull) see the data-health banner + integrations.
  const canManage = canManageSettings(role);
  const banner = canManage ? pullBannerState() : null;

  // Global integration summary data — the full connection list (connection health + data-pull freshness),
  // computed once server-side and handed to the header, which splits + renders it compactly. Only staff who
  // can act on it see it (members get an empty list → the summary renders nothing).
  let connections: Connection[] = [];
  if (canManage) {
    // Status rows render from the LAST probe (cached), never blocking this page on a live call. Connecteam's
    // API can stall for ~24s (12s timeout × a retry); awaiting it here froze EVERY console page while it hung.
    // So we fire-and-forget the refresh (it's TTL-cached + single-flight + never-throws) and read whatever the
    // previous probe left in the cache — at most one render stale, never a hung page.
    void refreshConnecteamHealth();
    connections = computeConnections();
  }

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <ConsoleNav role={role} viewerName={actor.label} connections={connections} />
      <div className="flex min-w-0 flex-1 flex-col">
        <AppHeader role={role} connections={connections} />
        {canManage && <PullHealthBanner initial={banner} />}
        {canManage && <ExtensionSync stale={banner != null} />}
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
