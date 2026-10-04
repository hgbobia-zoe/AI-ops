// Staffing has been MERGED into Scheduling (one blade). This route is kept as a thin permanent redirect
// so existing bookmarks, nav entries and Slack deep-links do not 404 — it forwards to /scheduling,
// preserving the ?date. The roster + open-shift views now live inside /scheduling behind a disclosure.

import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function StaffingPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}): Promise<never> {
  const sp = await searchParams;
  const date = sp?.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : null;
  redirect(date ? `/scheduling?date=${date}` : "/scheduling");
}
