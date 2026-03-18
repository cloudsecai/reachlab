import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import {
  getRecommendations,
  getRecommendationsWithCooldown,
  getActiveInsights,
  getLatestOverview,
  getAiTags,
  getTaxonomy,
  getChangelog,
  updateRecommendationFeedback,
  resolveRecommendation,
  getRunningRun,
  getLatestAnalysisGaps,
  getLatestPromptSuggestions,
  getProgressMetrics,
  getCategoryPerformance,
  getEngagementQuality,
  getSparklineData,
} from "../db/ai-queries.js";
import { createClient } from "../ai/client.js";
import { runPipeline } from "../ai/orchestrator.js";

export function registerInsightsRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get("/api/insights", async () => ({
    recommendations: getRecommendations(db),
    insights: getActiveInsights(db),
  }));

  app.get("/api/insights/overview", async () => ({
    overview: getLatestOverview(db),
  }));

  app.get("/api/insights/changelog", async () => getChangelog(db));

  app.get("/api/insights/tags", async (request) => {
    const q = request.query as { post_ids?: string };
    const postIds = q.post_ids ? q.post_ids.split(",") : [];
    return { tags: getAiTags(db, postIds) };
  });

  app.get("/api/insights/taxonomy", async () => ({
    taxonomy: getTaxonomy(db),
  }));

  app.post("/api/insights/refresh", async (request, reply) => {
    const apiKey = process.env.TRUSTMIND_LLM_API_KEY;
    if (!apiKey) {
      return reply.status(400).send({ error: "No API key configured. Set TRUSTMIND_LLM_API_KEY." });
    }
    const running = getRunningRun(db);
    if (running) {
      return reply.status(409).send({ error: "Analysis already running", started_at: running.started_at });
    }
    const client = createClient(apiKey);
    const body = request.body as { force?: boolean } | undefined;
    const trigger = body?.force ? "force" : "manual";
    // Fire and forget — don't block the response
    runPipeline(client, db, trigger).catch((err) => {
      console.error("[AI Pipeline] Refresh failed:", err.message);
    });
    return { ok: true, message: "Analysis started" };
  });

  app.post("/api/insights/retag", async (_request, reply) => {
    const apiKey = process.env.TRUSTMIND_LLM_API_KEY;
    if (!apiKey) {
      return reply.status(400).send({ error: "No API key configured. Set TRUSTMIND_LLM_API_KEY." });
    }
    const running = getRunningRun(db);
    if (running) {
      return reply.status(409).send({ error: "Analysis already running", started_at: running.started_at });
    }
    // Clear all tags, topics, and taxonomy to force full regeneration
    db.prepare("DELETE FROM ai_tags").run();
    db.prepare("DELETE FROM ai_post_topics").run();
    db.prepare("DELETE FROM ai_taxonomy").run();
    const client = createClient(apiKey);
    runPipeline(client, db, "retag").catch((err) => {
      console.error("[AI Pipeline] Retag failed:", err.message);
    });
    return { ok: true, message: "Cleared tags and taxonomy, regenerating from scratch" };
  });

  app.patch("/api/insights/recommendations/:id/feedback", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { feedback?: string | { rating: string; reason?: string }; acted_on?: boolean };
    if (!body.feedback && body.acted_on === undefined) {
      return reply.status(400).send({ error: "Provide feedback or acted_on" });
    }
    const rec = db.prepare("SELECT id FROM recommendations WHERE id = ?").get(Number(id));
    if (!rec) {
      return reply.status(404).send({ error: "Recommendation not found" });
    }
    if (body.feedback) {
      // Accept both plain string and JSON object with { rating, reason }
      const feedbackStr = typeof body.feedback === "object"
        ? JSON.stringify(body.feedback)
        : JSON.stringify({ rating: body.feedback, reason: null });
      updateRecommendationFeedback(db, Number(id), feedbackStr);
    }
    if (body.acted_on !== undefined) {
      db.prepare("UPDATE recommendations SET acted_on = ?, acted_on_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(body.acted_on ? 1 : 0, Number(id));
    }
    return { ok: true };
  });

  app.get("/api/insights/logs/:runId", async (request) => {
    const { runId } = request.params as { runId: string };
    return { logs: db.prepare("SELECT * FROM ai_logs WHERE run_id = ? ORDER BY id").all(Number(runId)) };
  });

  app.get("/api/insights/gaps", async () => ({
    gaps: getLatestAnalysisGaps(db),
  }));

  app.get("/api/insights/prompt-suggestions", async () => ({
    prompt_suggestions: getLatestPromptSuggestions(db),
  }));

  // Coach redesign: recommendations with cooldown filtering
  app.get("/api/insights/recommendations", async () => {
    return getRecommendationsWithCooldown(db);
  });

  // Resolve (accept/dismiss) a recommendation
  app.patch("/api/insights/recommendations/:id/resolve", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { type?: "accepted" | "dismissed" };
    if (!body.type || !["accepted", "dismissed"].includes(body.type)) {
      return reply.status(400).send({ error: "Provide type: 'accepted' or 'dismissed'" });
    }
    const rec = db.prepare("SELECT id FROM recommendations WHERE id = ?").get(Number(id));
    if (!rec) {
      return reply.status(404).send({ error: "Recommendation not found" });
    }
    resolveRecommendation(db, Number(id), body.type);
    return { ok: true };
  });

  // Deep Dive: progress metrics
  app.get("/api/insights/deep-dive/progress", async (request) => {
    const q = request.query as { days?: string };
    const days = parseInt(q.days ?? "30", 10) || 30;
    return getProgressMetrics(db, days);
  });

  // Deep Dive: category performance
  app.get("/api/insights/deep-dive/categories", async () => ({
    categories: getCategoryPerformance(db),
  }));

  // Deep Dive: engagement quality
  app.get("/api/insights/deep-dive/engagement", async () => ({
    engagement: getEngagementQuality(db),
  }));

  // Deep Dive: sparkline data (per-post time series)
  app.get("/api/insights/deep-dive/sparkline", async (request) => {
    const q = request.query as { days?: string };
    const days = parseInt(q.days ?? "90", 10) || 90;
    return { points: getSparklineData(db, days) };
  });
}
