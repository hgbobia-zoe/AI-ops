// New Creative Job — the definition form. Server shell loads the pickable Zoe images (for the "use
// existing" source mode) and renders the client form. Creating the job composes the Image Brief (the
// Art Director's structured read of the inputs) — it does NOT generate or publish an image; that happens
// afterward on the job detail.

import { Plus } from "lucide-react";
import Link from "next/link";
import { listSelectableImages } from "@/lib/creative/store";
import { NewJobForm } from "@/components/creative/NewJobForm";
import { BladeMain } from "@/components/ui/layouts";
import { PageHeader } from "@/components/ui/page-header";

export const dynamic = "force-dynamic";

export default function NewCreativeJobPage(): React.JSX.Element {
  const images = listSelectableImages();
  return (
    <BladeMain className="max-w-[1100px]">
      <nav className="mb-3 text-[12px] text-meta" aria-label="Breadcrumb">
        <Link href="/creative" className="text-tertiary-text hover:text-foreground">Creative Engine</Link> / New job
      </nav>
      <PageHeader
        title="New creative job"
        icon={<Plus className="size-5" />}
        subtitle="Pick a source, say what you're making, and write the brief. Creating the job composes its Image Brief — no image is generated or published at this step."
      />
      <NewJobForm selectableImages={images} />
    </BladeMain>
  );
}
