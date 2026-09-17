// The back-office console shell: a persistent left-nav of blades beside the active
// feature. Wraps Dashboard / Dispatch / Event Risk / Settings. The tablet (/kiosk,
// /route, /select) and customer (/track) pages live outside this group — no shell.

import { ConsoleNav } from "@/components/ConsoleNav";
import { PullHealthBanner } from "@/components/PullHealthBanner";
import { StatusBar, type StatusIntegration } from "@/components/StatusBar";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { pullBannerState } from "@/lib/pull/state";
import { computeConnections, type ConnStatus } from "@/lib/health/connections";

const TONE: Record<ConnStatus, StatusIntegration["tone"]> = { ok: "ok", attention: "warn", off: "idle" };

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const role = await viewerRole();
  const actor = await currentActor();
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
