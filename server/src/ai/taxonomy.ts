import type Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import type { AiLogger } from "./logger.js";
import { MODELS } from "./client.js";
import { taxonomyPrompt } from "./prompts.js";
import { upsertTaxonomy } from "../db/ai-queries.js";

/**
 * Discover content taxonomy by sending all post summaries to the LLM.
 * Parses the JSON response and upserts taxonomy entries into the database.
 */
export async function discoverTaxonomy(
  client: Anthropic,
  db: Database.Database,
  logger: AiLogger,
  existingTaxonomy?: { name: string; description: string }[]
): Promise<{ name: string; description: string }[]> {
  // Gather all posts with content previews
  const posts = db
    .prepare(
      "SELECT id, content_preview FROM posts ORDER BY published_at DESC"
    )
    .all() as { id: string; content_preview: string | null }[];

  const postSummaries = posts
    .map(
      (p) => `[${p.id}] ${p.content_preview ?? "(no content)"}`
    )
    .join("\n");

  const systemPrompt = taxonomyPrompt(postSummaries, existingTaxonomy);

  const start = Date.now();
  const response = await client.messages.create({
    model: MODELS.OPUS,
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content:
          "Analyze these posts and return the taxonomy as a JSON array.",
      },
    ],
    system: systemPrompt,
  });
  const duration = Date.now() - start;

  const outputText =
    response.content[0].type === "text" ? response.content[0].text : "";

  logger.log({
    step: "taxonomy_discovery",
    model: MODELS.OPUS,
    input_messages: JSON.stringify([
      { role: "user", content: "(post summaries)" },
    ]),
    output_text: outputText,
    tool_calls: null,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    thinking_tokens: 0,
    duration_ms: duration,
  });

  // Strip markdown code fences if present
  let cleaned = outputText.trim();
  const fenceMatch = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  const taxonomy = JSON.parse(cleaned) as {
    name: string;
    description: string;
  }[];

  upsertTaxonomy(db, taxonomy);

  return taxonomy;
}
