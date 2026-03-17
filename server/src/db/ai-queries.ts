import type Database from "better-sqlite3";

// ── Types ──────────────────────────────────────────────────

export interface AiTag {
  post_id: string;
  hook_type: string | null;
  tone: string | null;
  format_style: string | null;
  tagged_at: string;
  model: string | null;
}

export interface InsightInput {
  run_id: number;
  category: string;
  stable_key: string;
  claim: string;
  evidence: string;
  confidence: string | number;
  direction: string;
  first_seen_run_id: number;
  consecutive_appearances?: number;
}

export interface RecommendationInput {
  run_id: number;
  type: string;
  priority: number;
  confidence: string | number;
  headline: string;
  detail: string;
  action: string;
  evidence_json: string;
}

export interface OverviewInput {
  run_id: number;
  summary_text: string;
  top_performer_post_id: string | null;
  top_performer_reason: string | null;
  quick_insights: string;
  prompt_suggestions_json: string | null;
}

export interface AiLogInput {
  run_id: number;
  step: string;
  model: string;
  input_messages: string;
  output_text: string;
  tool_calls: string | null;
  input_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  duration_ms: number;
}

export interface ImageTagInput {
  post_id: string;
  image_index: number;
  format: string;
  people: string;
  setting: string;
  text_density: string;
  energy: string;
  model: string;
}

export interface ImageTag {
  post_id: string;
  image_index: number;
  format: string;
  people: string;
  setting: string;
  text_density: string;
  energy: string;
  tagged_at: string;
  model: string;
}

// ── ai_runs ────────────────────────────────────────────────

export function createRun(
  db: Database.Database,
  triggered_by: string,
  post_count: number
): number {
  const result = db
    .prepare(
      `INSERT INTO ai_runs (triggered_by, post_count) VALUES (?, ?)`
    )
    .run(triggered_by, post_count);
  return Number(result.lastInsertRowid);
}

export function completeRun(
  db: Database.Database,
  runId: number,
  stats: { input_tokens: number; output_tokens: number; cost_cents: number }
): void {
  db.prepare(
    `UPDATE ai_runs
     SET status = 'completed',
         completed_at = CURRENT_TIMESTAMP,
         total_input_tokens = ?,
         total_output_tokens = ?,
         total_cost_cents = ?
     WHERE id = ?`
  ).run(stats.input_tokens, stats.output_tokens, stats.cost_cents, runId);
}

export function failRun(
  db: Database.Database,
  runId: number,
  error: string
): void {
  db.prepare(
    `UPDATE ai_runs
     SET status = 'failed',
         completed_at = CURRENT_TIMESTAMP,
         error = ?
     WHERE id = ?`
  ).run(error, runId);
}

export function getRunningRun(
  db: Database.Database
): { id: number; started_at: string } | null {
  return (
    (db
      .prepare("SELECT id, started_at FROM ai_runs WHERE status = 'running' LIMIT 1")
      .get() as { id: number; started_at: string } | undefined) ?? null
  );
}

export function getLatestCompletedRun(
  db: Database.Database
): { id: number; status: string; post_count: number; completed_at: string } | null {
  return (
    (db
      .prepare(
        "SELECT id, status, post_count, completed_at FROM ai_runs WHERE status = 'completed' ORDER BY id DESC LIMIT 1"
      )
      .get() as
      | { id: number; status: string; post_count: number; completed_at: string }
      | undefined) ?? null
  );
}

// ── ai_taxonomy ────────────────────────────────────────────

export function upsertTaxonomy(
  db: Database.Database,
  items: { name: string; description: string }[]
): void {
  const stmt = db.prepare(
    `INSERT INTO ai_taxonomy (name, description)
     VALUES (@name, @description)
     ON CONFLICT(name) DO UPDATE SET description = @description`
  );
  const tx = db.transaction((rows: { name: string; description: string }[]) => {
    for (const row of rows) {
      stmt.run(row);
    }
  });
  tx(items);
}

export function getTaxonomy(
  db: Database.Database
): { id: number; name: string; description: string }[] {
  return db
    .prepare("SELECT id, name, description FROM ai_taxonomy ORDER BY name")
    .all() as { id: number; name: string; description: string }[];
}

// ── ai_post_topics ─────────────────────────────────────────

