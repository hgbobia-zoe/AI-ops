import { STATE_VISUAL } from "@/lib/stateVisual";
import type { StopState } from "@/lib/types";

export function StateBadge({
  state,
  className = "",
}: {
  state: StopState;
  className?: string;
}) {
  const v = STATE_VISUAL[state];
  const Icon = v.icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${v.badge} ${className}`}
    >
      <Icon className="size-3.5" />
      {v.label}
    </span>
  );
}
