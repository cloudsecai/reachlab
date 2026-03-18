import type Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { AiLogger } from "./logger.js";
import { MODELS } from "./client.js";
import { interpretStats } from "./analyzer.js";
import { buildStatsReport } from "./stats-report.js";
import { buildSystemPrompt, buildTopPerformerPrompt } from "./prompts.js";
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
  getSetting,
  upsertAnalysisGap,
  getRecentFeedbackWithReasons,
} from "../db/ai-queries.js";

// ── Types ──────────────────────────────────────────────────

export interface PipelineResult {
  runId: number;
  status: "completed" | "failed";
  error?: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  const running = getRunningRun(db);
  if (running) {
    return { runId: running.id, status: "failed", error: "A pipeline run is already in progress" };
  }

  const postCount = getPostCountWithMetrics(db);
  // Skip threshold check for retag/force triggers
  if (triggeredBy !== "retag" && triggeredBy !== "force") {
    const lastRun = getLatestCompletedRun(db);
    const check = shouldRunPipeline(postCount, lastRun ? { post_count: lastRun.post_count } : null);
    if (!check.should) {
      return { runId: 0, status: "failed", error: check.reason };
    }
  }

  const runId = createRun(db, triggeredBy, postCount);
  const logger = new AiLogger(db, runId);

