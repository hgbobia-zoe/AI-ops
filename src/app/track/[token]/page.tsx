// Public customer tracking page — our self-hosted "share link." Shows the delivery
// status + ETA for a stop by opaque token (the token is the capability; no auth).
// When Zonar is configured, the ETA is REAL — computed from the truck's live GPS
// position (see computeLiveEta); otherwise it shows the planned ETA from Goodshuffle.

import { getTracking } from "@/lib/db/repo";
import { computeLiveEta, type LiveEta } from "@/lib/eta/liveEta";
import { STATE_VISUAL } from "@/lib/stateVisual";
import type { Stop } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function TrackPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const link = getTracking(token);

  const expired =
    !link ||
    !link.active ||
    (link.expiresAt ? new Date(link.expiresAt) < new Date() : false) ||
    !link.stop;

  // Real ETA from the truck's live location — only while the truck is en route.
  let live: LiveEta | null = null;
  if (!expired && link!.truckId && link!.stop!.state === "EnRoute") {
    live = await computeLiveEta(link!.truckId, link!.stop!);
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-6">
      <div className="text-center">
        <div className="text-sm uppercase tracking-widest text-muted-foreground">
          Zoe Events
        </div>
        <h1 className="mt-1 text-2xl font-bold">Delivery tracking</h1>
      </div>

      {expired ? (
        <div className="rounded-2xl border bg-card p-8 text-center text-muted-foreground">
          This tracking link is no longer active. If you have questions, please reply
          to your text message from our team.
        </div>
      ) : (
        <TrackCard stop={link!.stop!} live={live} />
      )}
    </main>
  );
}

function TrackCard({ stop, live }: { stop: Stop; live: LiveEta | null }) {
  const v = STATE_VISUAL[stop.state];
  const headline =
    stop.state === "Arrived"
      ? "Your delivery team has arrived"
      : stop.state === "Completed"
        ? "Delivery complete — thank you!"
        : stop.state === "EnRoute"
          ? "Your delivery team is on the way"
          : "Delivery scheduled";

  // Prefer the real, live ETA from the truck's location; fall back to the plan.
  const etaText = live?.etaText ?? stop.eta;
  const mapHref = live?.truck
    ? `https://maps.google.com/?q=${live.truck.lat},${live.truck.lng}`
    : null;

  return (
    <div className="space-y-5 rounded-2xl border bg-card p-6">
      <div className="flex items-center gap-3">
        <span className={`flex size-12 items-center justify-center rounded-2xl text-white ${v.dot}`}>
          <v.icon className="size-6" />
        </span>
        <div>
          <div className="text-lg font-semibold">{headline}</div>
          <div className="text-sm text-muted-foreground">{v.label}</div>
        </div>
      </div>

      {live && stop.state === "EnRoute" && (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-center">
          {live.minutesAway > 0 ? (
            <>
              <div className="text-3xl font-bold tracking-tight">{live.minutesAway} min away</div>
              <div className="mt-1 text-sm text-muted-foreground">
                Arriving around <span className="font-semibold text-foreground">{live.etaText}</span>
                {live.distanceMiles != null && ` · ${live.distanceMiles} mi`}
              </div>
            </>
          ) : (
            <>
              <div className="text-3xl font-bold tracking-tight">{live.etaText}</div>
              <div className="mt-1 text-sm text-muted-foreground">Estimated arrival</div>
            </>
          )}
          {mapHref && (
            <a
              href={mapHref}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-block text-sm font-medium underline underline-offset-2"
            >
              See the truck on the map
            </a>
          )}
        </div>
      )}

      <div className="space-y-2 text-sm">
        {stop.custName && <Row label="Delivery to">{stop.custName}</Row>}
        {stop.address && <Row label="Address">{stop.address}</Row>}
        {etaText && stop.state !== "Completed" && !(live && stop.state === "EnRoute") && (
          <Row label="Estimated arrival">
            <span className="font-semibold text-foreground">{etaText}</span>
          </Row>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Questions? Reply to the text message from our team and we&apos;ll help.
      </p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-white/5 py-1.5 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}
