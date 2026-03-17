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
  confidence: number;
  direction: string;
  first_seen_run_id: number;
  consecutive_appearances?: number;
}

export interface RecommendationInput {
  run_id: number;
  type: string;
  priority: number;
  confidence: number;
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
  // Delete existing overview for this run, then insert
  db.prepare("DELETE FROM ai_overview WHERE run_id = ?").run(input.run_id);
  db.prepare(
    `INSERT INTO ai_overview (run_id, summary_text, top_performer_post_id, top_performer_reason, quick_insights)
     VALUES (@run_id, @summary_text, @top_performer_post_id, @top_performer_reason, @quick_insights)`
  ).run(input);
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

  const confirmed = db
    .prepare(
      `SELECT * FROM insights
       WHERE status = 'active' AND consecutive_appearances > 1
       ORDER BY confidence DESC`
    )
    .all();

  const new_signal = latestRun
    ? db
        .prepare(
          `SELECT * FROM insights
           WHERE status = 'active' AND first_seen_run_id = ?
           ORDER BY confidence DESC`
        )
        .all(latestRun.id)
    : [];

  const reversed = db
    .prepare(
      `SELECT * FROM insights
       WHERE direction = 'reversed'
       ORDER BY confidence DESC`
    )
    .all();

  const retired = db
    .prepare(
      `SELECT * FROM insights
       WHERE status = 'retired'
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
