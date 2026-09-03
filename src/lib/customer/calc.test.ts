import { describe, it, expect } from "vitest";
import { normalizeName, aggregateCustomers } from "./calc";

describe("customer — name normalization", () => {
  it("collapses case and whitespace so the same person aggregates", () => {
    expect(normalizeName("Jane  Doe")).toBe("jane doe");
    expect(normalizeName("  jane doe ")).toBe("jane doe");
  });
});

describe("customer — aggregation from booking dates", () => {
  const today = "2026-09-02";

  it("counts bookings, tracks first/last, and marks repeat customers", () => {
    const events = [
      { name: "Jane Doe", date: "2025-06-01" },
      { name: "jane doe", date: "2026-01-10" }, // same person, different casing
      { name: "Bob Smith", date: "2026-02-01" }, // one-timer
    ];
    const c = aggregateCustomers(events, today);
    const jane = c.find((x) => x.key === "jane doe")!;
    expect(jane.bookings).toBe(2);
    expect(jane.firstSeen).toBe("2025-06-01");
    expect(jane.lastSeen).toBe("2026-01-10");
    expect(jane.repeat).toBe(true);
    const bob = c.find((x) => x.key === "bob smith")!;
    expect(bob.repeat).toBe(false);
    expect(bob.status).toBe("one-time");
  });

  it("classifies a future booking as active and a long-lapsed repeat as dormant", () => {
    const events = [
      { name: "Future Client", date: "2026-10-01" }, // upcoming
      { name: "Lapsed Repeat", date: "2024-01-01" },
      { name: "Lapsed Repeat", date: "2024-03-01" }, // last booking >1yr before today
    ];
    const c = aggregateCustomers(events, today, 365);
    expect(c.find((x) => x.key === "future client")!.status).toBe("active");
    expect(c.find((x) => x.key === "future client")!.daysSinceLast).toBeLessThan(0);
    expect(c.find((x) => x.key === "lapsed repeat")!.status).toBe("dormant");
  });

  it("skips blank names — never invents a customer", () => {
    const c = aggregateCustomers([{ name: "  ", date: "2026-01-01" }, { name: "Real", date: "2026-01-02" }], today);
    expect(c).toHaveLength(1);
    expect(c[0].name).toBe("Real");
  });

  it("keys by contactId when present, merging same-id events even if the name differs", () => {
    const events = [
      { name: "Jane Doe", date: "2025-06-01", contactId: "1178" },
      { name: "Jane D.", date: "2026-01-10", contactId: "1178" }, // different display, same id → one customer
      { name: "Jane Doe", date: "2026-02-01", contactId: "9999" }, // same name, different id → separate
    ];
    const c = aggregateCustomers(events, today);
    expect(c).toHaveLength(2);
    expect(c.find((x) => x.key === "id:1178")!.bookings).toBe(2);
    expect(c.find((x) => x.key === "id:9999")!.bookings).toBe(1);
  });

  it("sorts most-frequent first", () => {
    const events = [
      { name: "A", date: "2026-01-01" },
      { name: "B", date: "2026-01-01" },
      { name: "B", date: "2026-02-01" },
    ];
    const c = aggregateCustomers(events, today);
    expect(c[0].key).toBe("b");
  });
});
