import { describe, expect, it } from "vitest";
import type { CrewMember } from "@/lib/connecteam";
import { dedupeRosterByName } from "./roster";

const m = (userId: number, name: string, userType?: string): CrewMember => ({ userId, name, userType, role: "other" }) as CrewMember;

describe("dedupeRosterByName", () => {
  it("lists a person once when Connecteam has an owner login and a regular user with the same name", () => {
    const out = dedupeRosterByName([m(1, "Cindy Gbobia", "owner"), m(2, "Cindy  Gbobia", "user"), m(3, "Brock Romano", "user")]);
    expect(out.map((x) => x.userId)).toEqual([2, 3]);
  });

  it("keeps every record that is on a shift that day, so nothing assigned disappears", () => {
    const out = dedupeRosterByName([m(1, "Cindy Gbobia", "owner"), m(2, "Cindy Gbobia", "user")], [1]);
    expect(out.map((x) => x.userId)).toEqual([1, 2]);
  });

  it("leaves different people alone and keeps roster order", () => {
    const roster = [m(5, "Adrane Walgori", "user"), m(4, "Brock Romano")];
    expect(dedupeRosterByName(roster)).toEqual(roster);
  });
});
