import type Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import { MODELS } from "./client.js";
import { AiLogger } from "./logger.js";
import { getRecentTopics, type Story } from "../db/generate-queries.js";

export interface ResearchResult {
  stories: Story[];
  article_count: number;
  source_count: number;
  sources_metadata: Array<{ name: string; url?: string }>;
}

/**
 * Research stories for a given post type.
 * Currently uses LLM to generate story ideas based on the post type and
 * recent topic history (to ensure diversity). External source fetching
 * (HN, Twitter, niche feeds) is stubbed for v1.
 */
export async function researchStories(
  client: Anthropic,
  db: Database.Database,
  logger: AiLogger,
  postType: string
): Promise<ResearchResult> {
  const recentTopics = getRecentTopics(db, 10);
  const recentCategories = recentTopics.map((t) => t.topic_category).filter(Boolean);

  const avoidTopics =
    recentCategories.length > 0
      ? `\n\nAvoid these recently-covered topics: ${[...new Set(recentCategories)].join(", ")}`
      : "";

  const typePrompts: Record<string, string> = {
    news: "Generate 3 compelling news story angles that a tech/business practitioner could write a LinkedIn post about. Stories should be timely, opinionated, and invite practitioner perspective.",
    topic: "Generate 3 professional topic ideas that a practitioner could write a strong LinkedIn post about. Topics should be specific enough to have a sharp take, not broad industry themes.",
    insight: "Generate 3 hard-won professional insight ideas that would make compelling LinkedIn posts. Each should center on a specific lesson learned through direct experience.",
  };

  const prompt = (typePrompts[postType] ?? typePrompts.topic) + avoidTopics;

  const start = Date.now();
  const response = await client.messages.create({
    model: MODELS.SONNET,
    max_tokens: 1500,
    system: "You generate story/topic ideas for LinkedIn posts. Always return valid JSON.",
    messages: [
      {
        role: "user",
        content: `${prompt}

The 3rd story MUST be a "stretch" — from an adjacent but different domain to encourage creative range.

Return JSON:
{
  "stories": [
    {
      "headline": "string — newsreader-style headline",
      "summary": "string — 2-3 sentence summary",
      "source": "string — e.g. 'Industry trend', 'Recent news', 'Practitioner observation'",
      "age": "string — e.g. 'This week', 'Emerging'",
      "tag": "string — topic category",
      "angles": ["string — possible angle 1", "string — possible angle 2"],
      "is_stretch": false
    }
  ]
}

Set is_stretch: true for the 3rd story only.`,
      },
    ],
  });

  const duration = Date.now() - start;
  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  logger.log({
    step: "research",
    model: MODELS.SONNET,
    input_messages: JSON.stringify([{ role: "user", content: prompt }]),
    output_text: text,
    tool_calls: null,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    thinking_tokens: 0,
    duration_ms: duration,
  });

  // Parse the JSON response (strip markdown fences if present)
  const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "");
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Research response did not contain valid JSON");
  }

  const parsed = JSON.parse(jsonMatch[0]) as { stories: Story[] };

  return {
    stories: parsed.stories.slice(0, 3),
    article_count: parsed.stories.length,
    source_count: 1, // LLM-generated for v1
    sources_metadata: [{ name: "AI-generated story ideas" }],
  };
}
