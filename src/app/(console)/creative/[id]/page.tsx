// Job detail — the lifecycle cockpit for one asset. Server loads the job, its generations, and the
// attributed event log; the client component drives generate / QC / review actions. The lifecycle position,
// the leading preview, the stored Image Brief (WHY this image), every QA evaluation, source provenance and
// the full history are all visible here, in that hierarchy.

import Link from "next/link";
import { notFound } from "next/navigation";
import { getJob, listGenerations, listEvents, getImage } from "@/lib/creative/store";
import { BladeMain } from "@/components/ui/layouts";
import { JobDetail } from "@/components/creative/JobDetail";

export const dynamic = "force-dynamic";

export default async function CreativeJobDetailPage({ params }: { params: Promise<{ id: string }> }): Promise<React.JSX.Element> {
  const { id } = await params;
  const job = getJob(id);
  if (!job) notFound();
  const generations = listGenerations(id);
  const events = listEvents(id);
  const sourceImage = job.sourceImageId ? getImage(job.sourceImageId) : null;

  return (
    <BladeMain className="max-w-[1120px]">
      <div className="mb-4 text-[12px] text-meta">
        <Link href="/creative" className="text-tertiary-text hover:text-foreground">Creative jobs</Link> / <span className="text-tertiary-text">{job.title}</span>
      </div>
      <JobDetail
        initialJob={job}
        initialGenerations={generations}
        initialEvents={events}
        sourceImagePath={sourceImage?.path ?? null}
      />
    </BladeMain>
  );
}
