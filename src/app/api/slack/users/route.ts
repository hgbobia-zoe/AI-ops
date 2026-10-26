// Slack workspace user list — read-only directory for the /admin "Slack approvers" picker. Owner/admin only
// (gated in proxy.ts via isSettings → /api/slack/users). Returns id + display/real name for each non-bot
// member so an operator can add an approver by name; `configured` tells the UI whether the Slack bot token
// is present (false → the picker shows the manual member-id fallback). No secrets are returned.

import { NextResponse } from "next/server";
import { listWorkspaceUsers } from "@/lib/slack/users";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const users = await listWorkspaceUsers();
  return NextResponse.json({ users, configured: !!process.env.SLACK_BOT_TOKEN });
}
