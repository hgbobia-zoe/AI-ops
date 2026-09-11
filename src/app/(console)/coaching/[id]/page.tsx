// Right pane for a specific call — the master-detail list lives in the coaching layout.
import { CoachingBoard } from "../CoachingBoard";

export const dynamic = "force-dynamic";

export default async function CoachingDetailPage({ params }: { params: Promise<{ id: string }> }): Promise<React.JSX.Element> {
  const { id } = await params;
  return <CoachingBoard id={id} />;
}
