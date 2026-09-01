import { describe, expect, it } from "vitest";
import {
  SMS_PROVIDERS,
  GPS_PROVIDERS,
  smsProviderById,
  gpsProviderById,
  providerCatalog,
} from "./providers";

describe("provider registry", () => {
  it("has the expected providers", () => {
    expect(SMS_PROVIDERS.map((p) => p.id).sort()).toEqual(["dialpad", "openphone", "ringcentral"]);
    expect(GPS_PROVIDERS.map((p) => p.id).sort()).toEqual(["motive", "samsara", "zonar"]);
  });

  it("falls back to a default for unknown ids", () => {
    expect(smsProviderById("nope").id).toBe("openphone");
    expect(gpsProviderById("nope").id).toBe("zonar");
  });

  it("exposes a client-safe catalog (no functions)", () => {
    const c = providerCatalog();
    expect(c.sms).toHaveLength(3);
    expect(c.gps).toHaveLength(3);
    for (const p of [...c.sms, ...c.gps]) {
      expect(Array.isArray(p.fields)).toBe(true);
      expect(typeof (p as unknown as { send?: unknown }).send).toBe("undefined");
    }
  });
});

describe("unconfigured providers skip, never throw or call out", () => {
  it("SMS send with empty config is skipped", async () => {
    for (const p of SMS_PROVIDERS) {
      const r = await p.send("+13015551234", "hi", {});
      expect(r.ok).toBe(false);
      expect(r.skipped).toBe(true);
    }
  });

  it("server-side GPS getLocation with empty config is skipped", async () => {
    for (const p of GPS_PROVIDERS.filter((g) => g.serverSide)) {
      const r = await p.getLocation("v1", {});
      expect(r.ok).toBe(false);
      expect(r.skipped).toBe(true);
    }
  });

  it("Zonar GPS is not server-side and skips server location", async () => {
    const zonar = gpsProviderById("zonar");
    expect(zonar.serverSide).toBe(false);
    const r = await zonar.getLocation("v1", {});
    expect(r.skipped).toBe(true);
  });
});
