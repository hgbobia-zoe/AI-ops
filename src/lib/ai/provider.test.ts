import { describe, expect, it, beforeEach } from "vitest";
import {
  AI_PROVIDERS,
  aiProviderById,
  activeAiProviderId,
  setActiveAiProvider,
  aiProviderCatalog,
  aiConfigured,
  runAi,
  bridgeConnected,
  setBridgeConnected,
} from "./provider";

// These run against the in-memory DB (settings table backs kv). No network: with no ANTHROPIC_API_KEY /
// LLM_BASE_URL set, the llm adapter reports not-configured without calling out.
describe("AIProvider registry", () => {
  beforeEach(() => {
    // default state each test
    setActiveAiProvider("session-bridge");
    setBridgeConnected(false);
  });

  it("registers exactly the three adapters", () => {
    expect(AI_PROVIDERS.map((p) => p.id).sort()).toEqual(["llm", "remote-control", "session-bridge"]);
  });

  it("defaults to the session-bridge and falls back to it for an unknown id", () => {
    expect(activeAiProviderId()).toBe("session-bridge");
    expect(aiProviderById("nope").id).toBe("session-bridge");
  });

  it("selects an active provider and reflects it in the catalog", () => {
    setActiveAiProvider("llm");
    expect(activeAiProviderId()).toBe("llm");
    const cat = aiProviderCatalog();
    expect(cat.find((p) => p.id === "llm")?.active).toBe(true);
    expect(cat.find((p) => p.id === "session-bridge")?.active).toBe(false);
  });

  it("session-bridge defers: runAi returns skipped, never a fabricated answer", async () => {
    const r = await runAi({ prompt: "interpret these facts", context: { a: 1 } });
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe(true);
    expect(r.provider).toBe("session-bridge");
  });

  it("bridge-connected flag round-trips and changes the test outcome", () => {
    expect(bridgeConnected()).toBe(false);
    setBridgeConnected(true);
    expect(bridgeConnected()).toBe(true);
  });

  it("llm adapter is skipped (not errored) when no key is configured", async () => {
    setActiveAiProvider("llm");
    expect(aiConfigured()).toBe(false); // no ANTHROPIC_API_KEY / LLM_BASE_URL in the test env
    const r = await runAi({ prompt: "x" });
    expect(r.skipped).toBe(true);
    expect(r.provider).toBe("llm");
  });

  it("aiConfigured is false for a deferred provider (session-bridge)", () => {
    setActiveAiProvider("session-bridge");
    expect(aiConfigured()).toBe(false);
  });
});
