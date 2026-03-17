import type Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { MODELS } from "./client.js";
import type { AiLogger } from "./logger.js";
import { upsertImageTag, getUnclassifiedImagePosts } from "../db/ai-queries.js";

// Valid values for each dimension
const FORMATS = ["photo", "screenshot", "designed-graphic", "chart-or-data", "meme", "slide"] as const;
const PEOPLE = ["author-solo", "author-with-others", "others-only", "no-people"] as const;
const SETTINGS = ["stage-or-event", "office-or-workspace", "casual-or-personal", "digital-only"] as const;
const TEXT_DENSITIES = ["text-heavy", "text-light", "no-text"] as const;
const ENERGIES = ["polished", "raw", "bold", "informational"] as const;

export interface ImageClassification {
  format: string;
  people: string;
  setting: string;
  text_density: string;
  energy: string;
}

export function buildClassifierPrompt(): string {
  return `You are an image classifier for LinkedIn post images. Classify each image along five orthogonal dimensions.

## Format — What kind of image is this?
- photo: Real photograph (camera/phone)
- screenshot: Screen capture (app, tweet, article, DM)
- designed-graphic: Intentionally created visual (quote card, branded graphic)
- chart-or-data: Graph, table, data visualization
- meme: Humor/reaction format
- slide: Presentation-style carousel slide

## People — Who's in it?
- author-solo: The post author only
- author-with-others: Author plus other people
- others-only: People visible but not the author
- no-people: No humans visible

## Setting — What's the context?
- stage-or-event: Speaking, conference, panel, meetup
- office-or-workspace: Professional/work setting
- casual-or-personal: Informal, outdoor, lifestyle
- digital-only: Screenshot, graphic, no physical setting

## Text Density — How much readable text is in the image?
- text-heavy: Text is the primary content
- text-light: Some text/labels, image is primary
- no-text: Purely visual

## Energy — What's the vibe?
- polished: Professional, clean, high production value
- raw: Authentic, unfiltered, casual
- bold: High contrast, attention-grabbing
- informational: Educational, structured, neutral

Return ONLY a JSON object with these five keys. No other text.`;
}

export function parseClassifierResponse(text: string): ImageClassification | null {
  try {
    // Extract JSON from response (may have surrounding text)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    if (
      !parsed.format || !parsed.people || !parsed.setting ||
      !parsed.text_density || !parsed.energy
    ) {
      return null;
    }

    // Validate values
    if (!(FORMATS as readonly string[]).includes(parsed.format)) return null;
    if (!(PEOPLE as readonly string[]).includes(parsed.people)) return null;
    if (!(SETTINGS as readonly string[]).includes(parsed.setting)) return null;
    if (!(TEXT_DENSITIES as readonly string[]).includes(parsed.text_density)) return null;
    if (!(ENERGIES as readonly string[]).includes(parsed.energy)) return null;

    return {
      format: parsed.format,
      people: parsed.people,
      setting: parsed.setting,
      text_density: parsed.text_density,
      energy: parsed.energy,
    };
  } catch {
    return null;
  }
}

/**
 * Classify all unclassified images in the database.
 * Runs as a pipeline step in the orchestrator.
 */
export async function classifyImages(
  client: Anthropic,
  db: Database.Database,
  dataDir: string,
  logger: AiLogger
): Promise<void> {
  const posts = getUnclassifiedImagePosts(db);
  if (posts.length === 0) return;

  // Check for author reference photo
  const authorPhotoPath = path.join(dataDir, "author-reference.jpg");
  const hasAuthorPhoto = fs.existsSync(authorPhotoPath);
  const authorPhotoBase64 = hasAuthorPhoto
    ? fs.readFileSync(authorPhotoPath).toString("base64")
    : null;

  const systemPrompt = buildClassifierPrompt();

  for (const post of posts) {
    const imagePaths: string[] = JSON.parse(post.image_local_paths);

    for (let i = 0; i < imagePaths.length; i++) {
      const fullPath = path.join(dataDir, "images", imagePaths[i]);
      if (!fs.existsSync(fullPath)) continue;

      const imageBase64 = fs.readFileSync(fullPath).toString("base64");
      const content: Anthropic.Messages.ContentBlockParam[] = [];

      // Include author reference photo if available
      if (authorPhotoBase64) {
        content.push({
          type: "text",
          text: "Reference photo of the post author (use this to identify the author in the image below):",
        });
        content.push({
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: authorPhotoBase64 },
        });
      }

      content.push({
        type: "text",
        text: `LinkedIn post image to classify${post.hook_text ? `. Post caption: "${post.hook_text}"` : ""}:`,
      });
      content.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: imageBase64 },
      });

      try {
        const start = Date.now();
        const response = await client.messages.create({
          model: MODELS.HAIKU,
          max_tokens: 256,
          system: systemPrompt,
          messages: [{ role: "user", content }],
        });
        const duration = Date.now() - start;

        const text = response.content
          .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n");

        logger.log({
          step: "image_classification",
          model: MODELS.HAIKU,
          input_messages: JSON.stringify([{ role: "user", content: `[image ${i} for ${post.id}]` }]),
          output_text: text,
          tool_calls: null,
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          thinking_tokens: 0,
          duration_ms: duration,
        });

        const classification = parseClassifierResponse(text);
        if (classification) {
          upsertImageTag(db, {
            post_id: post.id,
            image_index: i,
            ...classification,
            model: MODELS.HAIKU,
          });
        }
      } catch (err) {
        console.error(
          `[Image Classifier] Failed for ${post.id} image ${i}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }
}
