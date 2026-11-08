// Cold email tool connection settings (Instantly or Smartlead), write only for the keys. GET reports the
// active tool, per tool whether a key is set (never its value) and the campaign id, the mailing address used
// in the compliance footer, and whether pushes are ready. POST takes any of
// { provider, apiKey, campaignId, mailingAddress }: `provider` picks the active tool, the key and campaign
// apply to that tool ("__clear__" clears the key), then the campaign is probed so the admin sees at once
// whether it works. Owner/admin only.

import { NextResponse } from "next/server";
import { setSecret, hasSecret } from "@/lib/secrets";
import {
  SEQUENCER_PROVIDERS, activeProvider, setActiveProvider, isSequencerProvider, providerApiKey, providerCampaignId,
  providerSecretNames, validCampaignId, mailingAddress, setMailingAddress, sequencerConfigured, unsupportedProvider,
  probeProvider, PROVIDER_LABEL, type SequencerProvider,
} from "@/lib/prospecting/sequencer";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

function state() {
  const providers = Object.fromEntries(
    SEQUENCER_PROVIDERS.map((p) => [p, { keySet: Boolean(providerApiKey(p)), keyStored: hasSecret(providerSecretNames(p).key), campaignId: providerCampaignId(p) }]),
  ) as Record<SequencerProvider, { keySet: boolean; keyStored: boolean; campaignId: string | null }>;
  return {
    provider: activeProvider(),
    providers,
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
  let body: { provider?: string; apiKey?: string; campaignId?: string; mailingAddress?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (body.provider !== undefined && !isSequencerProvider(body.provider)) return NextResponse.json({ error: "provider must be instantly or smartlead" }, { status: 400 });
  const p: SequencerProvider = isSequencerProvider(body.provider) ? body.provider : activeProvider();
  const names = providerSecretNames(p);

  // Validate everything before writing anything.
  const c = typeof body.campaignId === "string" ? body.campaignId.trim() : null;
  if (c && !validCampaignId(p, c)) {
    const hint = p === "smartlead" ? "the number from the Smartlead campaign URL" : "the long id from the Instantly campaign URL (looks like 1a2b3c4d-...)";
    return NextResponse.json({ error: `campaign id must be ${hint}` }, { status: 400 });
  }
  const m = typeof body.mailingAddress === "string" ? body.mailingAddress.trim() : null;
  if (m !== null && (m.length < 10 || !/\d/.test(m))) return NextResponse.json({ error: "enter a full postal address (street, city, state, ZIP)" }, { status: 400 });

  if (isSequencerProvider(body.provider)) setActiveProvider(p);
  if (body.apiKey === "__clear__") setSecret(names.key, "");
  else if (typeof body.apiKey === "string" && body.apiKey.trim()) setSecret(names.key, body.apiKey.trim());
  if (c !== null) setSecret(names.campaign, c);
  if (m !== null) setMailingAddress(m.slice(0, 200));

  const probe = providerApiKey(p) && providerCampaignId(p) ? await probeProvider(p) : null;
  return NextResponse.json({ ok: true, ...state(), probe, probedProvider: PROVIDER_LABEL[p] });
}
