// Shared visual language for stop states and actions — one place so the badge,
// the route timeline, and the current-stop card never drift apart.

import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock,
  Fuel,
  Home,
  MapPin,
  MessageSquare,
  PackageOpen,
  Play,
  RotateCcw,
  Truck,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import type { ActionType, StopState } from "./types";

export interface StateVisual {
  label: string;
  icon: LucideIcon;
  /** Solid dot / accent color. */
  dot: string;
  /** Soft badge background + text. */
  badge: string;
}

// Monochrome: states are distinguished by icon + grayscale intensity (brighter =
// further along). Exception keeps a single functional red — the danger signal.
export const STATE_VISUAL: Record<StopState, StateVisual> = {
  Waiting: {
    label: "Waiting",
    icon: Clock,
    dot: "bg-white/10",
    badge: "bg-white/5 text-muted-foreground",
  },
  EnRoute: {
    label: "En Route",
    icon: Truck,
    dot: "bg-white/20",
    badge: "bg-white/10 text-foreground",
  },
  Arrived: {
    label: "Arrived",
    icon: MapPin,
    dot: "bg-white/25",
    badge: "bg-white/10 text-foreground",
  },
  DeliveryInProgress: {
    label: "In Progress",
    icon: PackageOpen,
    dot: "bg-white/30",
    badge: "bg-white/15 text-foreground",
  },
  Completed: {
    label: "Completed",
    icon: CheckCircle2,
    dot: "bg-white/30",
    badge: "bg-white/15 text-foreground",
  },
  Exception: {
    label: "Exception",
    icon: AlertTriangle,
    dot: "bg-destructive/25",
    badge: "bg-destructive/15 text-red-300",
  },
  HeadingBack: {
    label: "Heading Back",
    icon: Home,
    dot: "bg-white/20",
    badge: "bg-white/10 text-foreground",
  },
  Returned: {
    label: "Returned",
    icon: Check,
    dot: "bg-white/30",
    badge: "bg-white/15 text-foreground",
  },
};

export const ACTION_ICON: Record<ActionType, LucideIcon> = {
  START_ROUTE: Play,
  LEAVING_WAREHOUSE: Truck,
  ARRIVED: MapPin,
  START_DELIVERY: PackageOpen,
  HEADING_NEXT: ArrowRight,
  COMPLETE_AND_RETURN: Home,
  ARRIVED_WAREHOUSE: Home,
  REPORT_EXCEPTION: AlertTriangle,
  RESOLVE_CONTINUE: Play,
  RETURN_ITEM: Undo2,
  REOPEN: RotateCcw,
  NOTIFY_DISPATCH: MessageSquare,
  GAS_LOG: Fuel,
};
