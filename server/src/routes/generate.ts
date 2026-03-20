import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type Anthropic from "@anthropic-ai/sdk";
import {
  insertResearch,
  getResearch,
  insertGeneration,
  getGeneration,
  updateGeneration,
  listGenerations,
  insertRevision,
  getRules,
  replaceAllRules,
  seedDefaultRules,
  getActiveCoachingInsights,
  insertCoachingSync,
  getCoachingSync,
  completeCoachingSync,
  insertCoachingChangeLog,
  updateCoachingChangeDecision,
  getCoachingChangeLog,
  getCoachingSyncHistory,
  insertCoachingInsight,
  updateCoachingInsight,
  insertTopicLog,
  getAntiAiTropesEnabled,
  type Story,
  type Draft,
} from "../db/generate-queries.js";
import { createRun, completeRun, failRun } from "../db/ai-queries.js";
import { createClient, MODELS, calculateCostCents } from "../ai/client.js";
import { AiLogger } from "../ai/logger.js";
import { researchStories } from "../ai/researcher.js";
import { generateDrafts } from "../ai/drafter.js";
import { combineDrafts } from "../ai/combiner.js";
import { runQualityGate } from "../ai/quality-gate.js";
import { analyzeCoaching } from "../ai/coaching-analyzer.js";

function getClient(): Anthropic {
  const apiKey = process.env.TRUSTMIND_LLM_API_KEY;
  if (!apiKey) throw new Error("TRUSTMIND_LLM_API_KEY is required");
  return createClient(apiKey);
}

