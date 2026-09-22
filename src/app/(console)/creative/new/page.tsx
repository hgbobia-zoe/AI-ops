// New Creative Job — the definition form. Server shell loads the pickable Zoe images (for the "use
// existing" source mode) and renders the client form. Creating the job runs the Art Director to produce
// the Image Brief before the user lands on the detail.

import { Plus } from "lucide-react";
import Link from "next/link";
import { listSelectableImages } from "@/lib/creative/store";
import { NewJobForm } from "@/components/creative/NewJobForm";

export const dynamic = "force-dynamic";

export default function NewCreativeJobPage(): React.JSX.Element {
  const images = listSelectableImages();
  return (
    <main className="max-w-[900px] p-6">
      <div className="mb-4 text-[12px] text-meta">
        <Link href="/creative" className="text-tertiary-text hover:text-foreground">Creative Engine</Link> / New Job
      </div>
      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-[22px] font-medium tracking-tight">
          <Plus className="size-5 text-meta" /> New creative job
        </h1>
        <p className="mt-1 text-[12.5px] text-meta">
          Define WHAT to create. The system determines HOW, for consistency. This is not a prompt box: your inputs feed the Art Director.
        </p>
      </header>
      <NewJobForm selectableImages={images} />
    </main>
  );
}
