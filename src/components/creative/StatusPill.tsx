// Small state pill for a creative job's lifecycle status (matches the app's pill styling). Pure/client-safe.

import { JOB_STATUS_LABEL, JOB_STATUS_PILL, type JobStatus } from "@/lib/creative/types";

export function StatusPill({ status, className = "" }: { status: JobStatus; className?: string }): React.JSX.Element {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-medium ${JOB_STATUS_PILL[status]} ${className}`}>
      {JOB_STATUS_LABEL[status]}
    </span>
  );
}
