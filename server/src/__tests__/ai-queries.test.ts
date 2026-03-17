import { describe, it, expect, beforeEach, afterAll } from "vitest";
import Database from "better-sqlite3";
import { initDatabase } from "../db/index.js";
import { upsertPost, insertPostMetrics } from "../db/queries.js";
import {
  createRun,
  completeRun,
  failRun,
  getRunningRun,
  getLatestCompletedRun,
  upsertTaxonomy,
  getTaxonomy,
  setPostTopics,
  getPostTopics,
  upsertAiTag,
  getAiTags,
  getUntaggedPostIds,
  insertInsight,
  getActiveInsights,
  retireInsight,
  insertInsightLineage,
  insertRecommendation,
  getRecommendations,
  updateRecommendationFeedback,
  upsertOverview,
  getLatestOverview,
  insertAiLog,
  getChangelog,
  getPostCountWithMetrics,
  getPostCountSinceRun,
  upsertImageTag,
  getImageTags,
  getUnclassifiedImagePosts,
  getSetting,
  upsertSetting,
  saveWritingPromptHistory,
  getWritingPromptHistory,
  upsertAnalysisGap,
  getLatestAnalysisGaps,
  getLatestPromptSuggestions,
} from "../db/ai-queries.js";
import fs from "fs";
import path from "path";

const TEST_DB_PATH = path.join(
  import.meta.dirname,
  "../../data/test-ai-queries.db"
);

let db: Database.Database;

function seedPost(id: string, publishedAt?: string) {
  upsertPost(db, {
    id,
    content_type: "text",
    published_at: publishedAt ?? "2025-01-01T12:00:00Z",
  });
}

function seedPostWithMetrics(id: string, impressions: number) {
  seedPost(id);
  insertPostMetrics(db, { post_id: id, impressions, reactions: 5 });
}

