import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Throwaway DB so the settings KV (where the contact map lives) is isolated per file.
// All fixtures below are synthetic (555 test numbers, fictional names) — never real worker data.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "aiops-iwcontacts-"));
  process.env.DATABASE_PATH = join(dir, "test.db");
});
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// Import AFTER the env is set so getDb() opens the throwaway file.
async function mod() {
  return await import("./contacts");
}

describe("instawork contacts — parse", () => {
  it("plausiblePhone accepts US 10 / 1+10 digit numbers, rejects partial/junk", async () => {
    const { plausiblePhone } = await mod();
    expect(plausiblePhone("(301) 555-0147")).toBe(true);
    expect(plausiblePhone("3015550147")).toBe(true);
    expect(plausiblePhone("13015550147")).toBe(true);
    expect(plausiblePhone("+1 301 555 0147")).toBe(true);
    expect(plausiblePhone("555-0147")).toBe(false); // 7 digits
    expect(plausiblePhone("")).toBe(false);
    expect(plausiblePhone("not a phone")).toBe(false);
  });

  it("toContact maps one timesheet row and coerces worker_id to a string", async () => {
    const { toContact } = await mod();
    const c = toContact(
      { worker_id: 7000001, worker: "Jordan Rivera", worker_phone_number: "(301) 555-0147" },
      "2026-10-16T00:00:00.000Z",
    );
    expect(c).toEqual({ workerId: "7000001", name: "Jordan Rivera", phone: "(301) 555-0147", capturedAt: "2026-10-16T00:00:00.000Z" });
  });

  it("toContact returns null without a usable phone or any identity handle", async () => {
    const { toContact } = await mod();
    expect(toContact({ worker_id: 1, worker: "X", worker_phone_number: "" }, "t")).toBeNull();
    expect(toContact({ worker_id: 1, worker: "X", worker_phone_number: "123" }, "t")).toBeNull();
    expect(toContact({ worker_phone_number: "(301) 555-0147" }, "t")).toBeNull(); // no name, no id
  });
});

describe("instawork contacts — store + lookup", () => {
  it("saves, reads, and finds by id then name (case-insensitive)", async () => {
    const { saveInstaworkContacts, findInstaworkPhone, readInstaworkContacts } = await mod();
    const n = saveInstaworkContacts([
      { workerId: "7000001", name: "Jordan Rivera", phone: "(301) 555-0147", capturedAt: "2026-10-16T00:00:00.000Z" },
      { workerId: "7000002", name: "Alex Kim", phone: "(202) 555-0168", capturedAt: "2026-10-16T00:00:00.000Z" },
    ]);
    expect(n).toBe(2);
    expect(readInstaworkContacts().contacts).toHaveLength(2);
    expect(findInstaworkPhone({ workerId: "7000001" })).toBe("(301) 555-0147");
    expect(findInstaworkPhone({ workerName: "jordan rivera" })).toBe("(301) 555-0147"); // case-insensitive
    expect(findInstaworkPhone({ workerName: "Alex Kim" })).toBe("(202) 555-0168");
    expect(findInstaworkPhone({ workerName: "nobody here" })).toBeNull();
    expect(findInstaworkPhone({})).toBeNull();
  });

  it("merges newest-wins per worker id (no duplicate rows)", async () => {
    const { saveInstaworkContacts, findInstaworkPhone, readInstaworkContacts } = await mod();
    const before = readInstaworkContacts().contacts.length;
    saveInstaworkContacts([{ workerId: "7000001", name: "Jordan Rivera", phone: "(301) 555-0147", capturedAt: "2026-10-16T00:00:00.000Z" }]);
    saveInstaworkContacts([{ workerId: "7000001", name: "Jordan R", phone: "(301) 555-0199", capturedAt: "2026-10-17T00:00:00.000Z" }]);
    // Same worker id → one row, newer phone wins; the total count did not grow.
    expect(findInstaworkPhone({ workerId: "7000001" })).toBe("(301) 555-0199");
    expect(readInstaworkContacts().contacts.length).toBe(before);
  });

  it("dedups by normalized name when no worker id is present", async () => {
    const { saveInstaworkContacts, findInstaworkPhone } = await mod();
    saveInstaworkContacts([{ workerId: null, name: "Jane Doe", phone: "(240) 555-0111", capturedAt: "2026-10-16T00:00:00.000Z" }]);
    saveInstaworkContacts([{ workerId: null, name: "JANE DOE", phone: "(240) 555-0122", capturedAt: "2026-10-17T00:00:00.000Z" }]);
    expect(findInstaworkPhone({ workerName: "jane doe" })).toBe("(240) 555-0122");
  });
});