  try {
    // Step 1: Taxonomy and tagging
    // Always run taxonomy discovery — it evolves existing topics and adds new ones
    const existingTaxonomy = getTaxonomy(db);
    await discoverTaxonomy(client, db, logger, existingTaxonomy.length > 0 ? existingTaxonomy : undefined);
    const untaggedIds = getUntaggedPostIds(db);
    if (untaggedIds.length > 0) {
      const posts = db
        .prepare(
          `SELECT id, COALESCE(full_text, content_preview) as content_preview
           FROM posts WHERE id IN (${untaggedIds.map(() => "?").join(",")})`
        )
        .all(...untaggedIds) as { id: string; content_preview: string | null }[];
      await tagPosts(client, db, posts, logger);
    }

    // Step 2: Image classification (kept)
    const dataDir = path.dirname(db.name);
    await classifyImages(client, db, dataDir, logger);

    // Step 3: Build stats report
    const timezone = getSetting(db, "timezone") ?? "UTC";
    const writingPrompt = getSetting(db, "writing_prompt");
    const statsReport = buildStatsReport(db, timezone, writingPrompt);

    // Step 4: Build system prompt (read knowledge base from file)
    const knowledgePath = path.join(__dirname, "linkedin-knowledge.md");
    const knowledgeBase = fs.existsSync(knowledgePath)
      ? fs.readFileSync(knowledgePath, "utf-8")
      : "(knowledge base not found)";

    const feedbackRows = getRecentFeedbackWithReasons(db);
    const feedbackHistory =
      feedbackRows.length > 0
        ? feedbackRows
            .map((f) => {
              const reason = f.reason ? ` because: "${f.reason}"` : "";
              return `- The user found "${f.headline}" ${
                f.feedback === "useful" ? "useful" : "not useful"
              }${reason}`;
            })
            .join("\n")
        : "No feedback history yet.";

    const systemPrompt = buildSystemPrompt(knowledgeBase, feedbackHistory);

    // Step 5: Single Sonnet interpretation call
    const analysis = await interpretStats(client, statsReport, systemPrompt, logger);

    if (analysis) {
      // Store insights with lineage
      const activeInsights = getActiveInsights(db);
      const activeByKey = new Map(
        activeInsights.map((i: any) => [i.stable_key, i])
      );
      const matchedKeys = new Set<string>();

      for (const insight of analysis.insights) {
        const existing = activeByKey.get(insight.stable_key) as any;
        const newInsightId = insertInsight(db, {
          run_id: runId,
          category: insight.category,
          stable_key: insight.stable_key,
          claim: insight.claim,
          evidence: insight.evidence,
          confidence: insight.confidence,
          direction: insight.direction,
          first_seen_run_id: existing ? existing.first_seen_run_id : runId,
          consecutive_appearances: existing ? existing.consecutive_appearances + 1 : 1,
        });
        if (existing) {
          matchedKeys.add(insight.stable_key);
          insertInsightLineage(
            db,
            newInsightId,
            existing.id,
            existing.direction !== insight.direction &&
              ["positive", "negative"].includes(existing.direction) &&
              ["positive", "negative"].includes(insight.direction)
              ? "reversal"
              : "continuation"
          );
          retireInsight(db, existing.id);
        }
      }
      for (const [key, insight] of activeByKey) {
        if (!matchedKeys.has(key)) retireInsight(db, (insight as any).id);
      }

      // Store recommendations
      for (const rec of analysis.recommendations) {
        insertRecommendation(db, {
          run_id: runId,
          type: rec.type,
          priority: rec.priority,
          confidence: rec.confidence,
          headline: rec.headline,
          detail: rec.detail,
          action: rec.action,
          evidence_json: "[]",
        });
      }

      // Store gaps
      for (const gap of analysis.gaps ?? []) {
        upsertAnalysisGap(db, {
          run_id: runId,
          gap_type: gap.type,
          stable_key: gap.stable_key,
          description: gap.description,
          impact: gap.impact,
        });
      }

      // Step 6: Determine top performer deterministically (highest ER in last 30 days)
      const topPerformer = db
        .prepare(
          `SELECT p.id,
                  COALESCE(p.hook_text, SUBSTR(p.full_text, 1, 100), p.content_preview) as preview,
                  p.published_at, p.url,
                  pm.impressions, pm.reactions, pm.comments, pm.reposts,
                  CAST((COALESCE(pm.reactions,0) + COALESCE(pm.comments,0) + COALESCE(pm.reposts,0)) AS REAL)
                    / NULLIF(pm.impressions, 0) * 100 as er
           FROM posts p
           JOIN post_metrics pm ON pm.post_id = p.id
           JOIN (SELECT post_id, MAX(id) as max_id FROM post_metrics GROUP BY post_id) latest
             ON pm.id = latest.max_id
           WHERE p.published_at >= datetime('now', '-30 days')
             AND pm.impressions > 0
           ORDER BY er DESC LIMIT 1`
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
            er: number;
          }
        | undefined;

      // Step 7: Haiku call for top performer reason with comparisons
      let topPerformerReason: string | null = null;
      if (topPerformer) {
        // Fetch similar posts by content type for comparison
        const similarPosts = db
          .prepare(
            `SELECT COALESCE(p.hook_text, SUBSTR(p.full_text, 1, 80), p.content_preview) as preview,
                    pm.impressions, pm.reactions, pm.comments, pm.reposts, p.content_type,
                    CAST((COALESCE(pm.reactions,0) + COALESCE(pm.comments,0) + COALESCE(pm.reposts,0)) AS REAL)
                      / NULLIF(pm.impressions, 0) * 100 as er
             FROM posts p
             JOIN post_metrics pm ON pm.post_id = p.id
             JOIN (SELECT post_id, MAX(id) as max_id FROM post_metrics GROUP BY post_id) latest
               ON pm.id = latest.max_id
             WHERE p.content_type = ? AND p.id != ? AND pm.impressions > 0
             ORDER BY p.published_at DESC LIMIT 5`
          )
          .all(topPerformer.preview ? "video" : topPerformer.preview, topPerformer.id) as any[];

        // Actually query by the top performer's content type
        const comparisons = db
          .prepare(
            `SELECT COALESCE(p.hook_text, SUBSTR(p.full_text, 1, 80), p.content_preview) as preview,
                    pm.impressions, p.content_type,
                    CAST((COALESCE(pm.reactions,0) + COALESCE(pm.comments,0) + COALESCE(pm.reposts,0)) AS REAL)
                      / NULLIF(pm.impressions, 0) * 100 as er
             FROM posts p
             JOIN post_metrics pm ON pm.post_id = p.id
             JOIN (SELECT post_id, MAX(id) as max_id FROM post_metrics GROUP BY post_id) latest
               ON pm.id = latest.max_id
             WHERE p.content_type = (SELECT content_type FROM posts WHERE id = ?)
               AND p.id != ? AND pm.impressions > 0
             ORDER BY pm.impressions DESC LIMIT 5`
          )
          .all(topPerformer.id, topPerformer.id) as { preview: string; impressions: number; er: number; contentType: string }[];

        const topPerformerContentType = (db
          .prepare("SELECT content_type FROM posts WHERE id = ?")
          .get(topPerformer.id) as { content_type: string } | undefined)?.content_type ?? "post";

        try {
          const reasonResponse = await client.messages.create({
            model: MODELS.HAIKU,
            max_tokens: 300,
            system:
              "You write concise, plain-language explanations of why LinkedIn posts performed well. 2-3 sentences max. No filler phrases.",
            messages: [
              {
                role: "user",
                content: buildTopPerformerPrompt(
                  topPerformer.preview ?? "Unknown post",
                  new Date(topPerformer.published_at).toLocaleDateString(),
                  topPerformer.impressions,
                  topPerformer.comments,
                  topPerformerContentType,
                  comparisons.map((c) => ({
                    preview: c.preview ?? "Untitled",
                    impressions: c.impressions,
                    er: c.er ?? 0,
                    contentType: c.contentType ?? topPerformerContentType,
                  }))
                ),
              },
            ],
          });
          const reasonText = (reasonResponse.content as any[])
            .filter((b) => b.type === "text")
            .map((b) => (b as any).text)
            .join("");
          logger.log({
            step: "top_performer_reason",
            model: MODELS.HAIKU,
            input_messages: JSON.stringify([{ role: "user", content: "[top performer prompt]" }]),
            output_text: reasonText,
            tool_calls: null,
            input_tokens: reasonResponse.usage.input_tokens,
            output_tokens: reasonResponse.usage.output_tokens,
            thinking_tokens: 0,
            duration_ms: 0,
          });
          topPerformerReason = `"${topPerformer.preview ?? "Post"}" (${new Date(
            topPerformer.published_at
          ).toLocaleDateString()}) — ${reasonText}`;
        } catch {
          topPerformerReason = `"${topPerformer.preview ?? "Post"}" (${new Date(
            topPerformer.published_at
          ).toLocaleDateString()}) — ${topPerformer.impressions?.toLocaleString() ?? 0} impressions`;
        }
      }

      // Step 8: Store overview
      upsertOverview(db, {
        run_id: runId,
        summary_text: analysis.overview.summary_text,
        top_performer_post_id: topPerformer?.id ?? null,
        top_performer_reason: topPerformerReason,
        quick_insights: JSON.stringify(analysis.overview.quick_insights),
        prompt_suggestions_json: analysis.prompt_suggestions
          ? JSON.stringify(analysis.prompt_suggestions)
          : null,
      });
    }

    // Sum tokens from ai_logs for this run
    const tokenSums = db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens), 0) as input_tokens,
                COALESCE(SUM(output_tokens), 0) as output_tokens
         FROM ai_logs WHERE run_id = ?`
      )
      .get(runId) as { input_tokens: number; output_tokens: number };

    completeRun(db, runId, {
      input_tokens: tokenSums.input_tokens,
      output_tokens: tokenSums.output_tokens,
      cost_cents: 0,
    });

    return { runId, status: "completed" };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    failRun(db, runId, message);
    return { runId, status: "failed", error: message };
  }
}
