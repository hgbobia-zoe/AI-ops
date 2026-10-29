// Creative job lifecycle status — rendered through the SHARED Nocturne status model (StatusBadge): a
// coloured, distinct-shape INDICATOR icon + a crisp label on the neutral surface (colour on the icon,
// never the label). Migrated off the old pastel pill so every blade reads "blocked"/"ready" identically.
// Server-component safe.

import {
  FileEdit, Clock3, ScanSearch, RotateCcw, Eye, BadgeCheck, type LucideIcon,
} from "lucide-react";
import { StatusBadge, STATUS_ICON } from "@/components/ui/status";
import { JOB_STATUS_LABEL, type JobStatus } from "@/lib/creative/types";
import { JOB_STATUS_TONE } from "@/lib/creative/jobView";

// Distinct per-status icons where the tone's default icon would blur two states that share a tone
// (e.g. queued vs generating vs qa are all "info"). Falls back to the shared tone icon otherwise.
const STATUS_ICON_OVERRIDE: Partial<Record<JobStatus, LucideIcon>> = {
  draft: FileEdit,
  queued: Clock3,
  qa: ScanSearch,
  needs_revision: RotateCcw,
  awaiting_approval: Eye,
  published: BadgeCheck,
};

export function StatusPill({
  status,
  size = "sm",
  className = "",
}: {
  status: JobStatus;
  size?: "sm" | "md";
  className?: string;
}): React.JSX.Element {
  const tone = JOB_STATUS_TONE[status];
  const icon = STATUS_ICON_OVERRIDE[status] ?? STATUS_ICON[tone];
  return (
    <StatusBadge tone={tone} icon={icon} size={size} animated={status === "generating"} className={className}>
      {JOB_STATUS_LABEL[status]}
    </StatusBadge>
  );
}
