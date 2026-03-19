import type Database from "better-sqlite3";
import {
  getRules,
  getActiveCoachingInsights,
  getPostTypeTemplate,
  type GenerationRule,
  type CoachingInsight,
} from "../db/generate-queries.js";

export interface AssembledPrompt {
  system: string;
  token_count: number;
  layers: {
    rules: number;
    coaching: number;
    post_type: number;
  };
}

// Rough token estimate: ~4 chars per token for English text
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const TOKEN_BUDGET = 2000;

function formatRulesLayer(rules: GenerationRule[]): string {
  const categories: Record<string, GenerationRule[]> = {};
  for (const rule of rules) {
    if (!categories[rule.category]) categories[rule.category] = [];
    categories[rule.category].push(rule);
  }

  const sections: string[] = [];
  const categoryLabels: Record<string, string> = {
    voice_tone: "Voice & Tone",
    structure_formatting: "Structure & Formatting",
    anti_ai_tropes: "Anti-AI Tropes",
  };

  for (const [cat, catRules] of Object.entries(categories)) {
    // Skip disabled anti-AI tropes
    if (cat === "anti_ai_tropes" && catRules.every((r) => !r.enabled)) continue;
    const activeRules = catRules.filter((r) => r.enabled);
    if (activeRules.length === 0) continue;

    const label = categoryLabels[cat] ?? cat;
    const lines = activeRules.map((r) => {
      let line = `- ${r.rule_text}`;
      if (r.example_text) line += `\n  (${r.example_text})`;
      return line;
    });
    sections.push(`### ${label}\n${lines.join("\n")}`);
  }

  return sections.length > 0 ? `## Writing Rules\n\n${sections.join("\n\n")}` : "";
}

function formatCoachingLayer(insights: CoachingInsight[]): string {
  if (insights.length === 0) return "";
  const lines = insights.map((i) => `- **${i.title}**: ${i.prompt_text}`);
  return `## Coaching Insights\n\n${lines.join("\n")}`;
}

function formatPostTypeLayer(template: string, postType: string): string {
  const labels: Record<string, string> = {
    news: "News Reaction",
    topic: "Topic Exploration",
    insight: "Professional Insight",
  };
  return `## Post Type: ${labels[postType] ?? postType}\n\n${template}`;
}

export function assemblePrompt(
  db: Database.Database,
  postType: "news" | "topic" | "insight",
  storyContext: string
): AssembledPrompt {
  const rules = getRules(db);
  const insights = getActiveCoachingInsights(db);
  const template = getPostTypeTemplate(db, postType);

  const rulesText = formatRulesLayer(rules);
  const coachingText = formatCoachingLayer(insights);
  const postTypeText = template
    ? formatPostTypeLayer(template.template_text, postType)
    : "";

  let rulesTokens = estimateTokens(rulesText);
  let coachingTokens = estimateTokens(coachingText);
  const postTypeTokens = estimateTokens(postTypeText);

  // If over budget, truncate coaching insights (lowest confidence first — here just trim from end)
  const layerTotal = rulesTokens + coachingTokens + postTypeTokens;
  let finalCoachingText = coachingText;
  if (layerTotal > TOKEN_BUDGET && insights.length > 0) {
    const available = TOKEN_BUDGET - rulesTokens - postTypeTokens;
    if (available > 0) {
      // Progressively remove insights from the end until under budget
      let trimmedInsights = [...insights];
      while (estimateTokens(formatCoachingLayer(trimmedInsights)) > available && trimmedInsights.length > 0) {
        trimmedInsights.pop();
      }
      finalCoachingText = formatCoachingLayer(trimmedInsights);
      coachingTokens = estimateTokens(finalCoachingText);
    } else {
      console.warn(`[prompt-assembler] Rules alone (${rulesTokens} tokens) exceed budget (${TOKEN_BUDGET}). Coaching insights omitted.`);
      finalCoachingText = "";
      coachingTokens = 0;
    }
  }

  const system = [
    "You are a LinkedIn post ghostwriter.",
    "",
    rulesText,
    "",
    finalCoachingText,
    "",
    postTypeText,
    "",
    storyContext ? `## Story Context\n\n${storyContext}` : "",
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");

  return {
    system,
    token_count: estimateTokens(system),
    layers: {
      rules: rulesTokens,
      coaching: coachingTokens,
      post_type: postTypeTokens,
    },
  };
}