describe("AI queries", () => {
  beforeEach(() => {
    // Fresh DB for each test
    try {
      if (db) db.close();
    } catch {}
    try {
      fs.unlinkSync(TEST_DB_PATH);
      fs.unlinkSync(TEST_DB_PATH + "-wal");
      fs.unlinkSync(TEST_DB_PATH + "-shm");
    } catch {}
    db = initDatabase(TEST_DB_PATH);
  });

  afterAll(() => {
    try {
      db.close();
    } catch {}
    try {
      fs.unlinkSync(TEST_DB_PATH);
      fs.unlinkSync(TEST_DB_PATH + "-wal");
      fs.unlinkSync(TEST_DB_PATH + "-shm");
    } catch {}
  });

  // ── ai_runs ──────────────────────────────────────────────

  describe("ai_runs", () => {
    it("createRun returns an id", () => {
      const id = createRun(db, "manual", 10);
      expect(id).toBeTypeOf("number");
      expect(id).toBeGreaterThan(0);
    });

    it("getRunningRun returns a running run", () => {
      const id = createRun(db, "manual", 5);
      const running = getRunningRun(db);
      expect(running).not.toBeNull();
      expect(running!.id).toBe(id);
    });

    it("getRunningRun returns null when no running run", () => {
      expect(getRunningRun(db)).toBeNull();
    });

    it("completeRun sets status and tokens", () => {
      const id = createRun(db, "manual", 5);
      completeRun(db, id, {
        input_tokens: 1000,
        output_tokens: 500,
        cost_cents: 0.25,
      });
      const running = getRunningRun(db);
      expect(running).toBeNull();
      const completed = getLatestCompletedRun(db);
      expect(completed).not.toBeNull();
      expect(completed!.id).toBe(id);
      expect(completed!.status).toBe("completed");
    });

    it("failRun sets status and error", () => {
      const id = createRun(db, "manual", 5);
      failRun(db, id, "something broke");
      const running = getRunningRun(db);
      expect(running).toBeNull();
      const row = db
        .prepare("SELECT status, error FROM ai_runs WHERE id = ?")
        .get(id) as any;
      expect(row.status).toBe("failed");
      expect(row.error).toBe("something broke");
    });

    it("getLatestCompletedRun returns null when none exist", () => {
      expect(getLatestCompletedRun(db)).toBeNull();
    });

    it("getLatestCompletedRun returns most recent completed", () => {
      const id1 = createRun(db, "manual", 5);
      completeRun(db, id1, {
        input_tokens: 100,
        output_tokens: 50,
        cost_cents: 0.1,
      });
      const id2 = createRun(db, "manual", 8);
      completeRun(db, id2, {
        input_tokens: 200,
        output_tokens: 100,
        cost_cents: 0.2,
      });
      const latest = getLatestCompletedRun(db);
      expect(latest!.id).toBe(id2);
      expect(latest!.post_count).toBe(8);
    });
  });

  // ── ai_taxonomy ──────────────────────────────────────────

  describe("ai_taxonomy", () => {
    it("upsertTaxonomy inserts items", () => {
      upsertTaxonomy(db, [
        { name: "Leadership", description: "Leadership posts" },
        { name: "Technical", description: "Technical posts" },
      ]);
      const items = getTaxonomy(db);
      expect(items).toHaveLength(2);
      expect(items.map((i) => i.name)).toContain("Leadership");
    });

    it("upsertTaxonomy updates on conflict", () => {
      upsertTaxonomy(db, [
        { name: "Leadership", description: "Old desc" },
      ]);
      upsertTaxonomy(db, [
        { name: "Leadership", description: "New desc" },
      ]);
      const items = getTaxonomy(db);
      expect(items).toHaveLength(1);
      expect(items[0].description).toBe("New desc");
    });

    it("getTaxonomy returns empty array when no items", () => {
      expect(getTaxonomy(db)).toEqual([]);
    });
  });

  // ── ai_post_topics ──────────────────────────────────────

  describe("ai_post_topics", () => {
    it("setPostTopics and getPostTopics round-trip", () => {
      seedPost("p1");
      upsertTaxonomy(db, [
        { name: "Leadership", description: "L" },
        { name: "Technical", description: "T" },
      ]);
      const taxonomy = getTaxonomy(db);
      const ids = taxonomy.map((t) => t.id);
      setPostTopics(db, "p1", ids);
      const topics = getPostTopics(db, "p1");
      expect(topics).toHaveLength(2);
      expect(topics).toContain("Leadership");
      expect(topics).toContain("Technical");
    });

    it("setPostTopics replaces existing topics", () => {
      seedPost("p1");
      upsertTaxonomy(db, [
        { name: "A", description: "a" },
        { name: "B", description: "b" },
        { name: "C", description: "c" },
      ]);
      const taxonomy = getTaxonomy(db);
      setPostTopics(
        db,
        "p1",
        taxonomy.map((t) => t.id)
      );
      // Now replace with just one
      setPostTopics(db, "p1", [taxonomy[2].id]);
      const topics = getPostTopics(db, "p1");
      expect(topics).toHaveLength(1);
      expect(topics[0]).toBe("C");
    });

    it("getPostTopics returns empty for untagged post", () => {
      seedPost("p1");
      expect(getPostTopics(db, "p1")).toEqual([]);
    });
  });

  // ── ai_tags ──────────────────────────────────────────────

  describe("ai_tags", () => {
    it("upsertAiTag creates and retrieves a tag", () => {
      seedPost("p1");
      upsertAiTag(db, {
        post_id: "p1",
        hook_type: "question",
        tone: "professional",
        format_style: "list",
        model: "claude-3",
      });
      const tags = getAiTags(db, ["p1"]);
      expect(tags["p1"]).toBeDefined();
      expect(tags["p1"].hook_type).toBe("question");
      expect(tags["p1"].tone).toBe("professional");
    });

    it("upsertAiTag updates on conflict", () => {
      seedPost("p1");
      upsertAiTag(db, {
        post_id: "p1",
        hook_type: "question",
        tone: "professional",
        format_style: "list",
        model: "claude-3",
      });
      upsertAiTag(db, {
        post_id: "p1",
        hook_type: "story",
        tone: "casual",
        format_style: "paragraph",
        model: "claude-4",
      });
      const tags = getAiTags(db, ["p1"]);
      expect(tags["p1"].hook_type).toBe("story");
      expect(tags["p1"].model).toBe("claude-4");
    });

    it("getAiTags returns empty record for no matches", () => {
      const tags = getAiTags(db, ["nonexistent"]);
      expect(Object.keys(tags)).toHaveLength(0);
    });

    it("getAiTags handles multiple post ids", () => {
      seedPost("p1");
      seedPost("p2");
      upsertAiTag(db, {
        post_id: "p1",
        hook_type: "question",
        tone: "pro",
        format_style: "list",
        model: "m",
      });
      upsertAiTag(db, {
        post_id: "p2",
        hook_type: "story",
        tone: "casual",
        format_style: "para",
        model: "m",
      });
      const tags = getAiTags(db, ["p1", "p2"]);
      expect(Object.keys(tags)).toHaveLength(2);
    });

    it("getUntaggedPostIds returns posts without ai_tags", () => {
      seedPost("p1");
      seedPost("p2");
      upsertAiTag(db, {
        post_id: "p1",
        hook_type: "q",
        tone: "t",
        format_style: "f",
        model: "m",
      });
      const untagged = getUntaggedPostIds(db);
      expect(untagged).toEqual(["p2"]);
    });

    it("getUntaggedPostIds returns empty when all tagged", () => {
      seedPost("p1");
      upsertAiTag(db, {
        post_id: "p1",
        hook_type: "q",
        tone: "t",
        format_style: "f",
        model: "m",
      });
      expect(getUntaggedPostIds(db)).toEqual([]);
    });
  });

  // ── ai_image_tags ──────────────────────────────────────────

  describe("ai_image_tags", () => {
    it("upsertImageTag inserts and retrieves image tags", () => {
      db.prepare("INSERT INTO posts (id, content_type) VALUES ('img-test-1', 'image')").run();

      upsertImageTag(db, {
        post_id: "img-test-1",
        image_index: 0,
        format: "photo",
        people: "author-solo",
        setting: "casual-or-personal",
        text_density: "no-text",
        energy: "raw",
        model: "haiku",
      });

      const tags = getImageTags(db, ["img-test-1"]);
      expect(tags["img-test-1"]).toHaveLength(1);
      expect(tags["img-test-1"][0].format).toBe("photo");
      expect(tags["img-test-1"][0].people).toBe("author-solo");
    });

    it("getUnclassifiedImagePosts returns posts with images but no tags", () => {
      db.prepare(
        "INSERT INTO posts (id, content_type, image_local_paths) VALUES ('unclass-1', 'image', '[\"data/images/unclass-1/0.jpg\"]')"
      ).run();
      db.prepare(
        "INSERT INTO posts (id, content_type, image_local_paths) VALUES ('unclass-2', 'image', '[\"data/images/unclass-2/0.jpg\"]')"
      ).run();
      // Tag one of them
      upsertImageTag(db, {
        post_id: "unclass-2",
        image_index: 0,
        format: "photo",
        people: "no-people",
        setting: "digital-only",
        text_density: "no-text",
        energy: "polished",
        model: "haiku",
      });

      const unclassified = getUnclassifiedImagePosts(db);
      const ids = unclassified.map((p) => p.id);
      expect(ids).toContain("unclass-1");
      expect(ids).not.toContain("unclass-2");
    });
  });

  // ── insights ─────────────────────────────────────────────

  describe("insights", () => {
    it("insertInsight and getActiveInsights", () => {
      const runId = createRun(db, "manual", 5);
      const id = insertInsight(db, {
        run_id: runId,
        category: "content",
        stable_key: "key-1",
        claim: "Lists perform well",
        evidence: "3 of top 5 are lists",
        confidence: 0.85,
        direction: "positive",
        first_seen_run_id: runId,
      });
      expect(id).toBeGreaterThan(0);
      const active = getActiveInsights(db);
      expect(active).toHaveLength(1);
      expect(active[0].claim).toBe("Lists perform well");
    });

    it("retireInsight removes from active", () => {
      const runId = createRun(db, "manual", 5);
      const id = insertInsight(db, {
        run_id: runId,
        category: "content",
        stable_key: "key-1",
        claim: "Old insight",
        evidence: "ev",
        confidence: 0.5,
        direction: "neutral",
        first_seen_run_id: runId,
      });
      retireInsight(db, id);
      const active = getActiveInsights(db);
      expect(active).toHaveLength(0);
    });

    it("insertInsightLineage creates lineage record", () => {
      const runId = createRun(db, "manual", 5);
      const id1 = insertInsight(db, {
        run_id: runId,
        category: "c",
        stable_key: "k1",
        claim: "first",
        evidence: "e",
        confidence: 0.5,
        direction: "neutral",
        first_seen_run_id: runId,
      });
      const id2 = insertInsight(db, {
        run_id: runId,
        category: "c",
        stable_key: "k1",
        claim: "evolved",
        evidence: "e2",
        confidence: 0.7,
        direction: "positive",
        first_seen_run_id: runId,
      });
      insertInsightLineage(db, id2, id1, "confirmed");
      const row = db
        .prepare(
          "SELECT * FROM insight_lineage WHERE insight_id = ? AND predecessor_id = ?"
        )
        .get(id2, id1) as any;
      expect(row).toBeDefined();
      expect(row.relationship).toBe("confirmed");
    });
  });

  // ── recommendations ──────────────────────────────────────

  describe("recommendations", () => {
    it("insertRecommendation and getRecommendations", () => {
      const runId = createRun(db, "manual", 5);
      completeRun(db, runId, {
        input_tokens: 100,
        output_tokens: 50,
        cost_cents: 0.1,
      });
      const id = insertRecommendation(db, {
        run_id: runId,
        type: "content",
        priority: 1,
        confidence: 0.9,
        headline: "Post more lists",
        detail: "List posts get 2x engagement",
        action: "Create a list post this week",
        evidence_json: JSON.stringify(["post1", "post2"]),
      });
      expect(id).toBeGreaterThan(0);
      const recs = getRecommendations(db);
      expect(recs).toHaveLength(1);
      expect(recs[0].headline).toBe("Post more lists");
    });

    it("getRecommendations with explicit runId", () => {
      const runId = createRun(db, "manual", 5);
      insertRecommendation(db, {
        run_id: runId,
        type: "timing",
        priority: 2,
        confidence: 0.7,
        headline: "Post on Tuesdays",
        detail: "d",
        action: "a",
        evidence_json: "[]",
      });
      const recs = getRecommendations(db, runId);
      expect(recs).toHaveLength(1);
    });

    it("getRecommendations returns empty when no run exists", () => {
      expect(getRecommendations(db)).toEqual([]);
    });

    it("updateRecommendationFeedback stores feedback", () => {
      const runId = createRun(db, "manual", 5);
      const id = insertRecommendation(db, {
        run_id: runId,
        type: "content",
        priority: 1,
        confidence: 0.9,
        headline: "h",
        detail: "d",
        action: "a",
        evidence_json: "[]",
      });
      updateRecommendationFeedback(db, id, "helpful");
      const row = db
        .prepare("SELECT feedback, feedback_at FROM recommendations WHERE id = ?")
        .get(id) as any;
      expect(row.feedback).toBe("helpful");
      expect(row.feedback_at).not.toBeNull();
    });
  });

  // ── ai_overview ──────────────────────────────────────────

  describe("ai_overview", () => {
    it("upsertOverview and getLatestOverview", () => {
      seedPost("top-post");
      const runId = createRun(db, "manual", 5);
      completeRun(db, runId, {
        input_tokens: 100,
        output_tokens: 50,
        cost_cents: 0.1,
      });
      upsertOverview(db, {
        run_id: runId,
        summary_text: "Good week overall",
        top_performer_post_id: "top-post",
        top_performer_reason: "Highest engagement",
        quick_insights: JSON.stringify(["insight1", "insight2"]),
        prompt_suggestions_json: null,
      });
      const overview = getLatestOverview(db);
      expect(overview).not.toBeNull();
      expect(overview!.summary_text).toBe("Good week overall");
      expect(overview!.top_performer_post_id).toBe("top-post");
    });

    it("getLatestOverview returns null when empty", () => {
      expect(getLatestOverview(db)).toBeNull();
    });

    it("upsertOverview replaces for same run_id", () => {
      seedPost("top-post");
      const runId = createRun(db, "manual", 5);
      completeRun(db, runId, {
        input_tokens: 100,
        output_tokens: 50,
        cost_cents: 0.1,
      });
      upsertOverview(db, {
        run_id: runId,
        summary_text: "First",
        top_performer_post_id: "top-post",
        top_performer_reason: "r",
        quick_insights: "[]",
        prompt_suggestions_json: null,
      });
      upsertOverview(db, {
        run_id: runId,
        summary_text: "Updated",
        top_performer_post_id: "top-post",
        top_performer_reason: "r2",
        quick_insights: "[]",
        prompt_suggestions_json: null,
      });
      const overview = getLatestOverview(db);
      expect(overview!.summary_text).toBe("Updated");
    });
  });

  // ── ai_logs ──────────────────────────────────────────────

  describe("ai_logs", () => {
    it("insertAiLog creates a log entry", () => {
      const runId = createRun(db, "manual", 5);
      insertAiLog(db, {
        run_id: runId,
        step: "tagging",
        model: "claude-3",
        input_messages: JSON.stringify([{ role: "user", content: "hi" }]),
        output_text: "response",
        tool_calls: null,
        input_tokens: 50,
        output_tokens: 25,
        thinking_tokens: 0,
        duration_ms: 1200,
      });
      const row = db
        .prepare("SELECT * FROM ai_logs WHERE run_id = ?")
        .get(runId) as any;
      expect(row).toBeDefined();
      expect(row.step).toBe("tagging");
      expect(row.input_tokens).toBe(50);
    });
  });

  // ── helpers ──────────────────────────────────────────────

  describe("helpers", () => {
    it("getPostCountWithMetrics counts posts that have metrics", () => {
      seedPostWithMetrics("p1", 100);
      seedPostWithMetrics("p2", 200);
      seedPost("p3"); // no metrics
      expect(getPostCountWithMetrics(db)).toBe(2);
    });

    it("getPostCountWithMetrics returns 0 when no metrics", () => {
      seedPost("p1");
      expect(getPostCountWithMetrics(db)).toBe(0);
    });

    it("getPostCountSinceRun counts posts published after run completion", () => {
      // Create and complete a run
      const runId = createRun(db, "manual", 2);
      completeRun(db, runId, {
        input_tokens: 10,
        output_tokens: 5,
        cost_cents: 0.01,
      });
      // The run was completed "now", so a post published in the future counts
      upsertPost(db, {
        id: "future-post",
        content_type: "text",
        published_at: "2099-01-01T00:00:00Z",
      });
      upsertPost(db, {
        id: "old-post",
        content_type: "text",
        published_at: "2020-01-01T00:00:00Z",
      });
      const count = getPostCountSinceRun(db, runId);
      expect(count).toBe(1);
    });

    it("getChangelog returns categorized insights", () => {
      const run1 = createRun(db, "manual", 5);
      completeRun(db, run1, {
        input_tokens: 10,
        output_tokens: 5,
        cost_cents: 0.01,
      });
      const run2 = createRun(db, "manual", 5);
      completeRun(db, run2, {
        input_tokens: 10,
        output_tokens: 5,
        cost_cents: 0.01,
      });

      // Confirmed insight: appeared in both runs, active, consecutive > 1
      const confirmed = insertInsight(db, {
        run_id: run2,
        category: "content",
        stable_key: "confirmed-key",
        claim: "Confirmed claim",
        evidence: "e",
        confidence: 0.9,
        direction: "positive",
        first_seen_run_id: run1,
        consecutive_appearances: 3,
      });

      // New signal: first_seen_run_id = latest run
      const newSig = insertInsight(db, {
        run_id: run2,
        category: "content",
        stable_key: "new-key",
        claim: "New signal",
        evidence: "e",
        confidence: 0.6,
        direction: "neutral",
        first_seen_run_id: run2,
      });

      // Reversed: direction is "reversed"
      const reversed = insertInsight(db, {
        run_id: run2,
        category: "timing",
        stable_key: "rev-key",
        claim: "Reversed claim",
        evidence: "e",
        confidence: 0.5,
        direction: "reversed",
        first_seen_run_id: run1,
      });

      // Retired: status = 'retired'
      const retired = insertInsight(db, {
        run_id: run2,
        category: "format",
        stable_key: "ret-key",
        claim: "Retired claim",
        evidence: "e",
        confidence: 0.3,
        direction: "neutral",
        first_seen_run_id: run1,
      });
      retireInsight(db, retired);

      const changelog = getChangelog(db);
      expect(changelog.confirmed.length).toBeGreaterThanOrEqual(1);
      expect(changelog.confirmed[0].claim).toBe("Confirmed claim");
      expect(changelog.new_signal.length).toBeGreaterThanOrEqual(1);
      expect(changelog.new_signal[0].claim).toBe("New signal");
      expect(changelog.reversed.length).toBeGreaterThanOrEqual(1);
      expect(changelog.reversed[0].claim).toBe("Reversed claim");
      expect(changelog.retired.length).toBeGreaterThanOrEqual(1);
      expect(changelog.retired[0].claim).toBe("Retired claim");
    });
  });

  // ── settings ─────────────────────────────────────────────

  describe("settings table", () => {
    it("returns null for missing key", () => {
      expect(getSetting(db, "nonexistent")).toBeNull();
    });

    it("upserts and retrieves a setting", () => {
      upsertSetting(db, "timezone", "America/New_York");
      expect(getSetting(db, "timezone")).toBe("America/New_York");
      upsertSetting(db, "timezone", "America/Los_Angeles");
      expect(getSetting(db, "timezone")).toBe("America/Los_Angeles");
    });
  });

  // ── writing_prompt_history ────────────────────────────────

  describe("writing_prompt_history", () => {
    it("saves and retrieves history entries in reverse chronological order", () => {
      saveWritingPromptHistory(db, {
        prompt_text: "Prompt A",
        source: "manual_edit",
        evidence: null,
      });
      saveWritingPromptHistory(db, {
        prompt_text: "Prompt B",
        source: "ai_suggestion",
        evidence: "3 top posts used question hooks",
      });
      const history = getWritingPromptHistory(db);
      expect(history.length).toBeGreaterThanOrEqual(2);
      expect(history[0].prompt_text).toBe("Prompt B");
      expect(history[0].source).toBe("ai_suggestion");
      expect(history[1].prompt_text).toBe("Prompt A");
    });
  });

  // ── prompt suggestions ───────────────────────────────────

  describe("getLatestPromptSuggestions", () => {
    it("returns null when no completed run exists", () => {
      expect(getLatestPromptSuggestions(db)).toBeNull();
    });

    it("returns null when prompt_suggestions_json is null", () => {
      const runId = createRun(db, "manual", 5);
      completeRun(db, runId, { input_tokens: 100, output_tokens: 50, cost_cents: 0.1 });
      upsertOverview(db, {
        run_id: runId,
        summary_text: "summary",
        top_performer_post_id: null,
        top_performer_reason: null,
        quick_insights: "[]",
        prompt_suggestions_json: null,
      });
      expect(getLatestPromptSuggestions(db)).toBeNull();
    });

    it("returns parsed prompt suggestions from latest completed run", () => {
      const suggestions: import("../db/ai-queries.js").PromptSuggestions = {
        assessment: "suggest_changes",
        reasoning: "Top posts use question hooks but current prompt does not",
        suggestions: [
          {
            current: "Write a professional post",
            suggested: "Start with a question hook",
            evidence: "3 of top 5 posts used question hooks",
          },
        ],
      };
      const runId = createRun(db, "manual", 5);
      completeRun(db, runId, { input_tokens: 100, output_tokens: 50, cost_cents: 0.1 });
      upsertOverview(db, {
        run_id: runId,
        summary_text: "summary",
        top_performer_post_id: null,
        top_performer_reason: null,
        quick_insights: "[]",
        prompt_suggestions_json: JSON.stringify(suggestions),
      });
      const result = getLatestPromptSuggestions(db);
      expect(result).not.toBeNull();
      expect(result!.assessment).toBe("suggest_changes");
      expect(result!.reasoning).toBe("Top posts use question hooks but current prompt does not");
      expect(result!.suggestions).toHaveLength(1);
      expect(result!.suggestions[0].current).toBe("Write a professional post");
    });
  });

  // ── ai_analysis_gaps ─────────────────────────────────────

  describe("ai_analysis_gaps", () => {
    it("inserts a gap and retrieves it", () => {
      upsertAnalysisGap(db, {
        run_id: null,
        gap_type: "data_gap",
        stable_key: "missing_post_content",
        description: "49 posts have no text content",
        impact: "Cannot analyze writing style or topic",
      });
      const gaps = getLatestAnalysisGaps(db);
      const gap = gaps.find((g) => g.stable_key === "missing_post_content");
      expect(gap).toBeDefined();
      expect(gap!.times_flagged).toBe(1);
    });

    it("increments times_flagged on duplicate stable_key", () => {
      upsertAnalysisGap(db, {
        run_id: null,
        gap_type: "data_gap",
        stable_key: "missing_post_content",
        description: "49 posts have no text content",
        impact: "Cannot analyze writing style or topic",
      });
      upsertAnalysisGap(db, {
        run_id: null,
        gap_type: "data_gap",
        stable_key: "missing_post_content",
        description: "Updated description",
        impact: "Updated impact",
      });
      const gaps = getLatestAnalysisGaps(db);
      const gap = gaps.find((g) => g.stable_key === "missing_post_content");
      expect(gap!.times_flagged).toBe(2);
      expect(gap!.description).toBe("Updated description");
    });
  });
});
