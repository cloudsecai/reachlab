import type Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import { MODELS } from "./client.js";
import { AiLogger } from "./logger.js";
import { assemblePrompt } from "./prompt-assembler.js";
import type { Story, Draft } from "../db/generate-queries.js";

export interface DraftResult {
  drafts: Draft[];
  prompt_snapshot: string;
  input_tokens: number;
  output_tokens: number;
}

const VARIATION_INSTRUCTIONS: Record<string, string> = {
  contrarian:
    "Write a CONTRARIAN variation. Challenge the obvious take. Lead with what most people get wrong about this topic. Be specific about why the conventional wisdom fails.",
  operator:
    "Write an OPERATOR variation. Ground everything in direct, hands-on experience. Use specific numbers, tools, timelines. Write as someone who has done the work, not observed it.",
  future:
    "Write a FUTURE-FACING variation. Extrapolate from this story to what it means 2-5 years out. Make a specific prediction grounded in the current evidence. Be bold but defensible.",
};

/**
 * Generate 3 draft variations (contrarian, operator, future-facing) for a selected story.
 */
export async function generateDrafts(
  client: Anthropic,
  db: Database.Database,
  logger: AiLogger,
  postType: "news" | "topic" | "insight",
  story: Story
): Promise<DraftResult> {
  const storyContext = `**${story.headline}**\n${story.summary}\nSource: ${story.source} | ${story.age}\nPossible angles: ${story.angles.join("; ")}`;
  const assembled = assemblePrompt(db, postType, storyContext);

  const draftPromises = Object.entries(VARIATION_INSTRUCTIONS).map(
    async ([variationType, instruction]): Promise<{ draft: Draft; input_tokens: number; output_tokens: number }> => {
      const start = Date.now();
      const response = await client.messages.create({
        model: MODELS.SONNET,
        max_tokens: 2000,
        system: assembled.system,
        messages: [
          {
            role: "user",
            content: `${instruction}

Return JSON:
{
  "hook": "string — the opening 1-2 sentences that stop the scroll",
  "body": "string — the main content, use \\n for line breaks",
  "closing": "string — the closing question or reflection",
  "word_count": number,
  "structure_label": "string — brief description like 'Contrarian take with personal evidence'"
}`,
          },
        ],
      });

      const duration = Date.now() - start;
      const text =
        response.content[0].type === "text" ? response.content[0].text : "";

      logger.log({
        step: `draft_${variationType}`,
        model: MODELS.SONNET,
        input_messages: JSON.stringify([{ role: "user", content: instruction }]),
        output_text: text,
        tool_calls: null,
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        thinking_tokens: 0,
        duration_ms: duration,
      });

      const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "");
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error(`Draft ${variationType} response did not contain valid JSON`);
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        draft: {
          type: variationType as Draft["type"],
          hook: parsed.hook,
          body: parsed.body,
          closing: parsed.closing,
          word_count: parsed.word_count ?? 0,
          structure_label: parsed.structure_label ?? variationType,
        },
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      };
    }
  );

  const results = await Promise.all(draftPromises);
  const drafts = results.map((r) => r.draft);
  const totalInput = results.reduce((sum, r) => sum + r.input_tokens, 0);
  const totalOutput = results.reduce((sum, r) => sum + r.output_tokens, 0);

  return {
    drafts,
    prompt_snapshot: assembled.system,
    input_tokens: totalInput,
    output_tokens: totalOutput,
  };
}
