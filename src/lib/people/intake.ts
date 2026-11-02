// New hire intake: the one form every system is fed from. Collected once when the hire is added, then shown
// on their profile in the exact order Gusto asks for it, so Lisa copies it in without chasing anyone.
//
// Deliberately NOT collected: SSN, bank account, W-4 / I-9 answers. Gusto's self onboarding has the hire
// enter those directly in Gusto, which keeps them out of our database.

import { getJson, setJson } from "@/lib/kv";

export type PayType = "hourly" | "salary";
export type WorkerType = "employee" | "contractor";

export interface HireIntake {
  legalFirstName: string;
  legalMiddleName: string;
  legalLastName: string;
  preferredName: string;
  personalEmail: string;
  phone: string; // E.164
  dateOfBirth: string; // YYYY-MM-DD
  street: string;
  city: string;
  state: string; // 2 letters
  zip: string;
  jobTitle: string;
  workerType: WorkerType;
  payType: PayType;
  payRate: number; // dollars per hour or per year
  workLocation: string;
  manager: string;
}

const KEY = "people.intake";

/** Zoe's office, the default work location in Gusto. */
export const DEFAULT_WORK_LOCATION = "Zoe Event Rentals office";

export const INTAKE_DEFAULTS: HireIntake = {
  legalFirstName: "",
  legalMiddleName: "",
  legalLastName: "",
  preferredName: "",
  personalEmail: "",
  phone: "",
  dateOfBirth: "",
  street: "",
  city: "",
  state: "",
  zip: "",
  jobTitle: "Sales Associate",
  workerType: "employee",
  payType: "hourly",
  payRate: 0,
  workLocation: DEFAULT_WORK_LOCATION,
  manager: "",
};

/** US phone to E.164 (+1XXXXXXXXXX). Null when it is not a 10 digit US number. PURE. */
export function toE164(raw: string): string | null {
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

/** The name the team sees: preferred first name (or legal first) plus legal last. PURE. */
export function displayNameFor(i: Pick<HireIntake, "legalFirstName" | "legalLastName" | "preferredName">): string {
  return `${(i.preferredName || i.legalFirstName).trim()} ${i.legalLastName.trim()}`.trim();
}

function age(dob: string, today: string): number {
  const [y, m, d] = dob.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}

/** Clean + validate raw form input. Returns the intake or the list of problems (plain words). PURE. */
export function normalizeIntake(raw: Partial<Record<keyof HireIntake, unknown>>, today: string): { ok: true; intake: HireIntake } | { ok: false; errors: string[] } {
  const s = (k: keyof HireIntake) => String(raw[k] ?? "").trim();
  const errors: string[] = [];
  const phone = s("phone") ? toE164(s("phone")) : "";
  const state = s("state").toUpperCase();
  const intake: HireIntake = {
    legalFirstName: s("legalFirstName"),
    legalMiddleName: s("legalMiddleName"),
    legalLastName: s("legalLastName"),
    preferredName: s("preferredName"),
    personalEmail: s("personalEmail").toLowerCase(),
    phone: phone ?? "",
    dateOfBirth: s("dateOfBirth"),
    street: s("street"),
    city: s("city"),
    state,
    zip: s("zip"),
    jobTitle: s("jobTitle") || INTAKE_DEFAULTS.jobTitle,
    workerType: raw.workerType === "contractor" ? "contractor" : "employee",
    payType: raw.payType === "salary" ? "salary" : "hourly",
    payRate: Number(raw.payRate) || 0,
    workLocation: s("workLocation") || DEFAULT_WORK_LOCATION,
    manager: s("manager"),
  };
  if (!intake.legalFirstName) errors.push("Legal first name is required.");
  if (!intake.legalLastName) errors.push("Legal last name is required.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(intake.personalEmail)) errors.push("A valid personal email is required (Gusto sends the onboarding invite there).");
  if (phone === null) errors.push("Phone must be a 10 digit US number.");
  if (!intake.phone) errors.push("Mobile phone is required (Connecteam and Quo need it).");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(intake.dateOfBirth)) errors.push("Date of birth is required.");
  else if (age(intake.dateOfBirth, today) < 16) errors.push("Date of birth looks wrong (under 16).");
  if (!intake.street || !intake.city) errors.push("Home street and city are required.");
  if (!/^[A-Z]{2}$/.test(state)) errors.push("State must be 2 letters, like MD.");
  if (!/^\d{5}(-\d{4})?$/.test(intake.zip)) errors.push("ZIP must be 5 digits.");
  if (!(intake.payRate > 0)) errors.push("Pay rate is required.");
  return errors.length ? { ok: false, errors } : { ok: true, intake };
}

/** What to type into Gusto, in the order Gusto's Add team member flow asks for it. PURE. */
export function gustoFields(i: HireIntake, workEmail: string | null, startDate: string | null): [string, string][] {
  const rate = i.payType === "hourly" ? `$${i.payRate.toFixed(2)} per hour` : `$${i.payRate.toLocaleString("en-US")} per year`;
  return [
    ["Type", i.workerType === "employee" ? "Employee (W-2)" : "Contractor (1099)"],
    ["Legal first name", i.legalFirstName],
    ["Middle name", i.legalMiddleName || "None"],
    ["Legal last name", i.legalLastName],
    ["Preferred first name", i.preferredName || "Same as legal"],
    ["Personal email (invite goes here)", i.personalEmail],
    ["Start date", startDate ?? "Not set"],
    ["Work location", i.workLocation],
    ["Job title", i.jobTitle],
    ["Pay", rate],
    ["Manager", i.manager || "Not set"],
    ["Date of birth", i.dateOfBirth],
    ["Home address", `${i.street}, ${i.city}, ${i.state} ${i.zip}`],
    ["Phone", i.phone],
    ["Work email", workEmail ?? "None"],
    ["Self onboarding", "Turn ON so the hire enters SSN, bank and tax forms in Gusto"],
  ];
}

export function getIntake(employeeId: string): HireIntake | null {
  return getJson<Record<string, HireIntake>>(KEY, {})[employeeId] ?? null;
}

export function saveIntake(employeeId: string, intake: HireIntake): void {
  const all = getJson<Record<string, HireIntake>>(KEY, {});
  all[employeeId] = intake;
  setJson(KEY, all);
}
