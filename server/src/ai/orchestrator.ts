import type Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import BetterSqlite3 from "better-sqlite3";
import path from "path";
import { AiLogger } from "./logger.js";
import { MODELS } from "./client.js";
import { runAnalysis } from "./analyzer.js";
import type { AnalysisResult } from "./analyzer.js";
import { discoverTaxonomy } from "./taxonomy.js";
import { tagPosts } from "./tagger.js";
import { classifyImages } from "./image-classifier.js";
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
          `SELECT id, COALESCE(full_text, content_preview) as content_preview FROM posts WHERE id IN (${untaggedIds.map(() => "?").join(",")})`
        )
        .all(...untaggedIds) as { id: string; content_preview: string | null }[];
      await tagPosts(client, db, posts, logger);
    }

    // Classify unclassified images
    const dataDir = path.dirname(db.name);
    await classifyImages(client, db, dataDir, logger);

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
          `SELECT p.id, COALESCE(p.hook_text, SUBSTR(p.full_text, 1, 100), p.content_preview) as preview,
                  p.published_at, p.url,
                  pm.impressions, pm.reactions, pm.comments, pm.reposts,
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
            preview: string | null;
            published_at: string;
            url: string | null;
            impressions: number;
            reactions: number;
            comments: number;
            reposts: number;
            weighted_score: number;
          }
        | undefined;

      let topPerformerReason: string | null = null;
      if (topPerformer) {
        try {
          const reasonResponse = await client.messages.create({
            model: MODELS.HAIKU,
            max_tokens: 200,
            system: "You write concise, plain-language explanations of why LinkedIn posts performed well. One sentence max.",
            messages: [
              {
                role: "user",
                content: `This LinkedIn post was the top performer in the last 30 days:
Post topic: "${topPerformer.preview ?? "Unknown"}"
Date: ${new Date(topPerformer.published_at).toLocaleDateString()}
Impressions: ${topPerformer.impressions?.toLocaleString() ?? 0}
Comments: ${topPerformer.comments ?? 0}
Reactions: ${topPerformer.reactions ?? 0}

In one sentence, explain why this post resonated with the audience.`,
              },
            ],
          });
          const reasonText = reasonResponse.content
            .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("");
          logger.log({
            step: "top_performer_reason",
            model: MODELS.HAIKU,
            input_messages: JSON.stringify([{ role: "user", content: `[top performer reason for ${topPerformer.id}]` }]),
            output_text: reasonText,
            tool_calls: null,
            input_tokens: reasonResponse.usage.input_tokens,
            output_tokens: reasonResponse.usage.output_tokens,
            thinking_tokens: 0,
            duration_ms: 0,
          });
          topPerformerReason = `"${topPerformer.preview ?? "Post"}" (${new Date(topPerformer.published_at).toLocaleDateString()}) — ${reasonText}`;
        } catch {
          // Fallback to template if LLM call fails
          topPerformerReason = `"${topPerformer.preview ?? "Post"}" (${new Date(topPerformer.published_at).toLocaleDateString()}) — ${topPerformer.impressions?.toLocaleString() ?? 0} impressions, ${topPerformer.comments ?? 0} comments, ${topPerformer.reactions ?? 0} reactions`;
        }
      }

      upsertOverview(db, {
        run_id: runId,
        summary_text: analysis.summary,
        top_performer_post_id: topPerformer?.id ?? null,
        top_performer_reason: topPerformerReason,
        quick_insights: JSON.stringify(
          analysis.insights.slice(0, 5).map((i) => i.claim)
        ),
        prompt_suggestions_json: null,
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
