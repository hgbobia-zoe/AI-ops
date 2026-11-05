// New in Gusto: parse the captured shapes, show only net new, link known people, accept personal details
// only for net-new ids, and add a person to People as a HIRE with what Connecteam needs.

import { describe, it, expect } from "vitest";
import { createEmployee, getEmployee } from "./store";
import {
  addFromGusto,
  gustoNewHireList,
  hideFromGusto,
  ingestGustoDetails,
  ingestGustoRoster,
  parseGustoDetails,
  parseGustoRoster,
  planGustoDelta,
  type GustoRosterPerson,
} from "./gustoNewHires";
import type { Employee } from "./types";

function rosterResp(nodes: Record<string, unknown>[], drafts: Record<string, unknown>[] = []) {
  return { data: { company: { id: "c", members: { edges: nodes.map((node) => ({ node })), pageInfo: { hasNextPage: false } }, draftTeamMembers: { nodes: drafts } } } };
}
const member = (id: string, first: string, last: string, extra: Record<string, unknown> = {}) => ({
  id, legalFirstName: first, lastName: last, preferredFullName: `${first} ${last}`, personType: "INDIVIDUAL", jobTitle: "Sales Associate",
  latestEmployment: { startDate: "2026-11-08", endDate: null, setupStatus: "COMPLETED", workerType: "EMPLOYEE" }, upcomingEmployment: null, ...extra,
});
const details = (birthday: string, number: string, email: string) => ({
  data: { member: { company: { person: { id: "x", birthday, email, phoneNumber: { callingCode: "1", countryCode: "US", number }, currentLegalName: { firstName: "Maria", lastName: "Lopez" }, latestEmployment: { startDate: "2026-11-08" } } } } },
});

function person(over: Partial<GustoRosterPerson> & { id: string }): GustoRosterPerson {
  return { source: "member", firstName: "A", lastName: "B", preferredName: null, jobTitle: null, workerType: null, startDate: null, endDate: null, setupStatus: null, offerStatus: null, ...over };
}
function emp(over: Partial<Employee> & { id: string; displayName: string }): Employee {
  return {
    workEmail: null, phone: null, birthDate: null, personalEmail: null, lifecycleState: "ACTIVE", role: "member", department: "sales_associate", startDate: null, endDate: null,
    userId: null, hrWorkerId: null, connecteamUserId: null, instaworkWorker: null, openphoneUserId: null, gustoId: null, aiOrgHumanName: null, createdAt: "", updatedAt: "", ...over,
  };
}

describe("parsing", () => {
  it("reads members, onboarding people and draft offers into one list", () => {
    const onboarding = { data: { company: { onboarding: { nodes: [member("g2", "New", "Person", { latestEmployment: { setupStatus: "IN_PROGRESS", startDate: "2026-11-08" }, offer: { status: "ACCEPTED" } })] } } } };
    const list = parseGustoRoster(rosterResp([member("g1", "Jessie", "Medalla")], [{ id: "d1", legalFirstName: "Draft", lastName: "Hire", startDate: "2026-12-01", sendOffer: true }]), onboarding);
    expect(list.map((p) => p.id).sort()).toEqual(["draft:d1", "g1", "g2"]);
    expect(list.find((p) => p.id === "g2")!.offerStatus).toBe("ACCEPTED");
    expect(list.find((p) => p.id === "draft:d1")!.source).toBe("draft");
  });

  it("details keep only what we use and normalize the phone", () => {
    const d = parseGustoDetails("g2", details("1999-04-02", "(301) 555-0177", "Maria@Example.com"))!;
    expect(d).toEqual({ id: "g2", legalFirstName: "Maria", legalLastName: "Lopez", birthDate: "1999-04-02", phone: "+13015550177", personalEmail: "maria@example.com", startDate: "2026-11-08" });
  });
});

