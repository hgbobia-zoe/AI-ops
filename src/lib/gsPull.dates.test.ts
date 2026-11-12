import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildOfficePullScript, gsEventYmd, gsWindowTime, gsYmd, selectNoteCaptureIds, selectWindowCaptureIds } from "./gsPull";
import { parseGsWindowTime } from "@/lib/dispatch/onTime";

// In Nov 2026 Goodshuffle's searchProjects stopped sending logistics_start_date / quote_sent_date /
// date_created / logistics_start_from_time and started sending *_millis + *_zone (+ logistics_start_time_set).
// The pull read the old names, so every project arrived with no dates. These pin the new shape.

// A real row's shape (Garrison, verified live 2026-11-12): delivery Dec 7, 8:00 AM Eastern.
const ROW = {
  logistics_start_millis: 1796648400000,
  logistics_start_time_set: true,
  logistics_start_zone: "America/New_York",
  quote_sent_millis: 1793898840499,
  quote_sent_zone: "America/New_York",
  date_created_millis: 1793731691016,
  date_created_zone: "America/New_York",
};

describe("Goodshuffle date fields", () => {
  it("reads the new *_millis shape in the project's zone", () => {
    expect(gsEventYmd(ROW)).toBe("2026-12-07");
    expect(gsYmd(null, ROW.quote_sent_millis, ROW.quote_sent_zone)).toBe("2026-11-05");
    expect(gsYmd(null, ROW.date_created_millis, ROW.date_created_zone)).toBe("2026-11-03");
  });

  it("uses the Eastern day, not the UTC day, for a late evening time", () => {
    // 10 PM Eastern on Dec 7 is already Dec 8 in UTC.
    expect(gsYmd(null, Date.parse("2026-12-08T03:00:00Z"), "America/New_York")).toBe("2026-12-07");
  });

  it("still reads the old string shape, and is null when nothing is set", () => {
    expect(gsYmd("Oct 31, 2026", null)).toBe("2026-10-31");
    expect(gsYmd(null, null)).toBeNull();
    expect(gsYmd(null, "")).toBeNull();
    expect(gsEventYmd({})).toBeNull();
  });

  it("gives the delivery window start in the format the on-time check reads", () => {
    const t = gsWindowTime(ROW);
    expect(t).toBe("8:00 AM EST");
    expect(parseGsWindowTime("2026-12-07", t)).toBe("2026-12-07T13:00:00.000Z");
    expect(gsWindowTime({ ...ROW, logistics_start_time_set: false })).toBe("TBD");
    expect(gsWindowTime({ logistics_start_from_time: "9:00 AM EDT" })).toBe("9:00 AM EDT");
    expect(gsWindowTime({})).toBeNull();
  });

  it("selects near-term signed deliveries and dated windows from the new shape", () => {
    const projects = { "1": { ...ROW, signed: true, statusLabel: "Contract Signed" } };
    expect(selectNoteCaptureIds(projects, "2026-12-06", "2026-12-09")).toEqual(["1"]);
    expect(selectWindowCaptureIds(projects, "2026-11-30", "2026-12-14", false)).toEqual(["1"]);
  });
});

// The two pull scripts carry inline copies (they cannot import). Run each copy against the same rows and
// require the same answers as the tested functions above.
const extSrc = readFileSync(fileURLToPath(new URL("../../extension/pull-injected.js", import.meta.url)), "utf8");
const bookmarkletSrc = buildOfficePullScript("https://zoe-dispatch.fly.dev");

function inlineHelpers(src: string): { gsYmd: typeof gsYmd; evYmd: typeof gsEventYmd; gsTime: typeof gsWindowTime } {
  const grab = (name: string): string => {
    const start = src.indexOf(`function ${name}(`);
    expect(start, `${name} is in the script`).toBeGreaterThanOrEqual(0);
    // Each helper ends at the first newline whose next line does not continue its body.
    let depth = 0;
    for (let i = src.indexOf("{", start); i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`unterminated ${name}`);
  };
  const d2 = grab("d2");
  const body = [d2, grab("gsYmd"), grab("evYmd"), grab("gsTime")].join("\n");
  return new Function(`${body}; return { gsYmd, evYmd, gsTime };`)();
}

describe("both pull scripts read the new date shape the same way", () => {
  for (const [name, src] of [["extension", extSrc], ["bookmarklet", bookmarkletSrc]] as const) {
    it(name, () => {
      const h = inlineHelpers(src);
      expect(h.evYmd(ROW)).toBe("2026-12-07");
      expect(h.gsYmd(null, ROW.quote_sent_millis, ROW.quote_sent_zone)).toBe("2026-11-05");
      expect(h.gsYmd("Oct 31, 2026", null)).toBe("2026-10-31");
      expect(h.gsTime(ROW)).toBe("8:00 AM EST");
      expect(h.gsTime({ ...ROW, logistics_start_time_set: false })).toBe("TBD");
      // The project record uses them, not the old field names.
      expect(src).toMatch(/dateCreated: ?gsYmd\(p\.date_created, ?p\.date_created_millis, ?p\.date_created_zone\)/);
      expect(src).toMatch(/quoteSentDate: ?gsYmd\(p\.quote_sent_date, ?p\.quote_sent_millis, ?p\.quote_sent_zone\)/);
      expect(src).toMatch(/eventDate: ?evYmd\(p\)/);
      expect(src).toMatch(/logisticsStartTime: ?gsTime\(p\)/);
    });
  }
});
