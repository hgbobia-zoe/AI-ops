"use client";

// Instawork connection — no cookie to paste anymore. Instawork now syncs from the logged-in office
// browser via the Auto-Pull extension (same model as Goodshuffle): the extension fetches the gig groups
// same-origin inside an app.instawork.com tab and POSTs them to /api/instawork/import. Staying signed into
// Instawork in that browser is all that's needed. This panel just explains that and shows the last-synced
// status (read from GET /api/health's connections rows — never a server-side Instawork call).

import { useEffect, useState } from "react";
import { CheckCircle2, AlertTriangle, CircleDashed } from "lucide-react";

interface ConnRow {
  key: string;
  status: "ok" | "attention" | "off";
  headline: string;
  detail: string;
  lastAt: string | null;
}

function fmt(iso: string | null): string {
  if (!iso) return "never";
  try {
    return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return iso;
  }
}

export function InstaworkCredentialSettings(): React.JSX.Element {
  const [row, setRow] = useState<ConnRow | null | undefined>(undefined);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((d: { connections?: ConnRow[] }) => setRow(d.connections?.find((c) => c.key === "instawork") ?? null))
      .catch(() => setRow(null));
  }, []);

  const Icon = row?.status === "ok" ? CheckCircle2 : row?.status === "attention" ? AlertTriangle : CircleDashed;
  const tone = row?.status === "ok" ? "text-positive" : row?.status === "attention" ? "text-amber-300" : "text-muted-foreground";

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Instawork now syncs straight from the <strong>logged-in office browser</strong> through the Auto-Pull extension,
        the same way Goodshuffle does. There is <strong>no cookie to paste</strong>: just stay signed into Instawork in
        that browser and the extension pulls booked temp-labor shifts on its own, reconciling them against the schedule.
        Reads only; posting a gig stays a manual action.
      </p>

      <div className="flex items-start gap-2 border border-white/10 bg-white/[0.03] px-3 py-2.5 text-sm">
        <Icon className={`mt-0.5 size-4 shrink-0 ${tone}`} />
        <div>
          {row === undefined ? (
            <span className="text-muted-foreground">Checking…</span>
          ) : row ? (
            <>
              <div className="font-medium">{row.headline}</div>
              <p className="mt-0.5 text-muted-foreground">
                {row.detail} Last synced: <b>{fmt(row.lastAt)}</b>.
              </p>
            </>
          ) : (
            <span className="text-muted-foreground">Status unavailable.</span>
          )}
        </div>
      </div>

      <p className="text-[13px] text-muted-foreground">
        Not syncing? Open <b>app.instawork.com</b> in the office browser and make sure you are signed in. The extension
        keeps its own background tab and pulls every few minutes.
      </p>
    </div>
  );
}
