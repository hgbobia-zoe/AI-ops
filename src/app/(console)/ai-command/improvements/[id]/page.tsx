// AI Command Center → Improvements → one run. The full, honest story of a single improvement attempt
// (audit gate 11): its scope, budget use, plan, artifacts, deployment + health, and the complete lifecycle
// trail — so an operator understands what happened without reading raw logs. Owner/admin get controls.

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { viewerRole } from "@/lib/auth/getSession";
import { canViewAi, canManageAi } from "@/lib/auth/roles";
import { getRun, listRunEvents } from "@/lib/ai/improvement/store";
import { ImprovementRunDetail } from "@/components/aiorg/ImprovementRunDetail";

export const dynamic = "force-dynamic";

export default async function ImprovementRunPage({ params }: { params: Promise<{ id: string }> }): Promise<React.JSX.Element> {
  const role = await viewerRole();
  if (!canViewAi(role)) redirect("/dashboard");
  const { id } = await params;
  const run = getRun(id);
  if (!run) notFound();
  const events = listRunEvents(id);

  return (
    <main className="mx-auto max-w-[1000px] p-4 pb-16 md:p-5">
      <Link href="/ai-command/improvements" className="mb-3 inline-flex items-center gap-1 text-[12px] text-meta transition-colors hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Improvements
      </Link>
      <ImprovementRunDetail run={run} events={events} canManage={canManageAi(role)} />
    </main>
  );
}
