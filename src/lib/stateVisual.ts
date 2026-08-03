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

export const STATE_VISUAL: Record<StopState, StateVisual> = {
  Waiting: {
    label: "Waiting",
    icon: Clock,
    dot: "bg-slate-400",
    badge: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  },
  EnRoute: {
    label: "En Route",
    icon: Truck,
    dot: "bg-blue-500",
    badge: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-200",
  },
  Arrived: {
    label: "Arrived",
    icon: MapPin,
    dot: "bg-indigo-500",
    badge: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-200",
  },
  DeliveryInProgress: {
    label: "In Progress",
    icon: PackageOpen,
    dot: "bg-amber-500",
    badge: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  },
  Completed: {
    label: "Completed",
    icon: CheckCircle2,
    dot: "bg-emerald-500",
    badge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-200",
  },
  Exception: {
    label: "Exception",
    icon: AlertTriangle,
    dot: "bg-red-500",
    badge: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-200",
  },
  HeadingBack: {
    label: "Heading Back",
    icon: Home,
    dot: "bg-purple-500",
    badge: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-200",
  },
  Returned: {
    label: "Returned",
    icon: Check,
    dot: "bg-teal-500",
    badge: "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-200",
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
