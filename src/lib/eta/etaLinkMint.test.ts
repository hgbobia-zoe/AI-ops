import { describe, it, expect } from "vitest";
import {
  ETA_NOTIFY_PHONE_E164,
  IGNITION_ETALINK_ORIGIN,
  DEFAULT_IGNITION_UNITS,
  resolveIgnitionUnitId,
  etaLinkUrl,
  buildEtaLinkMintRequest,
  selectTrackingLink,
  type EtaLinkMintInput,
} from "./etaLinkMint";

describe("etaLinkMint — notify-line rule", () => {
  it("the notify line is the Zoe main line in E.164, never the customer", () => {
    expect(ETA_NOTIFY_PHONE_E164).toBe("+13012915296");
  });

  it("the mint request always carries the Zoe notify line, ignoring any input", () => {
    const req = buildEtaLinkMintRequest("EL-1", baseInput());
    expect(req.notifySms).toBe("+13012915296");
  });
});

describe("etaLinkMint — unit-label → unitId resolution", () => {
  it("resolves the known trucks from the captured searchUnits table", () => {
    expect(resolveIgnitionUnitId("E450")).toBe(200149627);
    expect(resolveIgnitionUnitId("NPR-1")).toBe(200149626);
    expect(resolveIgnitionUnitId("NPR-2")).toBe(200214102);
    expect(DEFAULT_IGNITION_UNITS.E450).toBe(200149627);
  });

  it("returns null for an unknown truck", () => {
    expect(resolveIgnitionUnitId("GHOST")).toBeNull();
  });

  it("honors an override map (object or JSON string) and keeps defaults for others", () => {
    expect(resolveIgnitionUnitId("E450", { E450: 999 })).toBe(999);
    expect(resolveIgnitionUnitId("NPR-1", { E450: 999 })).toBe(200149626);
    expect(resolveIgnitionUnitId("E450", '{"E450": 777}')).toBe(777);
  });

  it("ignores a malformed override and falls back to the default map", () => {
    expect(resolveIgnitionUnitId("E450", "{not json")).toBe(200149627);
  });
});

describe("etaLinkMint — public URL builder", () => {
  it("builds the Ignition live page URL from a code", () => {
    expect(etaLinkUrl("11e38c7d61")).toBe(`${IGNITION_ETALINK_ORIGIN}/etaLink/11e38c7d61`);
    expect(etaLinkUrl("abc")).toBe("https://ignition.zonarsystems.com/etaLink/abc");
  });
});

describe("etaLinkMint — request builder shape", () => {
  it("normalizes coords, eta hours, and fills the unit hint from the truckId", () => {
    const req = buildEtaLinkMintRequest("EL-9", baseInput({ etaHours: 0.25 }));
    expect(req.id).toBe("EL-9");
    expect(req.latitude).toBe(39.085986);
    expect(req.longitude).toBe(-77.1494791);
    expect(req.etaHours).toBe("0.25");
    expect(req.unitIdHint).toBe(200149627); // from truckId E450
    expect(req.truckLabel).toBe("Ford E450");
  });

  it("leaves etaHours null when not provided or non-finite", () => {
    expect(buildEtaLinkMintRequest("EL-1", baseInput({ etaHours: null })).etaHours).toBeNull();
    expect(buildEtaLinkMintRequest("EL-1", baseInput({ etaHours: Number.NaN })).etaHours).toBeNull();
    expect(buildEtaLinkMintRequest("EL-1", baseInput({})).etaHours).toBeNull();
  });

  it("prefers an explicit unitIdHint over the truckId default", () => {
    const req = buildEtaLinkMintRequest("EL-1", baseInput({ unitIdHint: 424242 }));
    expect(req.unitIdHint).toBe(424242);
  });
});

describe("etaLinkMint — primary vs fallback selection", () => {
  it("prefers the real Ignition link when present", () => {
    const r = selectTrackingLink({ ignitionUrl: "https://ignition.zonarsystems.com/etaLink/x", fallbackUrl: "https://zoe/track/t" });
    expect(r.source).toBe("ignition");
    expect(r.url).toBe("https://ignition.zonarsystems.com/etaLink/x");
  });

  it("falls back to the /track link when no Ignition link is available", () => {
    const r = selectTrackingLink({ ignitionUrl: null, fallbackUrl: "https://zoe/track/t" });
    expect(r.source).toBe("track");
    expect(r.url).toBe("https://zoe/track/t");
  });

  it("treats an empty-string Ignition url as absent (never a dead link)", () => {
    const r = selectTrackingLink({ ignitionUrl: "", fallbackUrl: "https://zoe/track/t" });
    expect(r.source).toBe("track");
  });
});

function baseInput(over: Partial<EtaLinkMintInput> = {}): EtaLinkMintInput {
  return {
    stopId: "S-1",
    truckId: "E450",
    truckLabel: "Ford E450",
    address: "111 Rockville Pike Rockville, MD 20850",
    lat: 39.085986,
    lng: -77.1494791,
    startISO: "2026-10-05T12:00:00.000Z",
    endISO: "2026-10-05T20:00:00.000Z",
    ...over,
  };
}
