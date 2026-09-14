// The back-office console shell: a persistent left-nav of blades beside the active
// feature. Wraps Dashboard / Dispatch / Event Risk / Settings. The tablet (/kiosk,
// /route, /select) and customer (/track) pages live outside this group — no shell.

import { ConsoleNav } from "@/components/ConsoleNav";
import { PullHealthBanner } from "@/components/PullHealthBanner";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { pullBannerState } from "@/lib/pull/state";

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const role = await viewerRole();
  // Only staff who can act on it (open GSPRO / manage the pull) see the data-health banner. Mounted
  // even when currently healthy so it can appear (and auto-clear) live as the pull status changes.
  const canManage = canManageSettings(role);
  const banner = canManage ? pullBannerState() : null;
  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <ConsoleNav role={role} />
      <div className="flex min-w-0 flex-1 flex-col">
        {canManage && <PullHealthBanner initial={banner} />}
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
