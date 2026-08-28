// Public customer tracking page — the code replacement for a Zonar tracking link.
// Shows the delivery status + ETA for a stop by opaque token. No auth (the token
// is the capability). Live GPS can be layered in later via Zonar; ETA works today.

import { getTracking } from "@/lib/db/repo";
import { STATE_VISUAL } from "@/lib/stateVisual";

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
        <TrackCard stop={link!.stop!} />
      )}
    </main>
  );
}

function TrackCard({
  stop,
}: {
  stop: NonNullable<ReturnType<typeof getTracking>>["stop"] & object;
}) {
  const v = STATE_VISUAL[stop.state];
  const headline =
    stop.state === "Arrived"
      ? "Your delivery team has arrived"
      : stop.state === "Completed"
        ? "Delivery complete — thank you!"
        : stop.state === "EnRoute"
          ? "Your delivery team is on the way"
          : "Delivery scheduled";

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

      <div className="space-y-2 text-sm">
        {stop.custName && (
          <Row label="Delivery to">{stop.custName}</Row>
        )}
        {stop.address && <Row label="Address">{stop.address}</Row>}
        {stop.eta && stop.state !== "Completed" && (
          <Row label="Estimated arrival">
            <span className="font-semibold text-foreground">{stop.eta}</span>
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
