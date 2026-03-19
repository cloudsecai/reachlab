import type Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import { MODELS } from "./client.js";
import { AiLogger } from "./logger.js";
import {
  getRules,
  getActiveCoachingInsights,
  type CoachingInsight,
} from "../db/generate-queries.js";

export interface CoachingChangeProposal {
  type: "new" | "updated" | "retire";
  title: string;
  evidence: string;
  old_text?: string;
  new_text?: string;
  insight_id?: number;
}

export interface CoachingAnalysisResult {
  changes: CoachingChangeProposal[];
  input_tokens: number;
  output_tokens: number;
}

/**
 * Analyze the full prompt (rules + insights) and recent post performance
 * to propose coaching changes. Enforces incremental honing: max 20% change,
 * conflict detection, redundancy checks.
 */
export async function analyzeCoaching(
  client: Anthropic,
  db: Database.Database,
  logger: AiLogger
): Promise<CoachingAnalysisResult> {
  const rules = getRules(db);
  const insights = getActiveCoachingInsights(db);

  // Get recent generation performance for context
  const recentGens = db
    .prepare(
      `SELECT g.id, g.final_draft, g.quality_gate_json, g.status, g.created_at
       FROM generations g
       WHERE g.final_draft IS NOT NULL
       ORDER BY g.created_at DESC LIMIT 10`
    )
    .all() as Array<{ id: number; final_draft: string; quality_gate_json: string | null; status: string; created_at: string }>;

  const rulesText = rules.map((r) => `- [${r.category}] ${r.rule_text}`).join("\n");
  const insightsText = insights.length > 0
    ? insights.map((i) => `- [ID:${i.id}] "${i.title}": ${i.prompt_text}`).join("\n")
    : "(none yet)";
  const performanceText = recentGens.length > 0
    ? recentGens.map((g) => {
        const qg = g.quality_gate_json ? JSON.parse(g.quality_gate_json) : null;
        const warnings = qg?.checks?.filter((c: any) => c.status === "warn")?.length ?? 0;
        return `- Gen #${g.id} (${g.status}): ${warnings} quality warnings`;
      }).join("\n")
    : "(no recent generations)";

  const prompt = `You are a coaching system for a LinkedIn post ghostwriter. Review the current prompt configuration and recent performance to propose targeted improvements.

## Current Writing Rules
${rulesText}

## Current Coaching Insights (max 8 active)
${insightsText}

## Recent Generation Performance
${performanceText}

## Constraints
- Max 3 changes per sync
- Never rewrite > 20% of the total prompt
- Check for: redundancy between rules and insights, conflicting instructions, vague/unfalsifiable claims, token bloat
- New insights must not duplicate existing rules
- Consider retiring insights that are naturally followed (no longer needed as explicit instruction)

Propose changes as JSON:
{
  "changes": [
    {
      "type": "new" | "updated" | "retire",
      "title": "string — short label",
      "evidence": "string — why this change",
      "old_text": "string | null — for updated/retire, the current text",
      "new_text": "string | null — for new/updated, the proposed text",
      "insight_id": "number or null — for updated/retire, the ID to modify"
    }
  ]
}

Return at most 3 changes. If nothing needs changing, return {"changes": []}.`;

  const start = Date.now();
  const response = await client.messages.create({
    model: MODELS.SONNET,
    max_tokens: 1500,
    system: "You are a prompt coaching system. Return valid JSON only.",
    messages: [{ role: "user", content: prompt }],
  });

  const duration = Date.now() - start;
  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  logger.log({
    step: "coaching_analyze",
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
    return { changes: [], input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens };
  }

  const parsed = JSON.parse(jsonMatch[0]) as { changes: CoachingChangeProposal[] };

  return {
    changes: parsed.changes.slice(0, 3),
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
  };
}
