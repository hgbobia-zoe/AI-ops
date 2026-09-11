// Coaching master-detail shell: a persistent call-list sidebar (left) beside the selected call's
// board (right). Full-bleed — no centered column. Owner/admin only. The list data is fetched once
// here and handed to the client shell, which handles selection highlight, filtering, and the mobile
// drawer without a page navigation.

import { redirect } from "next/navigation";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeCoaching } from "@/lib/auth/roles";
import { llmConfigured } from "@/lib/llm";
import { listCoachableCalls, countUnanalyzedCoachableCalls } from "@/lib/db/repo";
import { ourPhoneDigits } from "@/lib/comms/identity";
import { CoachingShell } from "./CoachingShell";

export const dynamic = "force-dynamic";

export default async function CoachingLayout({ children }: { children: React.ReactNode }): Promise<React.JSX.Element> {
  if (!canSeeCoaching(await viewerRole())) redirect("/dashboard");
  const calls = listCoachableCalls(200, ourPhoneDigits());
  const unanalyzed = llmConfigured() ? countUnanalyzedCoachableCalls() : 0;
  return (
    <CoachingShell calls={calls} unanalyzed={unanalyzed}>
      {children}
    </CoachingShell>
  );
}
