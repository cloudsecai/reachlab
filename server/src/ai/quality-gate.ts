import type Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "./client.js";
import { AiLogger } from "./logger.js";
import type { GenerationRule, CoachingInsight, QualityGate } from "../db/generate-queries.js";

export const QUALITY_GATE_CHECKS = [
  {
    name: "voice_match",
    label: "Voice match",
    prompt: "Does the post sound like the author's established voice? Check against writing rules for tone, specificity, and sentence style.",
  },
  {
    name: "ai_tropes",
    label: "AI tropes",
    prompt: "Check for AI-generated writing patterns: hedge words, correlative constructions, rhetorical questions as filler, meandering intros, recapping conclusions, abstract analysis without stakes, theory before application, opening with context instead of friction.",
  },
  {
    name: "hook_strength",
    label: "Hook strength",
    prompt: "Does the hook open with friction, a claim, or a surprise? Fail if it opens with a question, context dump, historical background, or generic statement.",
  },
  {
    name: "engagement_close",
    label: "Engagement close",
    prompt: "Does the closing question invite informed practitioner responses? Fail if it's a generic opinion question ('What do you think?') or summarizes the post.",
  },
  {
    name: "concrete_specifics",
    label: "Concrete specifics",
    prompt: "Does the post use named tools, specific metrics, real experiences, or concrete examples? Fail if it relies on vague abstractions or generic industry analysis.",
  },
  {
    name: "ending_quality",
    label: "Ending quality",
    prompt: "Does the ending extend the idea forward or provoke new thinking? Fail if it summarizes, recaps, or restates the main point.",
  },
] as const;

/**
 * Run quality gate assessment on a final draft.
 * Checks against writing rules, coaching insights, and anti-AI tropes.
 */
export async function runQualityGate(
  client: Anthropic,
  logger: AiLogger,
  draft: string,
  rules: GenerationRule[],
  insights: CoachingInsight[]
): Promise<QualityGate> {
  const rulesText = rules.map((r) => `- [${r.category}] ${r.rule_text}`).join("\n");
  const insightsText = insights.map((i) => `- ${i.prompt_text}`).join("\n");

  const prompt = `Assess this LinkedIn post draft against the writing rules and coaching insights below.

## Draft
${draft}

## Writing Rules
${rulesText}

## Coaching Insights
${insightsText}

Check each of these quality dimensions and return JSON:
{
  "passed": boolean,  // true if no "warn" checks
  "checks": [
    {
      "name": "voice_match",
      "status": "pass" | "warn",
      "detail": "string — brief explanation"
    },
    {
      "name": "ai_tropes",
      "status": "pass" | "warn",
      "detail": "string — list any detected AI-isms"
    },
    {
      "name": "hook_strength",
      "status": "pass" | "warn",
      "detail": "string — does it open with friction/claim, not a question or context dump?"
    },
    {
      "name": "engagement_close",
      "status": "pass" | "warn",
      "detail": "string — process question vs opinion question"
    },
    {
      "name": "concrete_specifics",
      "status": "pass" | "warn",
      "detail": "string — uses named tools/metrics/experiences vs abstractions"
    },
    {
      "name": "ending_quality",
      "status": "pass" | "warn",
      "detail": "string — extends the idea vs summarizes/recaps"
    }
  ]
}

Be strict. If in doubt, mark as "warn" with specific advice.`;

  const start = Date.now();
  const response = await client.messages.create({
    model: MODELS.SONNET,
    max_tokens: 1000,
    system: "You are a quality assessment engine for LinkedIn posts. Return valid JSON only.",
    messages: [{ role: "user", content: prompt }],
  });

  const duration = Date.now() - start;
  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  logger.log({
    step: "quality_gate",
    model: MODELS.SONNET,
    input_messages: JSON.stringify([{ role: "user", content: prompt }]),
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
    // Fallback: conservative default — can't assess means don't pass
    return {
      passed: false,
      checks: [{ name: "parse_error", status: "warn", detail: "Quality gate response could not be parsed" }],
    };
  }

  const parsed = JSON.parse(jsonMatch[0]) as QualityGate;
  // Recalculate passed based on actual checks
  parsed.passed = parsed.checks.every((c) => c.status === "pass");
  return parsed;
}
