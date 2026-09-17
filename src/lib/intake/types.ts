// Guided Sales Intake — shared types (client-safe: no imports). Tri-state answers keep UNKNOWN distinct
// from a plain No and from UNANSWERED, per "rules calculate, don't infer": '' means the salesperson
// hasn't asked/answered yet; 'not_sure' means the customer genuinely doesn't know.

export type TriState = "yes" | "no" | "not_sure" | ""; // '' = unanswered
export type CustomerType = "commercial" | "residential" | "";
export type DeliveryTier = "standard" | "premium" | "exact" | "elite" | ""; // window upgrade over base delivery: standard 9a-8p (no upgrade), premium 2hr $100, exact $150, elite 1hr $200
export type IntakeEventType = "wedding" | "corporate" | "social" | "other" | ""; // reuse Sales OS EventType
export type LocationType = "residential" | "venue" | "hotel" | "corporate" | "school" | "park" | "other" | "";
export type IntakeStatus = "draft" | "ready" | "creating" | "created" | "failed";
export type GsStatus = "" | "queued" | "created" | "failed" | "unavailable";

/** Branched logistics answers (only the ones the branch actually asked are set). */
export interface AccessNotes {
  stairs?: TriState;
  elevator?: TriState;
  loadingDock?: TriState;
  accessRestrictions?: TriState;
  longCarry?: TriState; // long distance between truck access and setup area
  parkingRestrictions?: TriState;
  deliveryWindow?: string; // a required delivery window, if the venue has one
  crewNotes?: string; // anything the delivery/setup team should know
}

export interface Intake {
  id: string;
  status: IntakeStatus;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  source: string | null;
  callId: string | null;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  customerType: CustomerType;
  eventType: IntakeEventType;
  eventTypeOther: string;
  guestCount: number | null; // null = unknown or unanswered
  guestCountUnknown: boolean; // true = the customer doesn't know (distinct from unanswered)
  eventDate: string; // YYYY-MM-DD
  eventStartTime: string; // HH:MM
  eventEndTime: string; // HH:MM
  venueName: string;
  streetAddress: string;
  city: string;
  state: string;
  zip: string;
  locationType: LocationType;
  deliveryRequired: TriState;
  deliveryTier: DeliveryTier;
  setupRequired: TriState;
  pickupRequired: TriState;
  accessNotes: AccessNotes;
  logisticsNotes: string;
  salesNotes: string;
  gsContactId: string | null;
  gsProjectId: string | null;
  gsProjectUrl: string | null;
  gsStatus: GsStatus;
  gsError: string | null;
  completedAt: string | null;
}

export type IntakePatch = Partial<Omit<Intake, "id" | "createdAt" | "updatedAt">>;

/** Required fields to create the Goodshuffle shell. Returns the list of what's still missing (empty = OK).
 *  Pure + shared so the wizard and the create endpoint validate identically. */
export function missingRequired(i: Intake): string[] {
  const miss: string[] = [];
  if (!i.firstName.trim()) miss.push("First name");
  if (!i.lastName.trim()) miss.push("Last name");
  if (!i.phone.trim()) miss.push("Phone");
  if (!i.email.trim()) miss.push("Email");
  if (!i.eventType) miss.push("Event type");
  if (!i.eventDate) miss.push("Event date");
  return miss;
}
