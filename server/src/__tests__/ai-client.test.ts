import { describe, it, expect } from "vitest";
import { createClient, MODELS } from "../ai/client.js";

describe("AI client", () => {
  it("exports MODELS constants", () => {
    expect(MODELS.HAIKU).toBe("anthropic/claude-3.5-haiku");
    expect(MODELS.SONNET).toBe("anthropic/claude-sonnet-4-6");
    expect(MODELS.OPUS).toBe("anthropic/claude-opus-4-6");
  });

  it("creates a client with a valid key", () => {
    const client = createClient("test-key-123");
    expect(client).toBeDefined();
    expect(client).toHaveProperty("messages");
  });

  it("throws if empty API key", () => {
    expect(() => createClient("")).toThrow(
      "TRUSTMIND_LLM_API_KEY is required for AI features"
    );
  });
});
