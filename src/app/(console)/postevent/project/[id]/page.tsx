// Post-Event project detail — the reconstructed journey + the human actions on one project.

import { PostEventDetail } from "@/components/postevent/PostEventDetail";

export const dynamic = "force-dynamic";

export default async function PostEventProjectPage({ params }: { params: Promise<{ id: string }> }): Promise<React.JSX.Element> {
  const { id } = await params;
  return <PostEventDetail id={id} />;
}
