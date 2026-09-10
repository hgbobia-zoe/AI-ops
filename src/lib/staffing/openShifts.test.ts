import { describe, it, expect } from "vitest";
import { neededRoleFor, openShiftsWithSuggestions } from "./openShifts";
import type { CrewShift, CrewMember } from "@/lib/connecteam";

const H = 3600;
const user = (userId: number, name: string, role: CrewMember["role"]): CrewMember => ({ userId, name, role });
const shift = (id: string, startH: number, endH: number, assignees: CrewMember[], title = "", isOpen = false): CrewShift => ({
  id,
  schedulerId: 1,
  schedulerName: "Jobs",
  startUnix: startH * H,
  endUnix: endH * H,
  timezone: "America/New_York",
  isOpen,
  title,
  assignees,
});

const drivers = [user(1, "Al Driver", "driver"), user(2, "Bo Driver", "driver")];
const prep = [user(3, "Cy Prep", "prep")];
const all = [...drivers, ...prep];

describe("neededRoleFor", () => {
  it("reads the role from the shift title", () => {
    expect(neededRoleFor("Driver — Route A")).toBe("driver");
    expect(neededRoleFor("Morning delivery")).toBe("driver");
    expect(neededRoleFor("Warehouse load / prep")).toBe("prep");
    expect(neededRoleFor("Return processing")).toBe("prep");
    expect(neededRoleFor("Misc")).toBe("any");
  });
});

describe("openShiftsWithSuggestions", () => {
  it("flags only unassigned shifts", () => {
    const shifts = [
      shift("s1", 8, 12, drivers.slice(0, 1), "Driver A"),
      shift("s2", 8, 12, [], "Driver B", true), // open
      shift("s3", 13, 17, [], "Warehouse load"), // open, later
    ];
    const open = openShiftsWithSuggestions(shifts, all);
    expect(open.map((o) => o.shift.id)).toEqual(["s2", "s3"]);
  });

  it("suggests role-matched, non-conflicting crew, least-loaded first", () => {
    // Al is already on an 8–12 shift; Bo is free. Open driver shift 8–12 should suggest Bo (free),
    // and NOT Al (busy). Cy is prep, so ranked below the driver match.
    const shifts = [
      shift("busy", 8, 12, [drivers[0]], "Driver A"), // Al booked 8–12
      shift("open", 8, 12, [], "Driver — Route B"), // needs a driver, same window
    ];
    const [openView] = openShiftsWithSuggestions(shifts, all);
    expect(openView.neededRole).toBe("driver");
    const ids = openView.suggestions.map((s) => s.member.userId);
    expect(ids).not.toContain(1); // Al is busy in the overlapping window
    expect(ids[0]).toBe(2); // Bo: free + role match → first
    expect(openView.suggestions.find((s) => s.member.userId === 2)?.roleMatch).toBe(true);
    // Cy (prep) still appears (free) but after the driver.
    expect(ids).toContain(3);
    expect(ids.indexOf(2)).toBeLessThan(ids.indexOf(3));
  });

  it("excludes anyone whose existing shift overlaps the open one, but keeps those free later", () => {
    const shifts = [
      shift("early", 6, 9, [drivers[1]], "Driver early"), // Bo booked 6–9
      shift("open", 10, 14, [], "Driver — Route C"), // 10–14, no overlap with Bo's 6–9
    ];
    const [openView] = openShiftsWithSuggestions(shifts, all);
    const ids = openView.suggestions.map((s) => s.member.userId);
    expect(ids).toContain(2); // Bo is free by 10 → eligible
    // Bo shows 3h already booked that day.
    expect(openView.suggestions.find((s) => s.member.userId === 2)?.bookedHours).toBe(3);
  });
});
