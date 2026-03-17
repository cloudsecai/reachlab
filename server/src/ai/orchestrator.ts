import type Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import BetterSqlite3 from "better-sqlite3";
import { AiLogger } from "./logger.js";
import { runAnalysis } from "./analyzer.js";
import type { AnalysisResult } from "./analyzer.js";
import { discoverTaxonomy } from "./taxonomy.js";
import { tagPosts } from "./tagger.js";
import {
  createRun,
  completeRun,
  failRun,
  getRunningRun,
  getLatestCompletedRun,
  getTaxonomy,
  getUntaggedPostIds,
  getActiveInsights,
  insertInsight,
  insertInsightLineage,
  retireInsight,
  insertRecommendation,
  upsertOverview,
  getPostCountWithMetrics,
} from "../db/ai-queries.js";

// ── Types ──────────────────────────────────────────────────

export interface PipelineResult {
  runId: number;
  status: "completed" | "failed";
  error?: string;
}

// ── Pure functions ─────────────────────────────────────────

export function shouldRunPipeline(
  currentPostCount: number,
  lastRun: { post_count: number } | null
): { should: boolean; reason?: string } {
  if (currentPostCount < 10) {
    return { should: false, reason: "Need at least 10 posts with metrics" };
  }

  if (!lastRun) {
    return { should: true };
  }

  const newPosts = currentPostCount - lastRun.post_count;
  if (newPosts < 3) {
    return { should: false, reason: "Fewer than 3 new posts since last analysis" };
  }

  return { should: true };
}

// ── Pipeline ───────────────────────────────────────────────

export async function runPipeline(
  client: Anthropic,
  db: Database.Database,
  triggeredBy: string
): Promise<PipelineResult> {
  // Check for already running run
  const running = getRunningRun(db);
  if (running) {
    return {
      runId: running.id,
      status: "failed",
      error: "A pipeline run is already in progress",
    };
  }

  // Check if we should run
  const postCount = getPostCountWithMetrics(db);
  const lastRun = getLatestCompletedRun(db);
  const check = shouldRunPipeline(
    postCount,
    lastRun ? { post_count: lastRun.post_count } : null
  );
  if (!check.should) {
    return { runId: 0, status: "failed", error: check.reason };
  }

  // Create run
  const runId = createRun(db, triggeredBy, postCount);
  const logger = new AiLogger(db, runId);

  try {
    // Ensure taxonomy exists
    const taxonomy = getTaxonomy(db);
    if (taxonomy.length === 0) {
      await discoverTaxonomy(client, db, logger);
    }

    // Tag untagged posts
    const untaggedIds = getUntaggedPostIds(db);
    if (untaggedIds.length > 0) {
      const posts = db
        .prepare(
          `SELECT id, content_preview FROM posts WHERE id IN (${untaggedIds.map(() => "?").join(",")})`
        )
        .all(...untaggedIds) as { id: string; content_preview: string | null }[];
      await tagPosts(client, db, posts, logger);
    }

    // Open read-only connection for LLM query tool (safety: prevents writes)
    const queryDb = new BetterSqlite3(db.name, { readonly: true });
    try {
    // Run analysis
    const analysis = await runAnalysis(client, db, queryDb, logger);

    if (analysis) {
      // Process insights with lineage
      const activeInsights = getActiveInsights(db);
      const activeByKey = new Map(
        activeInsights.map((i: { id: number; stable_key: string; first_seen_run_id: number; consecutive_appearances: number }) => [
          i.stable_key,
          i,
        ])
      );

      const matchedKeys = new Set<string>();

      for (const insight of analysis.insights) {
        const existing = activeByKey.get(insight.stable_key) as
          | { id: number; first_seen_run_id: number; consecutive_appearances: number }
          | undefined;

        const newInsightId = insertInsight(db, {
          run_id: runId,
          category: insight.category,
          stable_key: insight.stable_key,
          claim: insight.claim,
          evidence: insight.evidence,
          confidence: typeof insight.confidence === "string"
            ? parseFloat(insight.confidence) || 0.5
            : (insight.confidence as unknown as number),
          direction: insight.direction,
          first_seen_run_id: existing ? existing.first_seen_run_id : runId,
          consecutive_appearances: existing
            ? existing.consecutive_appearances + 1
            : 1,
        });

        if (existing) {
          matchedKeys.add(insight.stable_key);
          insertInsightLineage(
            db,
            newInsightId,
            existing.id,
            insight.direction === "reversed" ? "reversal" : "continuation"
          );
          retireInsight(db, existing.id);
        }
      }

      // Retire unmatched active insights
      for (const [key, insight] of activeByKey) {
        if (!matchedKeys.has(key)) {
          retireInsight(db, (insight as { id: number }).id);
        }
      }

      // Store recommendations
      for (const rec of analysis.recommendations) {
        insertRecommendation(db, {
          run_id: runId,
          type: rec.type,
          priority: typeof rec.priority === "string"
            ? (rec.priority === "high" ? 1 : rec.priority === "med" ? 2 : 3)
            : (rec.priority as unknown as number),
          confidence: typeof rec.confidence === "string"
            ? (rec.confidence === "strong" ? 0.9 : rec.confidence === "mod" ? 0.7 : 0.5)
            : (rec.confidence as unknown as number),
          headline: rec.headline,
          detail: rec.detail,
          action: rec.action,
          evidence_json: "[]",
        });
      }

      // Generate overview — find top performer
      const topPerformer = db
        .prepare(
          `SELECT p.id, p.content_preview, pm.impressions,
            (COALESCE(pm.comments,0)*5 + COALESCE(pm.reposts,0)*3 + COALESCE(pm.saves,0)*3 + COALESCE(pm.sends,0)*3 + COALESCE(pm.reactions,0)*1) as weighted_score
          FROM posts p
          JOIN post_metrics pm ON pm.post_id = p.id
          JOIN (SELECT post_id, MAX(id) as max_id FROM post_metrics GROUP BY post_id) latest ON pm.id = latest.max_id
          WHERE p.published_at >= datetime('now', '-30 days')
          ORDER BY weighted_score DESC LIMIT 1`
        )
        .get() as
        | {
            id: string;
            content_preview: string | null;
            impressions: number;
            weighted_score: number;
          }
        | undefined;

      upsertOverview(db, {
        run_id: runId,
        summary_text: analysis.summary,
        top_performer_post_id: topPerformer?.id ?? null,
        top_performer_reason: topPerformer
          ? `Weighted engagement score: ${topPerformer.weighted_score}`
          : null,
        quick_insights: JSON.stringify(
          analysis.insights.slice(0, 5).map((i) => i.claim)
        ),
      });
    }

    // Sum tokens from ai_logs for this run
    const tokenSums = db
      .prepare(
        `SELECT
           COALESCE(SUM(input_tokens), 0) as input_tokens,
           COALESCE(SUM(output_tokens), 0) as output_tokens
         FROM ai_logs WHERE run_id = ?`
      )
      .get(runId) as { input_tokens: number; output_tokens: number };

    completeRun(db, runId, {
      input_tokens: tokenSums.input_tokens,
      output_tokens: tokenSums.output_tokens,
      cost_cents: 0, // Cost calculation can be added later
    });

    return { runId, status: "completed" };
    } finally {
      queryDb.close();
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    failRun(db, runId, message);
    return { runId, status: "failed", error: message };
  }
}