export function registerGenerateRoutes(app: FastifyInstance, db: Database.Database): void {
  // Seed default rules if table is empty (first run)
  const ruleCount = (db.prepare("SELECT COUNT(*) as count FROM generation_rules").get() as any).count;
  if (ruleCount === 0) {
    seedDefaultRules(db);
  }

  // ── Research ─────────────────────────────────────────────

  app.post("/api/generate/research", async (request, reply) => {
    const { post_type } = request.body as { post_type: string };
    if (!["news", "topic", "insight"].includes(post_type)) {
      return reply.status(400).send({ error: "post_type must be news, topic, or insight" });
    }

    const client = getClient();
    const runId = createRun(db, "generate_research", 0);
    const logger = new AiLogger(db, runId);

    try {
      const result = await researchStories(client, db, logger, post_type);

      const researchId = insertResearch(db, {
        post_type,
        stories_json: JSON.stringify(result.stories),
        sources_json: JSON.stringify(result.sources_metadata),
        article_count: result.article_count,
        source_count: result.source_count,
      });

      const logs = db
        .prepare("SELECT model, input_tokens, output_tokens FROM ai_logs WHERE run_id = ?")
        .all(runId) as Array<{ model: string; input_tokens: number; output_tokens: number }>;
      completeRun(db, runId, {
        input_tokens: logs.reduce((s, l) => s + l.input_tokens, 0),
        output_tokens: logs.reduce((s, l) => s + l.output_tokens, 0),
        cost_cents: calculateCostCents(logs),
      });

      return {
        research_id: researchId,
        stories: result.stories,
        article_count: result.article_count,
        source_count: result.source_count,
      };
    } catch (err: any) {
      failRun(db, runId, err.message);
      return reply.status(500).send({ error: err.message });
    }
  });

  // ── Drafts ───────────────────────────────────────────────

  app.post("/api/generate/drafts", async (request, reply) => {
    const { research_id, story_index, post_type } = request.body as {
      research_id: number;
      story_index: number;
      post_type: string;
    };

    if (!["news", "topic", "insight"].includes(post_type)) {
      return reply.status(400).send({ error: "post_type must be news, topic, or insight" });
    }

    const research = getResearch(db, research_id);
    if (!research) {
      return reply.status(404).send({ error: "Research not found" });
    }

    const stories: Story[] = JSON.parse(research.stories_json);
    if (story_index < 0 || story_index >= stories.length) {
      return reply.status(400).send({ error: "Invalid story_index" });
    }

    const client = getClient();
    const runId = createRun(db, "generate_drafts", 0);
    const logger = new AiLogger(db, runId);

    try {
      const result = await generateDrafts(
        client,
        db,
        logger,
        post_type as "news" | "topic" | "insight",
        stories[story_index]
      );

      const generationId = insertGeneration(db, {
        research_id,
        post_type,
        selected_story_index: story_index,
        drafts_json: JSON.stringify(result.drafts),
        prompt_snapshot: result.prompt_snapshot,
      });

      // Log topic for anti-narrowing
      insertTopicLog(db, {
        generation_id: generationId,
        topic_category: stories[story_index].tag,
        was_stretch: stories[story_index].is_stretch,
      });

      const logs = db
        .prepare("SELECT model, input_tokens, output_tokens FROM ai_logs WHERE run_id = ?")
        .all(runId) as Array<{ model: string; input_tokens: number; output_tokens: number }>;
      completeRun(db, runId, {
        input_tokens: result.input_tokens,
        output_tokens: result.output_tokens,
        cost_cents: calculateCostCents(logs),
      });

      return { generation_id: generationId, drafts: result.drafts };
    } catch (err: any) {
      failRun(db, runId, err.message);
      return reply.status(500).send({ error: err.message });
    }
  });

  // ── Combine ──────────────────────────────────────────────

  app.post("/api/generate/combine", async (request, reply) => {
    const { generation_id, selected_drafts, combining_guidance } = request.body as {
      generation_id: number;
      selected_drafts: number[];
      combining_guidance?: string;
    };

    const gen = getGeneration(db, generation_id);
    if (!gen) {
      return reply.status(404).send({ error: "Generation not found" });
    }

    const drafts: Draft[] = gen.drafts_json ? JSON.parse(gen.drafts_json) : [];
    if (drafts.length === 0) {
      return reply.status(400).send({ error: "No drafts available" });
    }

    const invalidIndex = selected_drafts.find((i) => i < 0 || i >= drafts.length);
    if (invalidIndex !== undefined) {
      return reply.status(400).send({ error: `Invalid draft index: ${invalidIndex}` });
    }

    const client = getClient();
    const runId = createRun(db, "generate_combine", 0);
    const logger = new AiLogger(db, runId);

    try {
      const combineResult = await combineDrafts(client, logger, drafts, selected_drafts, combining_guidance, gen.prompt_snapshot ?? undefined);

      // Run quality gate
      const rules = getRules(db);
      const insights = getActiveCoachingInsights(db);
      const qualityGate = await runQualityGate(client, logger, combineResult.final_draft, rules, insights);

      // Save revision if combining happened
      if (selected_drafts.length > 1) {
        insertRevision(db, {
          generation_id,
          action: "combine",
          input_draft: selected_drafts.map((i) => `Draft ${i + 1}`).join(" + "),
          output_draft: combineResult.final_draft,
          quality_gate_json: JSON.stringify(qualityGate),
          input_tokens: combineResult.input_tokens,
          output_tokens: combineResult.output_tokens,
          cost_cents: calculateCostCents([{ model: MODELS.SONNET, input_tokens: combineResult.input_tokens, output_tokens: combineResult.output_tokens }]),
        });
      }

      const genUpdate: Parameters<typeof updateGeneration>[2] = {
        selected_draft_indices: JSON.stringify(selected_drafts),
        final_draft: combineResult.final_draft,
        quality_gate_json: JSON.stringify(qualityGate),
      };
      if (combining_guidance !== undefined) {
        genUpdate.combining_guidance = combining_guidance;
      }
      updateGeneration(db, generation_id, genUpdate);

      const logs = db
        .prepare("SELECT model, input_tokens, output_tokens FROM ai_logs WHERE run_id = ?")
        .all(runId) as Array<{ model: string; input_tokens: number; output_tokens: number }>;
      completeRun(db, runId, {
        input_tokens: logs.reduce((s, l) => s + l.input_tokens, 0),
        output_tokens: logs.reduce((s, l) => s + l.output_tokens, 0),
        cost_cents: calculateCostCents(logs),
      });

      return { final_draft: combineResult.final_draft, quality_gate: qualityGate };
    } catch (err: any) {
      failRun(db, runId, err.message);
      return reply.status(500).send({ error: err.message });
    }
  });

  // ── Revise ───────────────────────────────────────────────

  app.post("/api/generate/revise", async (request, reply) => {
    const { generation_id, action, instruction, edited_draft } = request.body as {
      generation_id: number;
      action: "regenerate" | "shorten" | "strengthen_close" | "custom";
      instruction?: string;
      edited_draft?: string;
    };

    const validActions = ["regenerate", "shorten", "strengthen_close", "custom"];
    if (!validActions.includes(action)) {
      return reply.status(400).send({ error: "action must be one of: regenerate, shorten, strengthen_close, custom" });
    }

    const gen = getGeneration(db, generation_id);
    if (!gen?.final_draft) {
      return reply.status(404).send({ error: "Generation not found or no final draft" });
    }

    const actionPrompts: Record<string, string> = {
      regenerate: "Rewrite this LinkedIn post from scratch, keeping the same core idea but finding a fresher angle and stronger hook.",
      shorten: "Make this LinkedIn post shorter and punchier. Cut anything that doesn't earn its place. Target 20-30% shorter.",
      strengthen_close: "Rewrite just the closing of this LinkedIn post. Make it a sharper question that invites informed disagreement or practitioner reflection.",
      custom: instruction ?? "Improve this post.",
    };

    const client = getClient();
    const runId = createRun(db, "generate_revise", 0);
    const logger = new AiLogger(db, runId);

    try {
      // Use the stored prompt snapshot as system context so revisions respect writing rules
      const systemPrompt = gen.prompt_snapshot ?? "You are a LinkedIn post ghostwriter.";

      const start = Date.now();
      const response = await client.messages.create({
        model: MODELS.SONNET,
        max_tokens: 2000,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: `${actionPrompts[action]}\n\n## Current Draft\n${edited_draft ?? gen.final_draft}\n\nReturn the revised post as plain text only.`,
          },
        ],
      });

      const duration = Date.now() - start;
      const revisedDraft =
        response.content[0].type === "text" ? response.content[0].text.trim() : "";

      logger.log({
        step: `revise_${action}`,
        model: MODELS.SONNET,
        input_messages: JSON.stringify([{ role: "user", content: actionPrompts[action] }]),
        output_text: revisedDraft,
        tool_calls: null,
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        thinking_tokens: 0,
        duration_ms: duration,
      });

      // Re-run quality gate
      const rules = getRules(db);
      const insights = getActiveCoachingInsights(db);
      const qualityGate = await runQualityGate(client, logger, revisedDraft, rules, insights);

      insertRevision(db, {
        generation_id,
        action,
        instruction: action === "custom" ? instruction : undefined,
        input_draft: gen.final_draft,
        output_draft: revisedDraft,
        quality_gate_json: JSON.stringify(qualityGate),
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cost_cents: calculateCostCents([{ model: MODELS.SONNET, input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens }]),
      });

      updateGeneration(db, generation_id, {
        final_draft: revisedDraft,
        quality_gate_json: JSON.stringify(qualityGate),
      });

      const logs = db
        .prepare("SELECT model, input_tokens, output_tokens FROM ai_logs WHERE run_id = ?")
        .all(runId) as Array<{ model: string; input_tokens: number; output_tokens: number }>;
      completeRun(db, runId, {
        input_tokens: logs.reduce((s, l) => s + l.input_tokens, 0),
        output_tokens: logs.reduce((s, l) => s + l.output_tokens, 0),
        cost_cents: calculateCostCents(logs),
      });

      return { final_draft: revisedDraft, quality_gate: qualityGate };
    } catch (err: any) {
      failRun(db, runId, err.message);
      return reply.status(500).send({ error: err.message });
    }
  });

  // ── Rules CRUD ───────────────────────────────────────────

  app.get("/api/generate/rules", async () => {
    const rules = getRules(db);
    const antiAiEnabled = getAntiAiTropesEnabled(db);

    const categories: Record<string, any> = {
      voice_tone: [] as any[],
      structure_formatting: [] as any[],
      anti_ai_tropes: { enabled: antiAiEnabled, rules: [] as any[] },
    };

    for (const rule of rules) {
      const item = { id: rule.id, rule_text: rule.rule_text, example_text: rule.example_text, sort_order: rule.sort_order };
      if (rule.category === "anti_ai_tropes") {
        categories.anti_ai_tropes.rules.push(item);
      } else if (categories[rule.category]) {
        (categories[rule.category] as any[]).push(item);
      }
    }

    return { categories };
  });

  app.put("/api/generate/rules", async (request) => {
    const { categories } = request.body as {
      categories: {
        voice_tone: Array<{ rule_text: string; example_text?: string; sort_order: number }>;
        structure_formatting: Array<{ rule_text: string; example_text?: string; sort_order: number }>;
        anti_ai_tropes: { enabled: boolean; rules: Array<{ rule_text: string; example_text?: string; sort_order: number }> };
      };
    };

    const allRules: Array<{ category: string; rule_text: string; example_text?: string; sort_order: number; enabled?: number }> = [];

    for (const rule of categories.voice_tone) {
      allRules.push({ category: "voice_tone", ...rule });
    }
    for (const rule of categories.structure_formatting) {
      allRules.push({ category: "structure_formatting", ...rule });
    }
    for (const rule of categories.anti_ai_tropes.rules) {
      allRules.push({ category: "anti_ai_tropes", ...rule, enabled: categories.anti_ai_tropes.enabled ? 1 : 0 });
    }

    replaceAllRules(db, allRules);
    return { ok: true };
  });

  app.post("/api/generate/rules/reset", async () => {
    seedDefaultRules(db);
    // Return the freshly-seeded rules in the same shape as GET
    const rules = getRules(db);
    const antiAiEnabled = getAntiAiTropesEnabled(db);
    const categories: Record<string, any> = {
      voice_tone: [] as any[],
      structure_formatting: [] as any[],
      anti_ai_tropes: { enabled: antiAiEnabled, rules: [] as any[] },
    };
    for (const rule of rules) {
      const item = { id: rule.id, rule_text: rule.rule_text, example_text: rule.example_text, sort_order: rule.sort_order };
      if (rule.category === "anti_ai_tropes") {
        categories.anti_ai_tropes.rules.push(item);
      } else if (categories[rule.category]) {
        (categories[rule.category] as any[]).push(item);
      }
    }
    return { categories };
  });

  // ── History ──────────────────────────────────────────────

  app.get("/api/generate/history", async (request) => {
    const q = request.query as { status?: string; offset?: string; limit?: string };
    const result = listGenerations(db, {
      status: q.status,
      offset: q.offset ? Number(q.offset) : undefined,
      limit: q.limit ? Number(q.limit) : undefined,
    });

    const summaries = result.generations.map((g) => {
      const drafts: Draft[] = g.drafts_json ? JSON.parse(g.drafts_json) : [];
      const hookExcerpt = g.final_draft
        ? g.final_draft.substring(0, 80) + (g.final_draft.length > 80 ? "..." : "")
        : drafts[0]?.hook?.substring(0, 80) ?? "";

      // Get story headline from research record
      let storyHeadline = "";
      if (g.research_id && g.selected_story_index !== null) {
        const research = getResearch(db, g.research_id);
        if (research) {
          const stories: Story[] = JSON.parse(research.stories_json);
          storyHeadline = stories[g.selected_story_index]?.headline ?? "";
        }
      }

      return {
        id: g.id,
        hook_excerpt: hookExcerpt,
        story_headline: storyHeadline,
        post_type: g.post_type,
        status: g.status,
        drafts_used: g.selected_draft_indices ? JSON.parse(g.selected_draft_indices).length : 0,
        created_at: g.created_at,
      };
    });

    return { generations: summaries, total: result.total };
  });

  app.get("/api/generate/history/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const gen = getGeneration(db, Number(id));
    if (!gen) {
      return reply.status(404).send({ error: "Generation not found" });
    }
    return gen;
  });

  app.post("/api/generate/history/:id/discard", async (request, reply) => {
    const { id } = request.params as { id: string };
    const gen = getGeneration(db, Number(id));
    if (!gen) {
      return reply.status(404).send({ error: "Generation not found" });
    }
    updateGeneration(db, Number(id), { status: "discarded" });
    return { ok: true };
  });

  // ── Coaching Sync ────────────────────────────────────────

  app.post("/api/generate/coaching/analyze", async (request, reply) => {
    const client = getClient();
    const runId = createRun(db, "coaching_analyze", 0);
    const logger = new AiLogger(db, runId);

    try {
      const result = await analyzeCoaching(client, db, logger);

      const syncId = insertCoachingSync(db, JSON.stringify(result.changes));

      // Create change log entries
      const changes = result.changes.map((change) => {
        const changeId = insertCoachingChangeLog(db, {
          sync_id: syncId,
          insight_id: change.insight_id,
          change_type: change.type,
          old_text: change.old_text,
          new_text: change.new_text,
          evidence: change.evidence,
        });
        return { id: changeId, ...change };
      });

      const logs = db
        .prepare("SELECT model, input_tokens, output_tokens FROM ai_logs WHERE run_id = ?")
        .all(runId) as Array<{ model: string; input_tokens: number; output_tokens: number }>;
      completeRun(db, runId, {
        input_tokens: result.input_tokens,
        output_tokens: result.output_tokens,
        cost_cents: calculateCostCents(logs),
      });

      return { sync_id: syncId, changes };
    } catch (err: any) {
      failRun(db, runId, err.message);
      return reply.status(500).send({ error: err.message });
    }
  });

  app.patch("/api/generate/coaching/changes/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { action, edited_text } = request.body as {
      action: "accept" | "skip" | "retire" | "keep";
      edited_text?: string;
    };

    const changeId = Number(id);

    // Get the change record
    const change = db
      .prepare("SELECT * FROM coaching_change_log WHERE id = ?")
      .get(changeId) as any;
    if (!change) {
      return reply.status(404).send({ error: "Change not found" });
    }

    // Apply the decision
    if (action === "accept") {
      if (change.change_type === "new") {
        insertCoachingInsight(db, {
          title: change.new_text?.substring(0, 50) ?? "New insight",
          prompt_text: edited_text ?? change.new_text ?? "",
          evidence: change.evidence,
          source_sync_id: change.sync_id,
        });
      } else if (change.change_type === "updated" && change.insight_id) {
        updateCoachingInsight(db, change.insight_id, {
          prompt_text: edited_text ?? change.new_text ?? "",
        });
      }
    } else if (action === "retire" && change.insight_id) {
      updateCoachingInsight(db, change.insight_id, {
        status: "retired",
        retired_at: new Date().toISOString(),
      });
    }

    updateCoachingChangeDecision(db, changeId, action);

    // Check if all changes in this sync have been decided — if so, complete the sync
    const allChanges = getCoachingChangeLog(db, change.sync_id);
    const allDecided = allChanges.every((c) => c.decision !== null);
    if (allDecided) {
      const accepted = allChanges.filter((c) => c.decision === "accept" || c.decision === "retire").length;
      const skipped = allChanges.filter((c) => c.decision === "skip" || c.decision === "keep").length;
      completeCoachingSync(db, change.sync_id, JSON.stringify(allChanges.map((c) => ({ id: c.id, decision: c.decision }))), accepted, skipped);
    }

    return { ok: true };
  });

  app.get("/api/generate/coaching/history", async () => {
    const syncs = getCoachingSyncHistory(db);
    return { syncs };
  });

  app.get("/api/generate/coaching/insights", async () => {
    const insights = getActiveCoachingInsights(db);
    return { insights };
  });
}
