// Shared domain types for the AI Operations Platform — Module 1 (Dispatch).
// These mirror the Zapier Tables schema (see SETUP.md). Relations are ID
// references, not enforced foreign keys — Zapier Tables has no joins.

/** The lifecycle state of a stop (or the active route context). */
export type StopState =
  | "Waiting"
  | "EnRoute"
  | "Arrived"
  | "Completed"
  | "Exception"
  | "HeadingBack"
  | "Returned";

/** Every driver action that can be fired at the backend. One tap = one action. */
export type ActionType =
  | "START_ROUTE"
  | "LEAVING_WAREHOUSE"
  | "ARRIVED"
  | "HEADING_NEXT"
  | "COMPLETE_AND_RETURN"
  | "ARRIVED_WAREHOUSE"
  | "REPORT_EXCEPTION"
  | "RESOLVE_CONTINUE"
  | "RETURN_ITEM"
  | "REOPEN"
  // Side actions: not state transitions, just fan out to Slack/logging.
  | "NOTIFY_DISPATCH"
  | "GAS_LOG";

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
    /** Proof-of-delivery references (ids from POST /api/pod). */
    photoIds?: string[];
    signatureId?: string;
  };
  COMPLETE_AND_RETURN: {
    checklist: ChecklistResult;
    photoIds?: string[];
    signatureId?: string;
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
  /** The customer's real first name (from Goodshuffle's renter), used to personalize
   *  texts. custName may be an event/last-name label, so greetings prefer this. */
  custFirstName?: string;
  /** Whether this stop is a delivery (drop-off) or a pickup (collection). From
   *  Goodshuffle's waypointType. Drives which message template is used. Defaults to
   *  "delivery" when unknown. */
  kind?: "delivery" | "pickup";
  custPhone: string;
  address: string;
  // Optional day-of coordinator for this event. When present, "on the way" /
  // "arrived" texts go to them as well as the customer.
  dayOfName?: string;
  dayOfPhone?: string;
  plannedWindow?: string;
  eta?: string;
  /** Goodshuffle line items for this stop's event (name + qty). Drives crew-size rules
   *  (tent → 2, 40x60 → 3) and, later, LLM quote review. Optional; absent on old pulls. */
  items?: { name: string; quantity?: number }[];
  arrivedAt?: string;
  completedAt?: string;
  trackingLinkId?: string;
  /** Proof of delivery captured at completion. */
  photoIds?: string[];
  signatureId?: string;
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