export function setPostTopics(
  db: Database.Database,
  postId: string,
  taxonomyIds: number[]
): void {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM ai_post_topics WHERE post_id = ?").run(postId);
    const insert = db.prepare(
      "INSERT INTO ai_post_topics (post_id, taxonomy_id) VALUES (?, ?)"
    );
    for (const tid of taxonomyIds) {
      insert.run(postId, tid);
    }
  });
  tx();
}

export function getPostTopics(
  db: Database.Database,
  postId: string
): string[] {
  const rows = db
    .prepare(
      `SELECT t.name FROM ai_post_topics pt
       JOIN ai_taxonomy t ON t.id = pt.taxonomy_id
       WHERE pt.post_id = ?
       ORDER BY t.name`
    )
    .all(postId) as { name: string }[];
  return rows.map((r) => r.name);
}

// ── ai_tags ────────────────────────────────────────────────

export function upsertAiTag(
  db: Database.Database,
  tag: {
    post_id: string;
    hook_type: string;
    tone: string;
    format_style: string;
    model: string;
  }
): void {
  db.prepare(
    `INSERT INTO ai_tags (post_id, hook_type, tone, format_style, model)
     VALUES (@post_id, @hook_type, @tone, @format_style, @model)
     ON CONFLICT(post_id) DO UPDATE SET
       hook_type = @hook_type,
       tone = @tone,
       format_style = @format_style,
       model = @model,
       tagged_at = CURRENT_TIMESTAMP`
  ).run(tag);
}

export function getAiTags(
  db: Database.Database,
  postIds: string[]
): Record<string, AiTag> {
  if (postIds.length === 0) return {};
  const placeholders = postIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT post_id, hook_type, tone, format_style, tagged_at, model
       FROM ai_tags WHERE post_id IN (${placeholders})`
    )
    .all(...postIds) as AiTag[];
  const result: Record<string, AiTag> = {};
  for (const row of rows) {
    result[row.post_id] = row;
  }
  return result;
}

export function getUntaggedPostIds(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT p.id FROM posts p
       LEFT JOIN ai_tags t ON t.post_id = p.id
       WHERE t.post_id IS NULL
       ORDER BY p.id`
    )
    .all() as { id: string }[];
  return rows.map((r) => r.id);
}

// ── insights ───────────────────────────────────────────────

export function insertInsight(
  db: Database.Database,
  input: InsightInput
): number {
  const result = db
    .prepare(
      `INSERT INTO insights (run_id, category, stable_key, claim, evidence, confidence, direction, first_seen_run_id, consecutive_appearances)
       VALUES (@run_id, @category, @stable_key, @claim, @evidence, @confidence, @direction, @first_seen_run_id, @consecutive_appearances)`
    )
    .run({
      ...input,
      consecutive_appearances: input.consecutive_appearances ?? 1,
    });
  return Number(result.lastInsertRowid);
}

export function getActiveInsights(db: Database.Database): any[] {
  return db
    .prepare(
      `SELECT * FROM insights WHERE status = 'active' ORDER BY confidence DESC`
    )
    .all();
}

export function retireInsight(db: Database.Database, insightId: number): void {
  db.prepare("UPDATE insights SET status = 'retired' WHERE id = ?").run(
    insightId
  );
}

export function insertInsightLineage(
  db: Database.Database,
  insightId: number,
  predecessorId: number,
  relationship: string
): void {
  db.prepare(
    `INSERT INTO insight_lineage (insight_id, predecessor_id, relationship)
     VALUES (?, ?, ?)`
  ).run(insightId, predecessorId, relationship);
}

// ── recommendations ────────────────────────────────────────

export function insertRecommendation(
  db: Database.Database,
  input: RecommendationInput
): number {
  const result = db
    .prepare(
      `INSERT INTO recommendations (run_id, type, priority, confidence, headline, detail, action, evidence_json)
       VALUES (@run_id, @type, @priority, @confidence, @headline, @detail, @action, @evidence_json)`
    )
    .run(input);
  return Number(result.lastInsertRowid);
}

export function getRecommendations(
  db: Database.Database,
  runId?: number
): any[] {
  if (runId != null) {
    return db
      .prepare(
        "SELECT * FROM recommendations WHERE run_id = ? ORDER BY priority ASC"
      )
      .all(runId);
  }
  // Default: latest completed run
  const latest = getLatestCompletedRun(db);
  if (!latest) return [];
  return db
    .prepare(
      "SELECT * FROM recommendations WHERE run_id = ? ORDER BY priority ASC"
    )
    .all(latest.id);
}

