import { describe, it, expect, vi } from "vitest";
import { interpretStats } from "../ai/analyzer.js";
import type Anthropic from "@anthropic-ai/sdk";

// Minimal mock of AiLogger
const mockLogger = {
  log: vi.fn(),
};

// Mock Anthropic client that returns valid JSON
function makeMockClient(jsonOutput: object): Anthropic {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [
          {
            type: "thinking",
            thinking: "Some thinking...",
          },
          {
            type: "text",
            text: JSON.stringify(jsonOutput),
          },
        ],
        usage: { input_tokens: 100, output_tokens: 200 },
        stop_reason: "end_turn",
      }),
    },
  } as unknown as Anthropic;
}

const validOutput = {
  insights: [
    {
      category: "format",
      stable_key: "image_underperform",
      claim: "Image posts underperform text posts.",
      evidence: "3 image posts averaged 1.8% vs 2.9% for text.",
      confidence: "MODERATE",
      direction: "negative",
    },
  ],
  recommendations: [
    {
      key: "shift_to_text",
      type: "experiment",
      priority: 1,
      confidence: "MODERATE",
      headline: "Test more text-only posts",
      detail: "Text posts averaged 2.9% ER vs 1.8% for images.",
      action: "Publish one text-only post this week.",
    },
  ],
  overview: {
    summary_text: "Your text posts outperform images.",
    quick_insights: ["Text outperforms images"],
  },
  prompt_suggestions: {
    assessment: "working_well",
    reasoning: "Current prompt aligns with data.",
    suggestions: [],
  },
  gaps: [
    {
      type: "data_gap",
      stable_key: "missing_post_content",
      description: "48 posts lack full text.",
      impact: "Cannot analyze writing patterns.",
    },
  ],
};

describe("interpretStats", () => {
  it("calls messages.create once with the stats report as user message", async () => {
    const client = makeMockClient(validOutput);
    const result = await interpretStats(
      client,
      "Stats report content here",
      "System prompt here",
      mockLogger as any
    );
    expect(client.messages.create).toHaveBeenCalledTimes(1);
    const call = (client.messages.create as any).mock.calls[0][0];
    expect(call.messages[0].content).toBe("Stats report content here");
    expect(call.system).toBe("System prompt here");
  });

  it("parses and returns structured JSON from LLM response", async () => {
    const client = makeMockClient(validOutput);
    const result = await interpretStats(client, "report", "system", mockLogger as any);
    expect(result).not.toBeNull();
    expect(result!.insights).toHaveLength(1);
    expect(result!.recommendations).toHaveLength(1);
    expect(result!.insights[0].confidence).toBe("MODERATE");
    expect(result!.gaps).toHaveLength(1);
    expect(result!.prompt_suggestions.assessment).toBe("working_well");
  });

  it("retries once on failure and returns null if both fail", async () => {
    vi.useFakeTimers();
    const client = {
      messages: {
        create: vi.fn().mockRejectedValue(new Error("rate limit")),
      },
    } as unknown as Anthropic;

    const promise = interpretStats(client, "report", "system", mockLogger as any);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;
    vi.useRealTimers();

    expect(result).toBeNull();
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });
});
