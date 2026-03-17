import type Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import type { AiLogger } from "./logger.js";
import { MODELS } from "./client.js";
import {
  patternDetectionPrompt,
  hypothesisTestingPrompt,
  synthesisPrompt,
  getTier,
} from "./prompts.js";
import {
  createQueryDbTool,
  createSubmitAnalysisTool,
  executeQueryDb,
} from "./tools.js";
import { getActiveInsights, getPostCountWithMetrics } from "../db/ai-queries.js";

// ── Types ──────────────────────────────────────────────────

export interface RecommendationCandidate {
  key: string;
  type: string;
  priority: string;
  confidence: string;
  headline: string;
  detail: string;
  action: string;
}

export interface AnalysisResult {
  insights: Array<{
    category: string;
    stable_key: string;
    claim: string;
    evidence: string;
    confidence: string;
    direction: string;
  }>;
  recommendations: RecommendationCandidate[];
  summary: string;
}

// ── Pure functions ─────────────────────────────────────────

/**
 * Self-consistency voting: keeps recommendations that appear in 2+ of N runs.
 * For duplicates, picks the version with the longest detail text.
 */
export function voteOnRecommendations(
  runs: RecommendationCandidate[][]
): RecommendationCandidate[] {
  if (runs.length === 0) return [];

  // Count appearances by key and track the best version (longest detail)
  const counts = new Map<string, number>();
  const best = new Map<string, RecommendationCandidate>();

  for (const run of runs) {
    // Deduplicate keys within a single run
    const seen = new Set<string>();
    for (const rec of run) {
      if (seen.has(rec.key)) continue;
      seen.add(rec.key);

      counts.set(rec.key, (counts.get(rec.key) ?? 0) + 1);

      const existing = best.get(rec.key);
      if (!existing || rec.detail.length > existing.detail.length) {
        best.set(rec.key, rec);
      }
    }
  }

  const result: RecommendationCandidate[] = [];
  for (const [key, count] of counts) {
    if (count >= 2) {
      result.push(best.get(key)!);
    }
  }

  return result;
}

// ── Helpers ────────────────────────────────────────────────

async function buildSummary(db: Database.Database): Promise<string> {
  const postCount = getPostCountWithMetrics(db);

  const dateRange = db
    .prepare(
      `SELECT MIN(published_at) as earliest, MAX(published_at) as latest
       FROM posts`
    )
    .get() as { earliest: string | null; latest: string | null };

  const avgEngagement = db
    .prepare(
      `SELECT
         AVG(pm.impressions) as avg_impressions,
         AVG(pm.reactions) as avg_reactions,
         AVG(pm.comments) as avg_comments,
         AVG(pm.reposts) as avg_reposts
       FROM post_metrics pm
       JOIN (SELECT post_id, MAX(id) as max_id FROM post_metrics GROUP BY post_id) latest
         ON pm.id = latest.max_id`
    )
    .get() as {
    avg_impressions: number | null;
    avg_reactions: number | null;
    avg_comments: number | null;
    avg_reposts: number | null;
  };

  const followerRow = db
    .prepare(
      `SELECT total_followers FROM follower_snapshots
       ORDER BY date DESC LIMIT 1`
    )
    .get() as { total_followers: number } | undefined;

  return [
    `Posts with metrics: ${postCount}`,
    `Date range: ${dateRange.earliest ?? "N/A"} to ${dateRange.latest ?? "N/A"}`,
    `Avg impressions: ${Math.round(avgEngagement.avg_impressions ?? 0)}`,
    `Avg reactions: ${Math.round(avgEngagement.avg_reactions ?? 0)}`,
    `Avg comments: ${Math.round(avgEngagement.avg_comments ?? 0)}`,
    `Avg reposts: ${Math.round(avgEngagement.avg_reposts ?? 0)}`,
    `Current followers: ${followerRow?.total_followers ?? "N/A"}`,
  ].join("\n");
}

// ── Agentic loop ───────────────────────────────────────────

const MAX_TURNS = 15;