describe("planGustoDelta", () => {
  const today = "2026-11-05";
  it("skips people already linked, linked through payroll, matched by full name, hidden, or gone", () => {
    const r = planGustoDelta({
      roster: [
        person({ id: "g1", firstName: "Linked", lastName: "Already" }),
        person({ id: "g2", firstName: "Via", lastName: "Payroll" }),
        person({ id: "g3", firstName: "Jessie", lastName: "Medalla" }),
        person({ id: "g4", firstName: "Hidden", lastName: "Owner" }),
        person({ id: "g5", firstName: "Left", lastName: "Already", endDate: "2026-10-01" }),
        person({ id: "g6", firstName: "Maria", lastName: "Lopez" }),
      ],
      employees: [
        emp({ id: "E1", displayName: "Linked Already", gustoId: "g1" }),
        emp({ id: "E2", displayName: "Someone Else", hrWorkerId: "HW2" }),
        emp({ id: "E3", displayName: "Jessie Medalla" }),
      ],
      workers: [{ id: "HW2", gustoId: "g2" }],
      hidden: ["g4"],
      today,
    });
    expect(r.netNew.map((p) => p.id)).toEqual(["g6"]);
    expect(r.links).toEqual([
      { employeeId: "E2", gustoId: "g2", via: "payroll worker" },
      { employeeId: "E3", gustoId: "g3", via: "full name" },
    ]);
  });

  it("two People records with the same name is not a match; the Gusto person stays listed", () => {
    const r = planGustoDelta({
      roster: [person({ id: "g1", firstName: "Chris", lastName: "Doe" })],
      employees: [emp({ id: "A", displayName: "Chris Doe" }), emp({ id: "B", displayName: "Chris Doe" })],
      workers: [],
      hidden: [],
      today,
    });
    expect(r.netNew).toHaveLength(1);
    expect(r.links).toHaveLength(0);
  });
});

describe("ingest, details gate, add and hide", () => {
  it("asks for details of net-new people only, refuses others, then adds a HIRE with Connecteam fields", () => {
    createEmployee({ displayName: "Known Person", role: "member", department: "sales_associate", lifecycleState: "ACTIVE" });
    const r = ingestGustoRoster(parseGustoRoster(rosterResp([member("k1", "Known", "Person"), member("n1", "Maria", "Lopez")]), null));
    expect(r.needDetails).toEqual(["n1"]);
    expect(r.linked).toBe(1);

    const gate = ingestGustoDetails([
      parseGustoDetails("n1", details("1999-04-02", "3015550177", "maria@example.com"))!,
      parseGustoDetails("k1", details("1980-01-01", "3015550100", "known@example.com"))!,
    ]);
    expect(gate).toEqual({ stored: 1, refused: 1 });

    const added = addFromGusto("n1", "sales_associate", "Hermann");
    expect(added.ok).toBe(true);
    const e = getEmployee(added.employeeId!)!;
    expect(e).toMatchObject({ displayName: "Maria Lopez", lifecycleState: "HIRE", gustoId: "n1", phone: "+13015550177", birthDate: "1999-04-02", personalEmail: "maria@example.com", startDate: "2026-11-08", workEmail: "maria.lopez@zoeeventsdmv.com" });
    expect(gustoNewHireList()!.people.some((p) => p.id === "n1")).toBe(false);

    // The next pull does not list her again: she is linked by Gusto id now.
    expect(ingestGustoRoster(parseGustoRoster(rosterResp([member("n1", "Maria", "Lopez")]), null)).netNew).toBe(0);
  });

  it("hiding keeps someone off future pulls", () => {
    ingestGustoRoster(parseGustoRoster(rosterResp([member("h1", "Contract", "Abroad")]), null));
    expect(hideFromGusto("h1", "Hermann").ok).toBe(true);
    expect(ingestGustoRoster(parseGustoRoster(rosterResp([member("h1", "Contract", "Abroad")]), null)).netNew).toBe(0);
  });
});
