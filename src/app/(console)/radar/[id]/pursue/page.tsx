// Pursue workspace page — pre-stage a review-ready bid for one opportunity (capability statement +
// response letter + submission checklist), drawn from the Zoe capability profile. Owner/Admin only:
// bid pursuit is a company-positioning surface, so it's gated like settings. A human reviews + submits.

import { notFound } from "next/navigation";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { getOpportunity } from "@/lib/opportunity/store";
import { PursueWorkspace } from "@/components/PursueWorkspace";

export const dynamic = "force-dynamic";

export default async function PursuePage({ params }: { params: Promise<{ id: string }> }): Promise<React.JSX.Element> {
  const { id } = await params;
  if (!canManageSettings(await viewerRole())) {
    return <main className="max-w-[1000px] p-6 text-[13px] text-meta">You don&apos;t have access to bid pursuit.</main>;
  }
  if (!getOpportunity(id)) notFound();
  return <PursueWorkspace opportunityId={id} />;
}
