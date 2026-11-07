// Smartlead connection settings, write only for the key. GET reports whether the key is set (never its
// value), the campaign id, the mailing address used in the compliance footer, and whether it is ready.
// POST stores any of { apiKey, campaignId, mailingAddress } ("__clear__" clears the key) and probes the
// campaign so the admin sees at once whether it works. Owner/admin only.

import { NextResponse } from "next/server";
import { setSecret, hasSecret } from "@/lib/secrets";
import {
  SMARTLEAD_KEY_SECRET, SMARTLEAD_CAMPAIGN_SECRET, smartleadCampaignId, smartleadKey, mailingAddress, setMailingAddress,
  sequencerConfigured, unsupportedProvider, probeSmartlead,
} from "@/lib/prospecting/sequencer";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

function state() {
  return {
    keySet: Boolean(smartleadKey()),
    keyStored: hasSecret(SMARTLEAD_KEY_SECRET),
    campaignId: smartleadCampaignId(),
    mailingAddress: mailingAddress(),
    connected: sequencerConfigured(),
    unsupportedProvider: unsupportedProvider(),
  };
}

export async function GET(): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ ok: true, ...state() });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { apiKey?: string; campaignId?: string; mailingAddress?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (body.apiKey === "__clear__") setSecret(SMARTLEAD_KEY_SECRET, "");
  else if (typeof body.apiKey === "string" && body.apiKey.trim()) setSecret(SMARTLEAD_KEY_SECRET, body.apiKey.trim());

  if (typeof body.campaignId === "string") {
    const c = body.campaignId.trim();
    if (c && !/^\d+$/.test(c)) return NextResponse.json({ error: "campaign id must be the number from the Smartlead campaign URL" }, { status: 400 });
    setSecret(SMARTLEAD_CAMPAIGN_SECRET, c);
  }
  if (typeof body.mailingAddress === "string") {
    const m = body.mailingAddress.trim();
    if (m.length < 10 || !/\d/.test(m)) return NextResponse.json({ error: "enter a full postal address (street, city, state, ZIP)" }, { status: 400 });
    setMailingAddress(m.slice(0, 200));
  }
  const probe = smartleadKey() && smartleadCampaignId() ? await probeSmartlead() : null;
  return NextResponse.json({ ok: true, ...state(), probe });
}
