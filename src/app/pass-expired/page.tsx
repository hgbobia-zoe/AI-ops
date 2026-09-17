// Where an invalid / expired / revoked Shift Pass lands. No app chrome, no login prompt — just a calm
// dead-end so a contractor whose shift is over knows the link is done and who to ask for a new one.

import { Clock } from "lucide-react";

export const dynamic = "force-dynamic";

export default function PassExpiredPage(): React.JSX.Element {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center p-6 text-center">
      <div className="surface w-full rounded-2xl border border-white/10 p-8">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full border border-white/10 bg-white/[0.03]">
          <Clock className="size-6 text-muted-foreground" />
        </div>
        <h1 className="text-xl font-semibold">This shift pass has ended</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          The access link you used is expired or has been turned off. If you still need access, ask your
          dispatcher to send you a fresh link.
        </p>
      </div>
    </main>
  );
}
