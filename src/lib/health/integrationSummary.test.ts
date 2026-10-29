import { describe, it, expect } from "vitest";
import type { Connection, ConnStatus, ConnCategory } from "@/lib/health/connections";
import {
  connTone, splitConnections, attentionCount, overallTone, summaryHeadline,
} from "@/lib/health/integrationSummary";

function conn(key: string, status: ConnStatus, category: ConnCategory): Connection {
  return {
    key, label: key, category, status,
    headline: status, detail: "", lastAt: null, fixHref: null, fixLabel: null,
  };
}

describe("integration summary — health vs freshness", () => {
  it("maps statuses to Spectrum tones (off/idle are neutral, never broken)", () => {
    expect(connTone("ok")).toBe("positive");
    expect(connTone("attention")).toBe("attention");
    expect(connTone("off")).toBe("neutral");
    expect(connTone("idle")).toBe("neutral");
  });

  it("splits data-pull rows (freshness) from connection-health rows", () => {
    const conns = [
      conn("extension", "ok", "Data pull"),
      conn("routes", "attention", "Data pull"),
      conn("openphone", "ok", "Communications"),
      conn("gps", "off", "GPS"),
    ];
    const { connections, freshness } = splitConnections(conns);
    expect(freshness.map((c) => c.key)).toEqual(["extension", "routes"]);
    expect(connections.map((c) => c.key)).toEqual(["openphone", "gps"]);
  });

  it("counts only attention rows as problems, not off/idle", () => {
    const conns = [
      conn("a", "attention", "Communications"),
      conn("b", "off", "Communications"),
      conn("c", "idle", "GPS"),
      conn("d", "ok", "AI"),
    ];
    expect(attentionCount(conns)).toBe(1);
    expect(overallTone(conns)).toBe("attention");
    expect(summaryHeadline(conns)).toBe("1 needs attention");
  });

  it("headline is positive when everything is connected and neutral when nothing is", () => {
    expect(summaryHeadline([conn("a", "ok", "AI"), conn("b", "ok", "GPS")])).toBe("All systems connected");
    expect(overallTone([conn("a", "ok", "AI")])).toBe("positive");
    expect(summaryHeadline([conn("a", "off", "AI"), conn("b", "idle", "GPS")])).toBe("Nothing connected");
    expect(overallTone([conn("a", "off", "AI")])).toBe("neutral");
  });

  it("pluralises the attention headline", () => {
    const conns = [conn("a", "attention", "AI"), conn("b", "attention", "GPS")];
    expect(summaryHeadline(conns)).toBe("2 need attention");
  });
});
