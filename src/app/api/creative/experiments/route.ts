// Provider Benchmarking — list + create experiments. Staff-only (the proxy denies guests on /api/*). Creating
// an experiment stores a DRAFT with FROZEN-on-start inputs; the matrix is built when it is started.

import { NextResponse } from "next/server";
import { listExperiments, createExperiment, type CreateExperimentInput } from "@/lib/creative/experimentStore";
import { currentActor } from "@/lib/auth/getSession";
import {
  isAssetType,
  isAspectRatio,
  defaultPreserve,
  defaultTransform,
  type AssetType,
  type AspectRatio,
} from "@/lib/creative/types";
import { blindLabelFor, type ExperimentPhase } from "@/lib/creative/experimentTypes";

export const dynamic = "force-dynamic";

interface ProviderInput {
  providerId?: string;
  providerName?: string;
  model?: string | null;
  enabled?: boolean;
}
interface Body {
  name?: string;
  description?: string | null;
  phase?: number;
  assetType?: string;
  sourceImageIds?: string[];
  briefId?: string | null;
  aspectRatio?: string;
  preserve?: string[];
  transform?: string[];
  targetAudience?: string | null;
  objective?: string | null;
  targetGenerationsPerProvider?: number;
  blinding?: boolean;
  autoQa?: boolean;
  humanEval?: boolean;
  costTracking?: boolean;
  providers?: ProviderInput[];
}

export function GET(): NextResponse {
  return NextResponse.json({ experiments: listExperiments() });
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.name || !body.name.trim()) return NextResponse.json({ error: "name_required" }, { status: 400 });

  const sourceImageIds = Array.isArray(body.sourceImageIds) ? body.sourceImageIds.filter((x): x is string => typeof x === "string") : [];
  if (sourceImageIds.length === 0) return NextResponse.json({ error: "sources_required" }, { status: 400 });

  const providersRaw = Array.isArray(body.providers) ? body.providers : [];
  const providers = providersRaw
    .filter((p) => p && typeof p.providerId === "string" && p.providerId.trim() && typeof p.providerName === "string" && p.providerName.trim())
    .map((p, i) => ({
      providerId: p.providerId!.trim(),
      providerName: p.providerName!.trim(),
      model: (p.model ?? "").toString().trim() || null,
      enabled: p.enabled !== false,
      blindLabel: blindLabelFor(i), // A / B / C … assigned deterministically for blinding
    }));
  if (providers.length < 1) return NextResponse.json({ error: "providers_required" }, { status: 400 });

  const assetType: AssetType = isAssetType(body.assetType) ? body.assetType : "lifestyle";
  const aspectRatio: AspectRatio = isAspectRatio(body.aspectRatio) ? body.aspectRatio : "3:2";
  // Freeze explicit PRESERVE / TRANSFORM — default from the asset type + reference-first mode when unset, so
  // the experiment always carries concrete frozen values (never silently drifting).
  const preserve = Array.isArray(body.preserve) && body.preserve.length ? body.preserve.filter((x): x is string => typeof x === "string") : defaultPreserve("existing", assetType);
  const transform = Array.isArray(body.transform) && body.transform.length ? body.transform.filter((x): x is string => typeof x === "string") : defaultTransform(assetType);
  const phase = (body.phase === 2 || body.phase === 3 ? body.phase : 1) as ExperimentPhase;

  const input: CreateExperimentInput = {
    name: body.name,
    description: body.description ?? null,
    phase,
    assetType,
    sourceImageIds,
    briefId: body.briefId ?? null,
    aspectRatio,
    preserve,
    transform,
    targetAudience: body.targetAudience ?? null,
    objective: body.objective ?? null,
    // Phase 1 = one generation per provider (measure first-attempt performance) — never auto-multi in Phase 1.
    targetGenerationsPerProvider: phase === 1 ? 1 : Math.max(1, Math.floor(body.targetGenerationsPerProvider ?? 1)),
    blinding: body.blinding !== false,
    autoQa: body.autoQa !== false,
    humanEval: body.humanEval !== false,
    costTracking: body.costTracking !== false,
    providers,
  };
  const actor = (await currentActor()).label;
  const created = createExperiment(input, actor);
  return NextResponse.json({ ok: true, experiment: created });
}