export function updateRecommendationFeedback(
  db: Database.Database,
  id: number,
  feedback: string
): void {
  db.prepare(
    `UPDATE recommendations SET feedback = ?, feedback_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(feedback, id);
}

// ── ai_overview ────────────────────────────────────────────

export function upsertOverview(
  db: Database.Database,
  input: OverviewInput
): void {
  db.transaction(() => {
    db.prepare("DELETE FROM ai_overview WHERE run_id = ?").run(input.run_id);
    db.prepare(
      `INSERT INTO ai_overview
         (run_id, summary_text, top_performer_post_id, top_performer_reason, quick_insights, prompt_suggestions_json)
       VALUES
         (@run_id, @summary_text, @top_performer_post_id, @top_performer_reason, @quick_insights, @prompt_suggestions_json)`
    ).run(input);
  })();
}

export function getLatestOverview(db: Database.Database): any | null {
  const latest = getLatestCompletedRun(db);
  if (!latest) return null;
  return (
    db
      .prepare("SELECT * FROM ai_overview WHERE run_id = ? LIMIT 1")
      .get(latest.id) ?? null
  );
}

// ── ai_logs ────────────────────────────────────────────────

export function insertAiLog(
  db: Database.Database,
  input: AiLogInput
): void {
  db.prepare(
    `INSERT INTO ai_logs (run_id, step, model, input_messages, output_text, tool_calls, input_tokens, output_tokens, thinking_tokens, duration_ms)
     VALUES (@run_id, @step, @model, @input_messages, @output_text, @tool_calls, @input_tokens, @output_tokens, @thinking_tokens, @duration_ms)`
  ).run(input);
}

// ── helpers ────────────────────────────────────────────────

export function getChangelog(db: Database.Database): {
  confirmed: any[];
  new_signal: any[];
  reversed: any[];
  retired: any[];
} {
  const latestRun = getLatestCompletedRun(db);

  if (!latestRun) return { confirmed: [], new_signal: [], reversed: [], retired: [] };

  const confirmed = db
    .prepare(
      `SELECT * FROM insights
       WHERE status = 'active' AND run_id = ? AND consecutive_appearances > 1
       ORDER BY confidence DESC`
    )
    .all(latestRun.id);

  const new_signal = db
    .prepare(
      `SELECT * FROM insights
       WHERE status = 'active' AND run_id = ? AND first_seen_run_id = ?
       ORDER BY confidence DESC`
    )
    .all(latestRun.id, latestRun.id);

  const reversed = db
    .prepare(
      `SELECT * FROM insights
       WHERE run_id = ? AND direction = 'reversed'
       ORDER BY confidence DESC`
    )
    .all(latestRun.id);

  const retired = db
    .prepare(
      `SELECT * FROM insights
       WHERE status = 'retired' AND run_id = (SELECT MAX(run_id) FROM insights WHERE status = 'retired')
       ORDER BY confidence DESC`
    )
    .all();

  return { confirmed, new_signal, reversed, retired };
}

export function getPostCountWithMetrics(db: Database.Database): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT pm.post_id) as count
       FROM post_metrics pm`
    )
    .get() as { count: number };
  return row.count;
}

// ── ai_image_tags ─────────────────────────────────────────

export function upsertImageTag(db: Database.Database, input: ImageTagInput): void {
  db.prepare(
    `INSERT INTO ai_image_tags (post_id, image_index, format, people, setting, text_density, energy, model)
     VALUES (@post_id, @image_index, @format, @people, @setting, @text_density, @energy, @model)
     ON CONFLICT(post_id, image_index) DO UPDATE SET
       format = @format, people = @people, setting = @setting,
       text_density = @text_density, energy = @energy,
       model = @model, tagged_at = CURRENT_TIMESTAMP`
  ).run(input);
}

export function getImageTags(
  db: Database.Database,
  postIds: string[]
): Record<string, ImageTag[]> {
  if (postIds.length === 0) return {};
  const placeholders = postIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT * FROM ai_image_tags WHERE post_id IN (${placeholders}) ORDER BY post_id, image_index`
    )
    .all(...postIds) as ImageTag[];
  const result: Record<string, ImageTag[]> = {};
  for (const row of rows) {
    if (!result[row.post_id]) result[row.post_id] = [];
    result[row.post_id].push(row);
  }
  return result;
}

export function getUnclassifiedImagePosts(
  db: Database.Database
): { id: string; image_local_paths: string; hook_text: string | null }[] {
  return db
    .prepare(
      `SELECT p.id, p.image_local_paths, p.hook_text
       FROM posts p
       WHERE p.image_local_paths IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ai_image_tags t WHERE t.post_id = p.id)
       ORDER BY p.published_at DESC`
    )
    .all() as { id: string; image_local_paths: string; hook_text: string | null }[];
}

export function getPostCountSinceRun(
  db: Database.Database,
  runId: number
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM posts p
       WHERE p.published_at > (
         SELECT completed_at FROM ai_runs WHERE id = ?
       )`
    )
    .get(runId) as { count: number };
  return row.count;
}

