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
  // If taxonomy exists, only send untagged posts (incremental update).
  // If no taxonomy, send all posts (full discovery).
  const query = existingTaxonomy && existingTaxonomy.length > 0
    ? `SELECT p.id, COALESCE(SUBSTR(p.full_text, 1, 300), p.content_preview) as summary
       FROM posts p
       LEFT JOIN ai_post_topics apt ON apt.post_id = p.id
       WHERE apt.post_id IS NULL
       ORDER BY p.published_at DESC`
    : `SELECT id, COALESCE(SUBSTR(full_text, 1, 300), content_preview) as summary
       FROM posts ORDER BY published_at DESC`;

  const posts = db.prepare(query).all() as { id: string; summary: string | null }[];

  // If taxonomy exists and no new posts need tagging, skip discovery
  if (existingTaxonomy && existingTaxonomy.length > 0 && posts.length === 0) {
    return existingTaxonomy;
  }

  const postSummaries = posts
    .map(
      (p) => `[${p.id}] ${p.summary ?? "(no content)"}`
    )
    .join("\n");

  const systemPrompt = taxonomyPrompt(postSummaries, existingTaxonomy);

  const start = Date.now();
  const model = MODELS.HAIKU;
  const response = await client.messages.create({
    model,
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
    model,
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
