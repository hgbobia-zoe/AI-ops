// Post-Event Kanban — the workflow board. Every move writes a structured state transition.

import { PostEventBoard } from "@/components/postevent/PostEventBoard";

export const dynamic = "force-dynamic";

export default function PostEventKanbanPage(): React.JSX.Element {
  return <PostEventBoard />;
}
