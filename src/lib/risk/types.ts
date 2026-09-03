// Event Risk Engine (MVP2) — domain types.
//
// Design: RULES CALCULATE, AI INTERPRETS. The engine below is deterministic and pure —
// given a snapshot of routes + Connecteam shifts + "now", it returns findings. No DB, no
// network, no AI in this layer (that keeps it fully testable and free of false alarms).
// Persistence, scanning, Slack, and the UI wrap this core in later layers.

export type RiskCategory =
  | "STAFFING"
  | "DRIVER"
  | "WAREHOUSE"
  | "ROUTE"
  | "SCHEDULE"
  | "EVENT_INFORMATION"
  | "CUSTOMER_COMMUNICATION"
  | "PAYMENT"
  | "SETUP"
  | "PICKUP"
  | "INVENTORY"
  | "SPECIAL_REQUIREMENT"
  | "OTHER";

export type RiskSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export type RiskStatus = "OPEN" | "ACKNOWLEDGED" | "IN_PROGRESS" | "RESOLVED" | "DISMISSED";

export const SEVERITY_RANK: Record<RiskSeverity, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

/**
 * A risk the engine computed for the current snapshot (pre-persistence). The `signature`
 * is its STABLE identity across scans — same underlying problem ⇒ same signature ⇒ updated
 * in place, never duplicated.
 */
export interface RiskFinding {
  signature: string;
  riskType: string; // machine key, e.g. "route_no_driver"
  category: RiskCategory;
  severity: RiskSeverity;
  title: string;
  description: string;
  /** YYYY-MM-DD of the event/route this risk is about. */
  date: string;
  eventId?: string; // Goodshuffle transactionID (the project/event), when known
  routeId?: string;
  truckId?: string;
  /** Named person/route/thing the risk concerns (e.g. a driver name). */
  affectedEntity?: string;
  recommendedAction?: string;
  /** Where to go fix it: "connecteam" | "dispatch" | "goodshuffle". */
  actionTarget?: "connecteam" | "dispatch" | "goodshuffle";
  metadata?: Record<string, unknown>;
}

/** A stop as the engine needs it (subset of the app's Stop). */
export interface EngineStop {
  sequence: number;
  custName: string;
  kind?: "delivery" | "pickup";
  plannedWindow?: string; // ISO
  eta?: string; // ISO
  items?: { name: string; quantity?: number }[];
}

/** A route as the engine needs it (subset of the app's Route + the Dispatch driver assignment). */
export interface EngineRoute {
  routeId: string;
  truckId: string;
  date: string; // YYYY-MM-DD
  status: string; // "ready" | "active" | "done" | ...
  gsRouteId?: string;
  /** Connecteam userId of the driver assigned to this route (in Dispatch), if any. */
  driverId?: string;
  driverName?: string;
  stops: EngineStop[];
}

/** A crew shift as the engine needs it (from Connecteam), already filtered to a role. */
export interface EngineShift {
  userId: number;
  name: string;
  startUnix: number; // seconds
  endUnix: number; // seconds
  isOpen: boolean;
}

export interface RiskConfig {
  /** When true, every active route is expected to have a driver assigned (in Dispatch): an
   *  unassigned route is then CRITICAL. Off until Zoe starts assigning drivers — until then
   *  the engine uses day-level count + time coverage instead (no per-route false CRITICALs). */
  driverAssignmentEnabled: boolean;
  /** Minutes before the first stop the crew must be loading/departing (part of the driver's window). */
  loadBufferMin: number;
  /** Minutes after the last stop for the return leg (part of the driver's window). */
  returnBufferMin: number;
  /** Below this many minutes of slack between a shift edge and the route window → tight (MEDIUM). */
  tightBufferMin: number;
  /** Warehouse associates required per route on a load day (configurable, not hard-coded). */
  warehousePerRoutes: number;
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  driverAssignmentEnabled: false,
  loadBufferMin: 60,
  returnBufferMin: 60,
  tightBufferMin: 30,
  warehousePerRoutes: 3, // 1 warehouse associate can support up to 3 routes' prep/load
};
