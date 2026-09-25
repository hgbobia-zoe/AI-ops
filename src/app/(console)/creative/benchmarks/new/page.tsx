// Provider Benchmarking — create an experiment. The user selects any existing Zoe images as the test set,
// picks the providers (defaults OpenAI + Higgsfield), and freezes the controlled inputs. `?template=v1`
// pre-fills the Zoe Photography Benchmark V1 template.

import Link from "next/link";
import { listSelectableImages } from "@/lib/creative/store";
import { NewExperimentForm } from "@/components/creative/benchmark/NewExperimentForm";

export const dynamic = "force-dynamic";

export default async function NewBenchmarkPage({ searchParams }: { searchParams: Promise<{ template?: string }> }): Promise<React.JSX.Element> {
  const { template } = await searchParams;
  const images = listSelectableImages();

  return (
    <main className="max-w-[1000px] p-6">
      <div className="mb-4 text-[12px] text-meta">
        <Link href="/creative" className="text-tertiary-text hover:text-foreground">Creative Engine</Link> /{" "}
        <Link href="/creative/benchmarks" className="text-tertiary-text hover:text-foreground">Provider Benchmarks</Link> / New
      </div>
      <header className="mb-5">
        <h1 className="text-[22px] font-medium tracking-tight text-foreground">New benchmark experiment</h1>
        <p className="mt-1 max-w-2xl text-[12.5px] text-meta">
          Every provider receives the identical creative input — source image, brief, Visual DNA, preserve/transform, aspect ratio, objective, and prompt version are frozen when you start. Only the provider and model change.
        </p>
      </header>
      <NewExperimentForm selectableImages={images} useTemplate={template === "v1"} />
    </main>
  );
}
