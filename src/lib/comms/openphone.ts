// OpenPhone ("Quo") integration helpers for the inbound webhook: credential resolution, webhook
// signature verification, and on-demand transcript/summary fetch. All key-gated, never throws.
//
// Config resolution mirrors the SMS provider: stored admin secrets first (openphone.apiKey /
// openphone.signingKey), then env fallbacks (OPENPHONE_API_KEY / OPENPHONE_WEBHOOK_SECRET).

import { createHmac, timingSafeEqual } from "node:crypto";
import { getProviderConfig } from "@/lib/secrets";
import { initialsOf } from "@/lib/salesos/noteFormat";

export function openphoneApiKey(): string | null {
  return getProviderConfig("openphone", ["apiKey"]).apiKey ?? process.env.OPENPHONE_API_KEY ?? null;
}

export function openphoneSigningKey(): string | null {
  return getProviderConfig("openphone", ["signingKey"]).signingKey ?? process.env.OPENPHONE_WEBHOOK_SECRET ?? null;
}

export interface VerifyResult {
  configured: boolean; // is a signing key set at all?
  verified: boolean; // did the signature match?
}

/** Verify an OpenPhone webhook signature. Header format: `hmac;<version>;<timestamp>;<base64 sig>`,
 *  signed data = `<timestamp>.<rawBody>`, key is base64-encoded. When no signing key is configured we
 *  report {configured:false} so the caller can accept during setup and enforce once it's set. */
export function verifyOpenphoneSignature(rawBody: string, signatureHeader: string | null): VerifyResult {
  const key = openphoneSigningKey();
  if (!key) return { configured: false, verified: false };
  if (!signatureHeader) return { configured: true, verified: false };

  try {
    const parts = signatureHeader.split(";");
    const provided = parts[parts.length - 1]?.trim();
    const timestamp = parts.length >= 4 ? parts[2]?.trim() : "";
    if (!provided) return { configured: true, verified: false };

    const signedData = timestamp ? `${timestamp}.${rawBody}` : rawBody;
    const keyBuf = Buffer.from(key, "base64");
    const digest = createHmac("sha256", keyBuf.length ? keyBuf : Buffer.from(key)).update(signedData).digest("base64");

    const a = Buffer.from(digest);
    const b = Buffer.from(provided);
    const verified = a.length === b.length && timingSafeEqual(a, b);
    return { configured: true, verified };
  } catch {
    return { configured: true, verified: false };
  }
}

async function opGet(path: string, apiKey: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`https://api.openphone.com/v1${path}`, { headers: { authorization: apiKey } });
    if (!res.ok) return null;
    return (await res.json().catch(() => null)) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

/** Fetch a call's transcript text (dialogue joined) when available, else null. */
export async function getCallTranscript(callId: string): Promise<string | null> {
  const apiKey = openphoneApiKey();
  if (!apiKey || !callId) return null;
  const json = await opGet(`/call-transcripts/${encodeURIComponent(callId)}`, apiKey);
  const data = (json?.data as { dialogue?: { content?: string; identifier?: string }[]; status?: string }) ?? null;
  const dialogue = data?.dialogue;
  if (!Array.isArray(dialogue) || dialogue.length === 0) return null;
  return dialogue
    .map((d) => (d.identifier ? `${d.identifier}: ${d.content ?? ""}` : d.content ?? ""))
    .join("\n")
    .trim() || null;
}

/** Fetch a call's AI summary text when available, else null. */
export async function getCallSummary(callId: string): Promise<string | null> {
  const apiKey = openphoneApiKey();
  if (!apiKey || !callId) return null;
  const json = await opGet(`/call-summaries/${encodeURIComponent(callId)}`, apiKey);
  const data = (json?.data as { summary?: string[] | string; nextSteps?: string[] }) ?? null;
  if (!data) return null;
  const summary = Array.isArray(data.summary) ? data.summary.join(" ") : data.summary ?? "";
  return summary.trim() || null;
}

// ── Quo users → initials. Quo knows who made a call / sends a text; we map the user id to initials
// for the Goodshuffle note tag. Cached (users change rarely) so we don't refetch on every event.

export interface QuoUser {
  id: string;
  name: string;
  initials: string; // may be "" if a name can't form initials
}

let usersCache: { at: number; users: QuoUser[] } | null = null;
const USERS_TTL_MS = 10 * 60 * 1000;

/** The workspace's OpenPhone users (Lisa, Jessie, …). Cached for 10 min; [] when not configured. */
export async function getOpenphoneUsers(): Promise<QuoUser[]> {
  if (usersCache && Date.now() - usersCache.at < USERS_TTL_MS) return usersCache.users;
  const apiKey = openphoneApiKey();
  if (!apiKey) return usersCache?.users ?? [];
  const json = await opGet("/users", apiKey);
  const data = (json?.data as { id?: string; firstName?: string; lastName?: string }[]) ?? [];
  const users = data
    .filter((u) => u.id)
    .map((u) => {
      const name = [u.firstName, u.lastName].filter(Boolean).join(" ");
      return { id: String(u.id), name, initials: initialsOf(name) ?? "" };
    });
  if (users.length) usersCache = { at: Date.now(), users };
  return usersCache?.users ?? users;
}

/** Initials for a Quo user id (e.g. the rep who handled a call), or null when unknown. */
export async function openphoneUserInitials(userId?: string | null): Promise<string | null> {
  if (!userId) return null;
  const u = (await getOpenphoneUsers()).find((x) => x.id === userId);
  return u && u.initials ? u.initials : null;
}
