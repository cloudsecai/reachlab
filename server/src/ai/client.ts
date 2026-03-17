import Anthropic from "@anthropic-ai/sdk";

export const MODELS = {
  HAIKU: "anthropic/claude-3.5-haiku",
  SONNET: "anthropic/claude-sonnet-4-6",
  OPUS: "anthropic/claude-opus-4-6",
} as const;

const PROVIDER_PREFS = JSON.stringify({
  order: ["amazon-bedrock", "google-vertex"],
});

export function createClient(apiKey: string): Anthropic {
  if (!apiKey)
    throw new Error("TRUSTMIND_LLM_API_KEY is required for AI features");
  return new Anthropic({
    apiKey,
    baseURL: "https://openrouter.ai/api",
    fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
      // OpenRouter requires Bearer auth and provider routing header
      const headers = new Headers(init?.headers);
      headers.set("X-OpenRouter-Provider", PROVIDER_PREFS);
      const key = headers.get("x-api-key");
      if (key) {
        headers.set("Authorization", `Bearer ${key}`);
        headers.delete("x-api-key");
      }
      return globalThis.fetch(url, { ...init, headers });
    },
  });
}