// ── settings ───────────────────────────────────────────────

export function getSetting(db: Database.Database, key: string): string | null {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function upsertSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
  ).run(key, value);
}

// ── writing_prompt_history ─────────────────────────────────

export interface WritingPromptHistoryRow {
  id: number;
  prompt_text: string;
  source: string;
  suggestion_evidence: string | null;
  created_at: string;
}

export function saveWritingPromptHistory(
  db: Database.Database,
  input: { prompt_text: string; source: string; evidence: string | null }
): void {
  db.prepare(
    `INSERT INTO writing_prompt_history (prompt_text, source, suggestion_evidence)
     VALUES (?, ?, ?)`
  ).run(input.prompt_text, input.source, input.evidence);
}

export function getWritingPromptHistory(db: Database.Database): WritingPromptHistoryRow[] {
  return db
    .prepare("SELECT * FROM writing_prompt_history ORDER BY id DESC")
    .all() as WritingPromptHistoryRow[];
}

// ── ai_analysis_gaps ───────────────────────────────────────

export interface AnalysisGapInput {
  run_id: number | null;
  gap_type: string;
  stable_key: string;
  description: string;
  impact: string;
}

export interface AnalysisGapRow {
  id: number;
  run_id: number | null;
  gap_type: string;
  stable_key: string;
  description: string;
  impact: string;
  times_flagged: number;
  first_seen_at: string;
  last_seen_at: string;
}

export function upsertAnalysisGap(db: Database.Database, input: AnalysisGapInput): void {
  db.prepare(
    `INSERT INTO ai_analysis_gaps (run_id, gap_type, stable_key, description, impact)
     VALUES (@run_id, @gap_type, @stable_key, @description, @impact)
     ON CONFLICT(gap_type, stable_key) DO UPDATE SET
       description = excluded.description,
       impact = excluded.impact,
       times_flagged = times_flagged + 1,
       last_seen_at = CURRENT_TIMESTAMP,
       run_id = excluded.run_id`
  ).run(input);
}

export function getLatestAnalysisGaps(db: Database.Database): AnalysisGapRow[] {
  return db
    .prepare(
      "SELECT * FROM ai_analysis_gaps ORDER BY times_flagged DESC, last_seen_at DESC"
    )
    .all() as AnalysisGapRow[];
}

// ── prompt suggestions (stored in ai_overview) ─────────────

export interface PromptSuggestion {
  current: string;
  suggested: string;
  evidence: string;
}

export interface PromptSuggestions {
  assessment: "working_well" | "suggest_changes";
  reasoning: string;
  suggestions: PromptSuggestion[];
}

export function getLatestPromptSuggestions(db: Database.Database): PromptSuggestions | null {
  const latest = getLatestCompletedRun(db);
  if (!latest) return null;
  const row = db
    .prepare("SELECT prompt_suggestions_json FROM ai_overview WHERE run_id = ? LIMIT 1")
    .get(latest.id) as { prompt_suggestions_json: string | null } | undefined;
  if (!row?.prompt_suggestions_json) return null;
  try {
    return JSON.parse(row.prompt_suggestions_json) as PromptSuggestions;
  } catch {
    return null;
  }
}

export function getRecentFeedbackWithReasons(
  db: Database.Database
): { headline: string; feedback: string; reason: string | null }[] {
  const rows = db
    .prepare(
      `SELECT headline, feedback FROM recommendations
       WHERE feedback IS NOT NULL
       ORDER BY feedback_at DESC
       LIMIT 20`
    )
    .all() as { headline: string; feedback: string }[];

  return rows.map((row) => {
    try {
      const parsed = JSON.parse(row.feedback);
      return {
        headline: row.headline,
        feedback: parsed.rating ?? row.feedback,
        reason: parsed.reason ?? null,
      };
    } catch {
      return { headline: row.headline, feedback: row.feedback, reason: null };
    }
  });
}
