// Zoe Capability Profile — PURE shape (types, options, empty, completeness). No DB import, so both the
// server store (capabilityProfile.ts) and the client form can use it. FACTS ONLY.

export interface PastProject {
  name: string; // client / event / venue
  detail: string; // one line: what Zoe provided
  year: string; // "" when unknown
}

export interface CapabilityProfile {
  // Company
  legalName: string;
  dba: string;
  website: string;
  phone: string;
  email: string;
  address: string;
  foundedYear: string;
  serviceArea: string;
  // Federal / registration
  samRegistered: boolean;
  uei: string;
  cageCode: string;
  naicsCodes: string;
  // Certifications
  certifications: string[];
  certificationsOther: string;
  // Insurance limits
  generalLiability: string;
  autoLiability: string;
  workersComp: string;
  umbrella: string;
  providesAdditionalInsured: boolean;
  // Capabilities
  coreCompetencies: string;
  capacitySummary: string;
  differentiators: string;
  pastPerformance: PastProject[];
  // Bid point of contact
  bidContactName: string;
  bidContactTitle: string;
  bidContactEmail: string;
  bidContactPhone: string;
  updatedAt: string | null;
}

/** Certifications a DMV event-rental firm might hold. Free-text "other" covers the rest. */
export const CERT_OPTIONS: { value: string; label: string }[] = [
  { value: "MBE", label: "MBE (Minority Business Enterprise)" },
  { value: "SBE", label: "SBE (Small Business Enterprise)" },
  { value: "DBE", label: "DBE (Disadvantaged Business Enterprise)" },
  { value: "WOSB", label: "WOSB (Woman-Owned Small Business)" },
  { value: "SDVOSB", label: "SDVOSB (Service-Disabled Veteran-Owned)" },
  { value: "VOSB", label: "VOSB (Veteran-Owned Small Business)" },
  { value: "8A", label: "8(a) Business Development" },
  { value: "HUBZONE", label: "HUBZone" },
  { value: "STATE_SBR", label: "State Small Business Reserve (MD SBR)" },
];

export function emptyProfile(): CapabilityProfile {
  return {
    legalName: "", dba: "", website: "", phone: "", email: "", address: "", foundedYear: "", serviceArea: "",
    samRegistered: false, uei: "", cageCode: "", naicsCodes: "",
    certifications: [], certificationsOther: "",
    generalLiability: "", autoLiability: "", workersComp: "", umbrella: "", providesAdditionalInsured: false,
    coreCompetencies: "", capacitySummary: "", differentiators: "", pastPerformance: [],
    bidContactName: "", bidContactTitle: "", bidContactEmail: "", bidContactPhone: "",
    updatedAt: null,
  };
}

/** How complete the profile is (0-1) over the fields that matter for a capability statement — indicative. */
export function profileCompleteness(p: CapabilityProfile): number {
  const checks = [
    !!p.legalName, !!p.serviceArea, !!p.coreCompetencies, !!p.capacitySummary,
    !!p.differentiators, p.pastPerformance.length > 0, !!p.bidContactName, !!p.bidContactEmail,
    !!p.generalLiability, p.certifications.length > 0 || !!p.certificationsOther,
  ];
  return checks.filter(Boolean).length / checks.length;
}
