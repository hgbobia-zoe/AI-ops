// Right pane at /coaching — the most recent call's board by default, so the details open next to the
// list with no extra click. The list itself is the persistent sidebar in layout.tsx.
import { CoachingBoard } from "./CoachingBoard";
import { listCoachableCalls } from "@/lib/db/repo";
import { ourPhoneDigits } from "@/lib/comms/identity";

export const dynamic = "force-dynamic";

export default async function CoachingIndexPage(): Promise<React.JSX.Element> {
  const newest = listCoachableCalls(1, ourPhoneDigits())[0];
  if (!newest) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        No calls with transcripts yet — they arrive from OpenPhone / Quo once a call is completed.
      </div>
    );
  }
  return <CoachingBoard id={newest.id} />;
}
