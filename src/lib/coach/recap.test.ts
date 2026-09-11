import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateRecap } from "./recap";
import { chat, llmConfigured } from "@/lib/llm";

vi.mock("@/lib/llm", () => ({
  chat: vi.fn(),
  llmConfigured: vi.fn(),
}));

const mockChat = vi.mocked(chat);
const mockConfigured = vi.mocked(llmConfigured);

beforeEach(() => {
  vi.clearAllMocks();
  mockConfigured.mockReturnValue(true);
});

describe("generateRecap", () => {
  it("returns null when the LLM isn't configured", async () => {
    mockConfigured.mockReturnValue(false);
    expect(await generateRecap({ transcript: "Rep: hi\nCustomer: hello" })).toBeNull();
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("returns null for an empty transcript (no LLM call)", async () => {
    expect(await generateRecap({ transcript: "   " })).toBeNull();
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("parses a well-formed recap and coerces arrays", async () => {
    mockChat.mockResolvedValue({
      ok: true,
      model: "claude-sonnet-5",
      text: JSON.stringify({
        executive: "Customer wants a 40x60 tent for a June 14 wedding, 150 guests.",
        keyPoints: ["150 guests", "June 14", 42, "budget ~$6k"],
        actionItems: ["Send tent + lighting quote by Tuesday"],
        customerConcerns: ["Talking to another vendor"],
        objections: [
          { objection: "Budget is tight, around $6k", response: "Frame reliability as the cost of avoiding a failed setup" },
          { objection: "not-an-object", response: 5 },
          "not an object at all",
        ],
        followUpEmail: "Subject: Your wedding rentals\n\nHi Sam,\n\nGreat talking...",
        coachingNotes: ["When they mentioned the other vendor, you could have asked what matters most to them", 99],
        nextStep: "Send the quote by Tuesday.",
      }),
    });
    const recap = await generateRecap({ transcript: "Rep: hi\nCustomer: we need a tent", direction: "incoming" });
    expect(recap).not.toBeNull();
    expect(recap!.executive).toContain("40x60 tent");
    // Non-string array member (42) is filtered out.
    expect(recap!.keyPoints).toEqual(["150 guests", "June 14", "budget ~$6k"]);
    expect(recap!.actionItems).toEqual(["Send tent + lighting quote by Tuesday"]);
    expect(recap!.customerConcerns).toEqual(["Talking to another vendor"]);
    // Paired objections coerced; the plain-string entry is dropped, the numeric response becomes "".
    expect(recap!.objections).toEqual([
      { objection: "Budget is tight, around $6k", response: "Frame reliability as the cost of avoiding a failed setup" },
      { objection: "not-an-object", response: "" },
    ]);
    expect(recap!.coachingNotes).toEqual(["When they mentioned the other vendor, you could have asked what matters most to them"]);
    expect(recap!.followUpEmail).toContain("Subject:");
    expect(recap!.model).toBe("claude-sonnet-5");
    expect(recap!.generatedAt).toBeTruthy();
  });

  it("strips code fences before parsing", async () => {
    mockChat.mockResolvedValue({
      ok: true,
      text: '```json\n{"executive":"ok","keyPoints":[],"actionItems":[],"customerConcerns":[],"followUpEmail":"x","nextStep":""}\n```',
    });
    const recap = await generateRecap({ transcript: "Rep: hi" });
    expect(recap!.executive).toBe("ok");
    expect(recap!.followUpEmail).toBe("x");
  });

  it("returns null when the model returns an all-empty recap", async () => {
    mockChat.mockResolvedValue({
      ok: true,
      text: JSON.stringify({ executive: "", keyPoints: [], actionItems: [], customerConcerns: [], followUpEmail: "", nextStep: "" }),
    });
    expect(await generateRecap({ transcript: "Rep: hi" })).toBeNull();
  });

  it("returns null when the LLM call fails", async () => {
    mockChat.mockResolvedValue({ ok: false, error: "boom" });
    expect(await generateRecap({ transcript: "Rep: hi" })).toBeNull();
  });

  it("returns null on unparseable output", async () => {
    mockChat.mockResolvedValue({ ok: true, text: "not json at all" });
    expect(await generateRecap({ transcript: "Rep: hi" })).toBeNull();
  });
});
