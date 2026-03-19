import type Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "./client.js";
import { AiLogger } from "./logger.js";
import type { Draft } from "../db/generate-queries.js";

export interface CombineResult {
  final_draft: string;
  input_tokens: number;
  output_tokens: number;
}

/**
 * Combine 2+ selected drafts into a single final draft using optional guidance.
 * If only 1 draft is selected, returns it as-is (formatted as full text).
 */
export async function combineDrafts(
  client: Anthropic,
  logger: AiLogger,
  drafts: Draft[],
  selectedIndices: number[],
  guidance?: string,
  systemPrompt?: string
): Promise<CombineResult> {
  const selected = selectedIndices.map((i) => drafts[i]).filter(Boolean);

  if (selected.length === 0) {
    throw new Error("No drafts selected for combining");
  }

  // Single draft — just format and return
  if (selected.length === 1) {
    const d = selected[0];
    const fullText = `${d.hook}\n\n${d.body}\n\n${d.closing}`;
    return { final_draft: fullText, input_tokens: 0, output_tokens: 0 };
  }

  // Multiple drafts — combine via LLM
  const draftsText = selected
    .map(
      (d, i) =>
        `--- Draft ${i + 1} (${d.type}) ---\nHook: ${d.hook}\n\nBody:\n${d.body}\n\nClosing: ${d.closing}`
    )
    .join("\n\n");

  const guidanceText = guidance
    ? `\n\nUser guidance for combining: "${guidance}"`
    : "";

  const prompt = `Combine these ${selected.length} LinkedIn post drafts into a single cohesive post. Take the strongest elements from each — the best hook, the most compelling evidence, the sharpest closing.${guidanceText}

${draftsText}

Return the combined post as plain text (no JSON, no markdown headers). Use line breaks between paragraphs.`;

  const start = Date.now();
  const response = await client.messages.create({
    model: MODELS.SONNET,
    max_tokens: 2000,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    messages: [{ role: "user", content: prompt }],
  });

  const duration = Date.now() - start;
  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  logger.log({
    step: "combine",
    model: MODELS.SONNET,
    input_messages: JSON.stringify([{ role: "user", content: prompt }]),
    output_text: text,
    tool_calls: null,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    thinking_tokens: 0,
    duration_ms: duration,
  });

  return {
    final_draft: text.trim(),
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
  };
}
