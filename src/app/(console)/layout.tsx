// The back-office console shell: a persistent left-nav of blades beside the active
// feature. Wraps Dashboard / Dispatch / Event Risk / Settings. The tablet (/kiosk,
// /route, /select) and customer (/track) pages live outside this group — no shell.

import { redirect } from "next/navigation";
import { ConsoleNav } from "@/components/ConsoleNav";
import { PullHealthBanner } from "@/components/PullHealthBanner";
import { StatusBar, type StatusIntegration } from "@/components/StatusBar";
import { GuestShellBar } from "@/components/GuestShellBar";
import { viewerRole, currentActor, getSession } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { getShiftPass, touchShiftPass } from "@/lib/db/repo";
import { isPassLive, passIdFromUid } from "@/lib/auth/pass";
import { pullBannerState } from "@/lib/pull/state";
import { computeConnections, type ConnStatus } from "@/lib/health/connections";

const TONE: Record<ConnStatus, StatusIntegration["tone"]> = { ok: "ok", attention: "warn", off: "idle" };

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

  // Status-bar integrations — a curated few from the connections health.
  let integrations: StatusIntegration[] = [];
  if (canManage) {
    const conns = computeConnections();
    const pick = (key: string, name: string): StatusIntegration | null => {
      const c = conns.find((x) => x.key === key);
      if (!c) return null;
      return { name, tone: TONE[c.status], note: c.status === "ok" ? undefined : c.headline.toLowerCase() };
    };
    integrations = [pick("routes", "Goodshuffle"), pick("openphone", "Quo"), pick("connecteam", "Connecteam"), pick("gps", "GPS")].filter((x): x is StatusIntegration => x !== null);
  }

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <ConsoleNav role={role} viewerName={actor.label} />
      <div className="flex min-w-0 flex-1 flex-col">
        <StatusBar integrations={integrations} />
        {canManage && <PullHealthBanner initial={banner} />}
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
