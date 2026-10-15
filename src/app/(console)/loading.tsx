// Automatic Suspense boundary for EVERY console blade. The moment a blade is navigated
// to, Next renders this instantly (the shell from layout.tsx stays visible) while the
// server component streams in — so the page never looks frozen. Individual segments may
// override this with their own loading.tsx (e.g. dispatch, scheduling) for a tailored
// skeleton; this is the shared baseline for all the rest.

import { BladeLoading } from "@/components/BladeLoading";

export default function ConsoleLoading() {
  return <BladeLoading />;
}
