// Provider Benchmarking — experiment detail. Server loads the full detail bundle; the client component drives
// start / polling / blinded human evaluation / comparison / export. For a draft it previews the frozen test set.

import Link from "next/link";
import { notFound } from "next/navigation";
import { buildDetail } from "@/lib/creative/experimentService";
import { getImage } from "@/lib/creative/store";
import { ExperimentDetail } from "@/components/creative/benchmark/ExperimentDetail";
import type { CreativeImage } from "@/lib/creative/types";

export const dynamic = "force-dynamic";

export default async function BenchmarkDetailPage({ params }: { params: Promise<{ id: string }> }): Promise<React.JSX.Element> {
  const { id } = await params;
  const detail = buildDetail(id);
  if (!detail) notFound();

  // For a DRAFT (no cases yet), preview the frozen source set from the library.
  const sourcePreview: Record<string, Pick<CreativeImage, "id" | "path" | "name">> = {};
  if (detail.cases.length === 0) {
    for (const sid of detail.experiment.frozen.sourceImageIds) {
      const img = getImage(sid);
      if (img) sourcePreview[sid] = { id: img.id, path: img.path, name: img.name };
    }
  }

  return (
    <main className="max-w-[1280px] p-6">
      <div className="mb-4 text-[12px] text-meta">
        <Link href="/creative" className="text-tertiary-text hover:text-foreground">Creative Engine</Link> /{" "}
        <Link href="/creative/benchmarks" className="text-tertiary-text hover:text-foreground">Provider Benchmarks</Link> /{" "}
        <span className="text-tertiary-text">{detail.experiment.name}</span>
      </div>
      <ExperimentDetail initialDetail={detail} sourcePreview={sourcePreview} />
    </main>
  );
}
