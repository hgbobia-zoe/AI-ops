// AI Command Center → Requests. The in-app backlog of asks captured from AI sessions: product/feature
// ideas, questions, and operational tasks, each tracked through its lifecycle. Any signed staff may view;
// owner/admin may triage and close. The responder files requests and attaches implementation PRs; a human
// merge of the PR is the approval. Reads are server-side (force-dynamic) — no fabrication.

import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, Inbox } from "lucide-react";
import { viewerRole } from "@/lib/auth/getSession";
import { canViewAi, canManageAi } from "@/lib/auth/roles";
import { listRequests, countRequestsByStatus } from "@/lib/ai/requests";
import { RequestsBoard } from "@/components/aiorg/RequestsBoard";

export const dynamic = "force-dynamic";

export default async function AiRequestsPage(): Promise<React.JSX.Element> {
  const role = await viewerRole();
  if (!canViewAi(role)) redirect("/dashboard");

  const requests = listRequests({ limit: 500 });
  const counts = countRequestsByStatus();

  return (
    <main className="mx-auto max-w-[1100px] p-4 pb-16 md:p-5">
      <Link href="/ai-command" className="mb-3 inline-flex items-center gap-1 text-[12px] text-meta transition-colors hover:text-foreground">
        <ArrowLeft className="size-3.5" /> AI Command Center
      </Link>
      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight">
          <Inbox className="size-5 text-meta" /> Requests
        </h1>
        <p className="text-[12.5px] text-meta">
          Asks captured from AI sessions — product ideas, questions, and tasks — tracked here so nothing is lost. A feature request can graduate to an implementation PR; your merge is the approval.
        </p>
      </header>

      <RequestsBoard requests={requests} counts={counts} canManage={canManageAi(role)} />
    </main>
  );
}
