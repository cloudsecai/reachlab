import type Anthropic from "@anthropic-ai/sdk";
import type { AiLogger } from "./logger.js";
import { MODELS } from "./client.js";

// ── Output schema type ─────────────────────────────────────

export interface AnalysisOutputSchema {
  insights: Array<{
    category: string;
    stable_key: string;
    claim: string;
    evidence: string;
    confidence: string;
    direction: string;
  }>;
  recommendations: Array<{
    key: string;
    type: string;
    priority: number;
    confidence: string;
    headline: string;
    detail: string;
    action: string;
  }>;
  overview: {
    summary_text: string;
    quick_insights: string[];
  };
  prompt_suggestions: {
    assessment: "working_well" | "suggest_changes";
    reasoning: string;
    suggestions: Array<{
      current: string;
      suggested: string;
      evidence: string;
    }>;
  };
  gaps: Array<{
    type: "data_gap" | "tool_gap" | "knowledge_gap";
    stable_key: string;
    description: string;
    impact: string;
  }>;
}

// ── Main export ────────────────────────────────────────────

export async function interpretStats(
  client: Anthropic,
  statsReport: string,
  systemPrompt: string,
  logger: AiLogger
): Promise<AnalysisOutputSchema | null> {
  const makeCall = async (): Promise<AnalysisOutputSchema> => {
    const start = Date.now();
    const response = await client.messages.create({
      model: MODELS.SONNET,
      max_tokens: 16000,
      thinking: { type: "enabled", budget_tokens: 10000 },
      system: systemPrompt,
      messages: [{ role: "user", content: statsReport }],
    } as any); // 'thinking' param requires SDK ≥ 0.20; cast to satisfy older type definitions
    const duration = Date.now() - start;

    const textBlock = (response.content as any[])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    logger.log({
      step: "interpretation",
      model: MODELS.SONNET,
      input_messages: JSON.stringify([{ role: "user", content: "[stats report]" }]),
      output_text: textBlock.slice(0, 2000), // truncate for log storage
      tool_calls: null,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      thinking_tokens: 0,
      duration_ms: duration,
    });

    // The prompt instructs the model to output raw JSON (no fences).
    // Try raw parse first, then strip markdown fences if present.
    let parsed: AnalysisOutputSchema;
    try {
      parsed = JSON.parse(textBlock);
    } catch {
      const match = textBlock.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (!match) throw new Error("LLM response is not valid JSON");
      parsed = JSON.parse(match[1]!);
    }

    return parsed;
  };

  try {
    return await makeCall();
  } catch (err) {
    // Retry once after 5 seconds
    await new Promise((resolve) => setTimeout(resolve, 5000));
    try {
      return await makeCall();
    } catch {
      logger.log({
        step: "interpretation_failed",
        model: MODELS.SONNET,
        input_messages: "{}",
        output_text: err instanceof Error ? err.message : String(err),
        tool_calls: null,
        input_tokens: 0,
        output_tokens: 0,
        thinking_tokens: 0,
        duration_ms: 0,
      });
      return null;
    }
  }
}
