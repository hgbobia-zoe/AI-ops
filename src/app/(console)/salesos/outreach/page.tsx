// Sales OS — Bulk Review-and-Fire. The whole "Quote Sent" cohort in one table: quote facts, last touch,
// and a refreshed next-step draft (SMS + email) per lead, with per-row/channel include checkboxes. The
// owner selects and approves; approval fires each selection through the EXISTING governed approval path
// (email_send outbox op / held SMS), respecting every comms gate. Owner/admin only — it queues real
// customer-facing comms, the same gate the Approvals page uses. Nothing sends without the approval click.

import { redirect } from "next/navigation";
import { viewerRole, viewerFirstName } from "@/lib/auth/getSession";
import { canManageSettings, canSeeFinancials } from "@/lib/auth/roles";
import { buildBulkOutreachCohort } from "@/lib/salesos/bulkOutreach";
import { BulkOutreachPanel } from "@/components/BulkOutreachPanel";

export const dynamic = "force-dynamic";

export default async function SalesBulkOutreachPage(): Promise<React.JSX.Element> {
  const role = await viewerRole();
  if (!canManageSettings(role)) redirect("/salesos/board");
  const showMoney = canSeeFinancials(role);

  const cohort = await buildBulkOutreachCohort(await viewerFirstName());

  return <BulkOutreachPanel cohort={cohort} showMoney={showMoney} />;
}
