// Opportunity Radar — SAM.gov connector (federal solicitations). Acquisition method: API.
//
// DORMANT until SAM_API_KEY is set: with no key acquire() returns [] and the source shows
// auth_status=REQUIRED_MISSING. Never throws. Free personal key from sam.gov → Account Details → API
// Key. Docs: https://open.gsa.gov/api/get-opportunities-public-api/ (GET /opportunities/v2/search).
//
// Only interpretation-free deterministic mapping happens here; we keep just event-relevant DMV notices.

import { isEventRelevant } from "../classify";
import type { OpportunitySource, RawOpportunity } from "../ingest";
import type { EntityKind, RelationshipRole } from "../types";

const DMV_STATES = new Set(["MD", "DC", "VA"]);

// SAM notice type → our noticeType vocabulary.
function mapNoticeType(t: string | undefined): string {
  const s = (t ?? "").toLowerCase();
  if (s.includes("sources sought")) return "SOURCES_SOUGHT";
  if (s.includes("presolicitation")) return "PRESOLICITATION";
  if (s.includes("combined") || s.includes("solicitation")) return "RFP";
  if (s.includes("award")) return "AWARD";
  if (s.includes("special notice")) return "RFI";
  return "OTHER";
}

function toYmd(v: string | undefined): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

interface SamNotice {
  noticeId?: string;
  title?: string;
  solicitationNumber?: string;
  fullParentPathName?: string;
  type?: string;
  postedDate?: string;
  responseDeadLine?: string;
  naicsCode?: string;
  classificationCode?: string;
  typeOfSetAside?: string;
  uiLink?: string;
  description?: string;
  awardee?: { name?: string };
  award?: { awardee?: { name?: string }; amount?: string };
  placeOfPerformance?: { city?: { name?: string }; state?: { code?: string } };
}

function mapNotice(n: SamNotice): RawOpportunity | null {
  const state = n.placeOfPerformance?.state?.code;
  if (state && !DMV_STATES.has(state)) return null; // outside the DMV footprint
  const text = `${n.title ?? ""} ${n.description ?? ""}`;
  if (!isEventRelevant(text)) return null; // deterministic relevance gate

  const agency = n.fullParentPathName?.split(".")[0]?.trim() || n.fullParentPathName || "Federal agency";
  const awardeeName = n.award?.awardee?.name || n.awardee?.name;
  const entities: { name: string; kind: EntityKind; role?: RelationshipRole }[] = [{ name: agency, kind: "AGENCY", role: "DIRECT_BUYER" }];
  if (awardeeName) entities.push({ name: awardeeName, kind: "PRIME", role: "PRIME_CONTRACTOR" });

  return {
    externalId: n.noticeId,
    kind: "PROCUREMENT",
    name: n.title ?? "(untitled solicitation)",
    description: n.description,
    sourceUrl: n.uiLink,
    agency,
    city: n.placeOfPerformance?.city?.name,
    state,
    deadline: toYmd(n.responseDeadLine),
    status: awardeeName ? "awarded" : "open",
    verificationStatus: "VERIFIED", // straight from the federal system of record
    entities,
    procurement: {
      solicitationNumber: n.solicitationNumber,
      noticeType: mapNoticeType(n.type),
      naics: n.naicsCode,
      psc: n.classificationCode,
      setAside: n.typeOfSetAside,
      postedDate: toYmd(n.postedDate) ?? undefined,
      responseDeadline: toYmd(n.responseDeadLine) ?? undefined,
      awardAmount: n.award?.amount ? Number(n.award.amount) || undefined : undefined,
      awardee: awardeeName,
    },
  };
}

export function samGovConfigured(): boolean {
  return Boolean(process.env.SAM_API_KEY);
}

/** The SAM.gov source. Dormant (acquire → []) until SAM_API_KEY is set. Never throws. */
export function samGovSource(opts: { lookbackDays?: number; keyword?: string } = {}): OpportunitySource {
  return {
    id: "samgov-federal",
    name: "SAM.gov — federal solicitations",
    kind: "FEDERAL_API",
    acquisitionMethod: "API",
    adapter: "samgov",
    async acquire(): Promise<RawOpportunity[]> {
      const key = process.env.SAM_API_KEY;
      if (!key) return []; // dormant
      try {
        const lookback = opts.lookbackDays ?? 90;
        const fmt = (d: Date) => `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
        const to = new Date();
        const from = new Date(Date.now() - lookback * 86_400_000);
        const params = new URLSearchParams({
          api_key: key,
          postedFrom: fmt(from),
          postedTo: fmt(to),
          limit: "100",
          q: opts.keyword ?? "event rental tent tables chairs conference",
        });
        const res = await fetch(`https://api.sam.gov/opportunities/v2/search?${params.toString()}`, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) return [];
        const data = (await res.json().catch(() => ({}))) as { opportunitiesData?: SamNotice[] };
        return (data.opportunitiesData ?? []).map(mapNotice).filter((x): x is RawOpportunity => x !== null);
      } catch {
        return []; // never throws — a dead feed must not break a pull
      }
    },
  };
}
