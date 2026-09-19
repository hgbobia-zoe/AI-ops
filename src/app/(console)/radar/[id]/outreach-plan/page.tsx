// Guided Outreach Plan page — a coached, step-by-step way to actually reach out on one radar
// recommendation. Open to all staff (the point is to help people who aren't natural at cold outreach).

import { notFound } from "next/navigation";
import { getOpportunity } from "@/lib/opportunity/store";
import { OutreachPlanView } from "@/components/OutreachPlanView";

export const dynamic = "force-dynamic";

export default async function OutreachPlanPage({ params }: { params: Promise<{ id: string }> }): Promise<React.JSX.Element> {
  const { id } = await params;
  if (!getOpportunity(id)) notFound();
  return <OutreachPlanView opportunityId={id} />;
}
