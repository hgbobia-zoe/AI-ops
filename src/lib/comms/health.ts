// Integration health for the Communications blade — OBSERVABLE status, never aspirational. Quo/OpenPhone
// is CONNECTED (it already ingests real calls + SMS) and we show its real last-event time from
// call_events. Sona (the AI voice agent) is NOT CONNECTED — we never pretend it exists. The Context API
// is this engine (Available), and the Communications webhook is built but its Quo→Sona payload schema
// isn't finalized. Honest states only.

import { getRecentCallEvents } from "@/lib/db/repo";
import { openphoneApiKey } from "./openphone";
import { getRecentCommsLog, getRecentSmsEvents } from "./store";

export type IntegrationState = "CONNECTED" | "NOT_CONNECTED" | "AVAILABLE" | "BUILT" | "DEGRADED";

export interface IntegrationStatus {
  key: string;
  name: string;
  role: string; // what it owns in the architecture
  state: IntegrationState;
  detail: string;
  lastEventAt: string | null;
}

export function getCommsHealth(): IntegrationStatus[] {
  const recentCalls = getRecentCallEvents(1);
  const lastCallAt = recentCalls[0]?.occurredAt ?? recentCalls[0]?.ts ?? null;
  const recentSms = getRecentSmsEvents(1);
  const lastSmsAt = recentSms[0]?.occurredAt ?? recentSms[0]?.ts ?? null;
  const lastQuoAt = [lastCallAt, lastSmsAt].filter(Boolean).sort().reverse()[0] ?? null;
  const keyed = Boolean(openphoneApiKey());
  const lastLog = getRecentCommsLog(1)[0]?.ts ?? null;

  return [
    {
      key: "quo",
      name: "Quo (OpenPhone)",
      role: "Telephony — owns calls & SMS",
      state: keyed || lastQuoAt ? "CONNECTED" : "NOT_CONNECTED",
      detail: keyed
        ? "Live call + SMS ingestion via the OpenPhone webhook."
        : lastQuoAt
          ? "Ingesting events; API key not detected in this environment."
          : "No API key and no events yet.",
      lastEventAt: lastQuoAt,
    },
    {
      key: "sona",
      name: "Sona (AI voice agent)",
      role: "Conversation — would answer/talk",
      state: "NOT_CONNECTED",
      detail: "No voice-agent integration is connected. The Context Pack + tool registry are ready for when it is.",
      lastEventAt: null,
    },
    {
      key: "context",
      name: "Context API",
      role: "The Tower's trusted intermediary",
      state: "AVAILABLE",
      detail: "Identity resolution + Context Pack assembly over verified data. Read-only tools live.",
      lastEventAt: null,
    },
    {
      key: "webhook",
      name: "Communications webhook",
      role: "Adapter ingress — POST /api/communications/events",
      state: "BUILT",
      detail: "Adapter maps any provider payload to a canonical event. Quo→Sona schema is not finalized, so it is not yet the primary ingress.",
      lastEventAt: lastLog,
    },
  ];
}
