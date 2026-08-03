// Shared domain types for the AI Operations Platform — Module 1 (Dispatch).
// These mirror the Zapier Tables schema (see SETUP.md). Relations are ID
// references, not enforced foreign keys — Zapier Tables has no joins.

/** The lifecycle state of a stop (or the active route context). */
export type StopState =
  | "Waiting"
  | "EnRoute"
  | "Arrived"
  | "DeliveryInProgress"
  | "Completed"
  | "Exception"
  | "HeadingBack"
  | "Returned";

/** Every driver action that can be fired at the backend. One tap = one action. */
export type ActionType =
  | "START_ROUTE"
  | "LEAVING_WAREHOUSE"
  | "ARRIVED"
  | "START_DELIVERY"
  | "HEADING_NEXT"
  | "COMPLETE_AND_RETURN"
  | "ARRIVED_WAREHOUSE"
  | "REPORT_EXCEPTION"
  | "RESOLVE_CONTINUE"
  | "RETURN_ITEM"
  | "REOPEN";

export type ExceptionType =
  | "Customer unavailable"
  | "Wrong address"
  | "Access denied"
  | "Vehicle issue"
  | "Missing inventory"
  | "Damaged inventory"
  | "Route issue"
  | "Automation failure"
  | "Other";

export interface GpsFix {
  lat: number;
  lng: number;
  ts: string; // ISO8601
}

export interface ChecklistResult {
  signed: boolean;
  photos: boolean;
  equipment: boolean;
  siteClean: boolean;
  overrideReason?: string; // required when any box is unchecked
}

/** Payload shapes keyed by action. Kept permissive; the intake validates. */
export interface ActionPayloads {
  START_ROUTE: { date: string };
  HEADING_NEXT: {
    checklist: ChecklistResult;
    signatureUrl?: string;
    photosRef?: string;
  };
  COMPLETE_AND_RETURN: {
    checklist: ChecklistResult;
    signatureUrl?: string;
    photosRef?: string;
  };
  REPORT_EXCEPTION: { type: ExceptionType; reason: string };
  [key: string]: Record<string, unknown> | undefined;
}

/** The single envelope every action POSTs to /api/action. */
export interface ActionRequest {
  idempotencyKey: string;
  truckId: string;
  driverId?: string;
  routeId: string;
  stopId: string;
  action: ActionType;
  fromState: StopState;
  gps?: GpsFix;
  clientTs: string; // ISO8601
  payload?: Record<string, unknown>;
  /** Transition context so the server can enforce last-stop / approval rules. */
  context?: { isFirstStop?: boolean; isLastStop?: boolean; isAdmin?: boolean };
}

export interface ActionResponse {
  accepted: boolean;
  eventId?: string;
  toState?: StopState;
  duplicate?: boolean;
  error?: string;
}

export interface Customer {
  customerId: string;
  name: string;
  phone: string;
  address: string;
  lat?: number;
  lng?: number;
  notes?: string;
}

export interface Stop {
  stopId: string;
  routeId: string;
  customerId: string;
  sequence: number;
  state: StopState;
  // Read-hot fields denormalized onto the stop so the tablet reads one table.
  custName: string;
  custPhone: string;
  address: string;
  plannedWindow?: string;
  eta?: string;
  arrivedAt?: string;
  completedAt?: string;
  trackingLinkId?: string;
  signatureUrl?: string;
  photosRef?: string;
}

export type RouteStatus =
  | "scraping"
  | "ready"
  | "failed"
  | "active"
  | "done";

export interface Route {
  routeId: string;
  date: string;
  truckId: string;
  driverId?: string;
  status: RouteStatus;
  stops: Stop[];
}

export interface Vehicle {
  truckId: string;
  name: string;
  plate?: string;
  zonarDeviceId?: string;
  active: boolean;
}
