// The Quo (OpenPhone) users, for the "Send as" picker on outreach. Lets a rep attribute a text they
// send from Sales OS to themselves — so Quo records it correctly AND the Goodshuffle note gets their
// initials. Authenticated app users (session-gated by the proxy).

import { NextResponse } from "next/server";
import { getOpenphoneUsers } from "@/lib/comms/openphone";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const users = (await getOpenphoneUsers()).map((u) => ({ id: u.id, initials: u.initials, name: u.name }));
  return NextResponse.json({ users });
}