export async function runAgentLoop(
  client: Anthropic,
  db: Database.Database,
  queryDb: Database.Database,
  systemPrompt: string,
  userMessage: string,
  logger: AiLogger,
  step: string
): Promise<AnalysisResult | null> {
  const tools = [createQueryDbTool(), createSubmitAnalysisTool()];
  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  let captured: AnalysisResult | null = null;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const start = Date.now();
    const response = await client.messages.create({
      model: MODELS.SONNET,
      max_tokens: 8192,
      system: systemPrompt,
      tools,
      messages,
    });
    const duration = Date.now() - start;

    // Extract text from response for logging
    const outputText = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use"
    );

    logger.log({
      step,
      model: MODELS.SONNET,
      input_messages: JSON.stringify(messages),
      output_text: outputText,
      tool_calls: toolUseBlocks.length > 0 ? JSON.stringify(toolUseBlocks) : null,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      thinking_tokens: 0,
      duration_ms: duration,
    });

    // Push assistant message
    messages.push({ role: "assistant", content: response.content });

    // Process tool calls
    if (toolUseBlocks.length > 0) {
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        if (toolUse.name === "query_db") {
          const input = toolUse.input as { sql: string };
          const result = executeQueryDb(queryDb, input.sql);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: result,
          });
        } else if (toolUse.name === "submit_analysis") {
          const input = toolUse.input as {
            insights: AnalysisResult["insights"];
            recommendations: RecommendationCandidate[];
            overview: { summary_text: string };
          };
          captured = {
            insights: input.insights,
            recommendations: input.recommendations,
            summary: input.overview.summary_text,
          };
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: "Analysis submitted successfully.",
          });
        }
      }

      messages.push({ role: "user", content: toolResults });

      if (captured) break;
    } else if (response.stop_reason === "end_turn") {
      break;
    }
  }

  return captured;
}

// ── Main analysis runner ───────────────────────────────────

export async function runAnalysis(
  client: Anthropic,
  db: Database.Database,
  queryDb: Database.Database,
  logger: AiLogger
): Promise<AnalysisResult | null> {
  const summary = await buildSummary(db);
  const postCount = getPostCountWithMetrics(db);
  const tier = getTier(postCount);

  // Stage 1: Pattern detection
  const stage1System = patternDetectionPrompt(summary, tier);
  const stage1Result = await runAgentLoop(
    client,
    db,
    queryDb,
    stage1System,
    "Analyze the data and identify patterns. Use query_db to explore, then submit_analysis with your findings.",
    logger,
    "pattern_detection"
  );

  if (!stage1Result) return null;

  // Stage 2: Hypothesis testing
  const activeInsights = getActiveInsights(db);
  const previousInsightsText =
    activeInsights.length > 0
      ? activeInsights
          .map(
            (i: { stable_key: string; claim: string; confidence: number }) =>
              `- [${i.stable_key}] ${i.claim} (confidence: ${i.confidence})`
          )
          .join("\n")
      : "No previous insights.";

  const stage2System = hypothesisTestingPrompt(
    stage1Result.summary,
    previousInsightsText
  );
  const stage2Result = await runAgentLoop(
    client,
    db,
    queryDb,
    stage2System,
    "Test the hypotheses from Stage 1. Use query_db to validate, then submit_analysis with refined findings.",
    logger,
    "hypothesis_testing"
  );

  if (!stage2Result) return stage1Result;

  // Stage 3: Synthesis × 3 runs with self-consistency voting
  const feedbackHistory = ""; // TODO: pull from recommendation feedback
  const stage3System = synthesisPrompt(stage2Result.summary, feedbackHistory);

  const synthesisRuns: RecommendationCandidate[][] = [];
  let finalResult: AnalysisResult | null = null;

  for (let i = 0; i < 3; i++) {
    const result = await runAgentLoop(
      client,
      db,
      queryDb,
      stage3System,
      "Synthesize findings into actionable insights and recommendations. Use query_db if needed, then submit_analysis.",
      logger,
      `synthesis_${i + 1}`
    );
    if (result) {
      synthesisRuns.push(result.recommendations);
      finalResult = result;
    }
  }

  // Apply self-consistency voting to recommendations
  if (finalResult && synthesisRuns.length > 0) {
    finalResult.recommendations = voteOnRecommendations(synthesisRuns);
  }

  return finalResult;
}
