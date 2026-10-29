import { describe, it, expect } from "vitest";
import { SALES_STATUS_TONE, SALES_STATUS_ICON } from "./salesStatus";
import { STATUS_LABEL, type LeadStatus } from "./boardTypes";

const ALL_STATUSES = Object.keys(STATUS_LABEL) as LeadStatus[];

describe("salesos salesStatus — shared status vocabulary mapping", () => {
  it("maps every board/lead status to a tone and an icon (no status renders untyped)", () => {
    for (const s of ALL_STATUSES) {
      expect(SALES_STATUS_TONE[s], `tone for ${s}`).toBeTruthy();
      expect(SALES_STATUS_ICON[s], `icon for ${s}`).toBeTruthy();
    }
  });

  it("keeps the meaningful tones: action_needed is critical, signed is positive, archived is neutral", () => {
    expect(SALES_STATUS_TONE.action_needed).toBe("critical");
    expect(SALES_STATUS_TONE.signed).toBe("positive");
    expect(SALES_STATUS_TONE.follow_up).toBe("attention");
    expect(SALES_STATUS_TONE.archived).toBe("neutral");
  });
});
