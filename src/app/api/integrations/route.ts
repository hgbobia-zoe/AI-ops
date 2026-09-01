// Integrations API — powers the /admin "Integrations" section (switch GPS / phone
// provider + enter credentials). GET returns the provider catalog and a MASKED status
// (secret fields report only whether they're set — never the value). POST saves one
// provider's field values, gated by the admin code.

import { NextResponse } from "next/server";
import { SMS_PROVIDERS, GPS_PROVIDERS, providerCatalog, type ProviderField } from "@/lib/providers";
import { getSecret, setSecret, providerKey } from "@/lib/secrets";

export const dynamic = "force-dynamic";

function adminPin(): string {
  return process.env.ADMIN_PIN || process.env.NEXT_PUBLIC_ADMIN_PIN || "0000";
}

type FieldStatus = { set: boolean } | { value: string };

function statusFor(providerId: string, fields: ProviderField[]): Record<string, FieldStatus> {
  const out: Record<string, FieldStatus> = {};
  for (const f of fields) {
    const v = getSecret(providerKey(providerId, f.key));
    out[f.key] = f.secret ? { set: Boolean(v) } : { value: v ?? "" };
  }
  return out;
}

function allStatus(): Record<string, Record<string, FieldStatus>> {
  const status: Record<string, Record<string, FieldStatus>> = {};
  for (const p of [...SMS_PROVIDERS, ...GPS_PROVIDERS]) status[p.id] = statusFor(p.id, p.fields);
  return status;
}

export function GET(): NextResponse {
  return NextResponse.json({ catalog: providerCatalog(), status: allStatus() });
}

export async function POST(req: Request): Promise<NextResponse> {
  if ((req.headers.get("x-admin-pin") || "") !== adminPin()) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { provider?: string; values?: Record<string, unknown> };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const def = [...SMS_PROVIDERS, ...GPS_PROVIDERS].find((p) => p.id === body.provider);
  if (!def) return NextResponse.json({ error: "unknown provider" }, { status: 400 });

  const values = body.values ?? {};
  for (const f of def.fields) {
    if (!Object.prototype.hasOwnProperty.call(values, f.key)) continue;
    const v = values[f.key];
    if (f.secret) {
      // Secret fields come back blank from the masked form — a blank means "leave as-is"
      // so we don't wipe a stored key. The explicit sentinel "__clear__" clears it.
      if (v === "__clear__") setSecret(providerKey(def.id, f.key), "");
      else if (typeof v === "string" && v.trim()) setSecret(providerKey(def.id, f.key), v);
    } else {
      setSecret(providerKey(def.id, f.key), typeof v === "string" ? v : "");
    }
  }
  return NextResponse.json({ ok: true, status: allStatus() });
}
