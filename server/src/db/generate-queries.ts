import type Database from "better-sqlite3";

// ── Types ──────────────────────────────────────────────────

export interface GenerationRule {
  id: number;
  category: string;
  rule_text: string;
  example_text: string | null;
  sort_order: number;
  enabled: number;
}

export interface CoachingInsight {
  id: number;
  title: string;
  prompt_text: string;
  evidence: string | null;
  status: string;
  source_sync_id: number | null;
  created_at: string;
  updated_at: string;
  retired_at: string | null;
}

export interface PostTypeTemplate {
  id: number;
  post_type: string;
  template_text: string;
}

export interface Story {
  headline: string;
  summary: string;
  source: string;
  age: string;
  tag: string;
  angles: string[];
  is_stretch: boolean;
}

export interface Draft {
  type: "contrarian" | "operator" | "future";
  hook: string;
  body: string;
  closing: string;
  word_count: number;
  structure_label: string;
}

export interface QualityCheck {
  name: string;
  status: "pass" | "warn";
  detail: string;
}

export interface QualityGate {
  passed: boolean;
  checks: QualityCheck[];
}

export interface GenerationRecord {
  id: number;
  research_id: number | null;
  post_type: string;
  selected_story_index: number | null;
  drafts_json: string | null;
  selected_draft_indices: string | null;
  combining_guidance: string | null;
  final_draft: string | null;
  quality_gate_json: string | null;
  status: string;
  matched_post_id: string | null;
  prompt_snapshot: string | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  total_cost_cents: number | null;
  created_at: string;
  updated_at: string;
}

export interface CoachingChange {
  id: number;
  sync_id: number;
  insight_id: number | null;
  change_type: string;
  old_text: string | null;
  new_text: string | null;
  evidence: string | null;
  decision: string | null;
  decided_at: string | null;
}

// ── Rules ──────────────────────────────────────────────────

export function getRules(db: Database.Database): GenerationRule[] {
  return db
    .prepare("SELECT * FROM generation_rules ORDER BY category, sort_order")
    .all() as GenerationRule[];
}

export function getRulesByCategory(
  db: Database.Database,
  category: string
): GenerationRule[] {
  return db
    .prepare("SELECT * FROM generation_rules WHERE category = ? ORDER BY sort_order")
    .all(category) as GenerationRule[];
}

export function replaceAllRules(
  db: Database.Database,
  rules: Array<{ category: string; rule_text: string; example_text?: string; sort_order: number; enabled?: number }>
): void {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM generation_rules").run();
    const insert = db.prepare(
      "INSERT INTO generation_rules (category, rule_text, example_text, sort_order, enabled) VALUES (?, ?, ?, ?, ?)"
    );
    for (const rule of rules) {
      insert.run(rule.category, rule.rule_text, rule.example_text ?? null, rule.sort_order, rule.enabled ?? 1);
    }
  });
  tx();
}

export function getAntiAiTropesEnabled(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT enabled FROM generation_rules WHERE category = 'anti_ai_tropes' LIMIT 1")
    .get() as { enabled: number } | undefined;
  return row ? row.enabled === 1 : true;
}

// ── Coaching Insights ──────────────────────────────────────

export function getActiveCoachingInsights(db: Database.Database): CoachingInsight[] {
  return db
    .prepare("SELECT * FROM coaching_insights WHERE status = 'active' ORDER BY created_at")
    .all() as CoachingInsight[];
}

export function getAllCoachingInsights(db: Database.Database): CoachingInsight[] {
  return db
    .prepare("SELECT * FROM coaching_insights ORDER BY created_at DESC")
    .all() as CoachingInsight[];
}

export function insertCoachingInsight(
  db: Database.Database,
  insight: { title: string; prompt_text: string; evidence?: string; source_sync_id?: number }
): number {
  const result = db
    .prepare(
      "INSERT INTO coaching_insights (title, prompt_text, evidence, source_sync_id) VALUES (?, ?, ?, ?)"
    )
    .run(insight.title, insight.prompt_text, insight.evidence ?? null, insight.source_sync_id ?? null);
  return Number(result.lastInsertRowid);
}

export function updateCoachingInsight(
  db: Database.Database,
  id: number,
  updates: { prompt_text?: string; status?: string; retired_at?: string }
): void {
  const sets: string[] = ["updated_at = CURRENT_TIMESTAMP"];
  const params: any[] = [];
  if (updates.prompt_text !== undefined) {
    sets.push("prompt_text = ?");
    params.push(updates.prompt_text);
  }
  if (updates.status !== undefined) {
    sets.push("status = ?");
    params.push(updates.status);
  }
  if (updates.retired_at !== undefined) {
    sets.push("retired_at = ?");
    params.push(updates.retired_at);
  }
  params.push(id);
  db.prepare(`UPDATE coaching_insights SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

// ── Post Type Templates ────────────────────────────────────

export function getPostTypeTemplate(
  db: Database.Database,
  postType: string
): PostTypeTemplate | undefined {
  return db
    .prepare("SELECT * FROM post_type_templates WHERE post_type = ?")
    .get(postType) as PostTypeTemplate | undefined;
}

// ── Research ───────────────────────────────────────────────

export function insertResearch(
  db: Database.Database,
  data: { post_type: string; stories_json: string; sources_json?: string; article_count?: number; source_count?: number }
): number {
  const result = db
    .prepare(
      "INSERT INTO generation_research (post_type, stories_json, sources_json, article_count, source_count) VALUES (?, ?, ?, ?, ?)"
    )
    .run(data.post_type, data.stories_json, data.sources_json ?? null, data.article_count ?? null, data.source_count ?? null);
  return Number(result.lastInsertRowid);
}

export function getResearch(
  db: Database.Database,
  id: number
): { id: number; post_type: string; stories_json: string; sources_json: string | null; article_count: number; source_count: number } | undefined {
  return db
    .prepare("SELECT * FROM generation_research WHERE id = ?")
    .get(id) as any;
}

// ── Generations ────────────────────────────────────────────

export function insertGeneration(
  db: Database.Database,
  data: {
    research_id: number;
    post_type: string;
    selected_story_index: number;
    drafts_json: string;
    prompt_snapshot?: string;
  }
): number {
  const result = db
    .prepare(
      `INSERT INTO generations (research_id, post_type, selected_story_index, drafts_json, prompt_snapshot)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(data.research_id, data.post_type, data.selected_story_index, data.drafts_json, data.prompt_snapshot ?? null);
  return Number(result.lastInsertRowid);
}

export function getGeneration(
  db: Database.Database,
  id: number
): GenerationRecord | undefined {
  return db
    .prepare("SELECT * FROM generations WHERE id = ?")
    .get(id) as GenerationRecord | undefined;
}

export function updateGeneration(
  db: Database.Database,
  id: number,
  updates: Partial<{
    selected_draft_indices: string;
    combining_guidance: string;
    final_draft: string;
    quality_gate_json: string;
    status: string;
    matched_post_id: string;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cost_cents: number;
  }>
): void {
  const ALLOWED_COLUMNS = new Set([
    "selected_draft_indices", "combining_guidance", "final_draft",
    "quality_gate_json", "status", "matched_post_id",
    "total_input_tokens", "total_output_tokens", "total_cost_cents",
    "prompt_snapshot",
  ]);
  const sets: string[] = ["updated_at = CURRENT_TIMESTAMP"];
  const params: any[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && ALLOWED_COLUMNS.has(key)) {
      sets.push(`${key} = ?`);
      params.push(value);
    }
  }
  params.push(id);
  db.prepare(`UPDATE generations SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

export function listGenerations(
  db: Database.Database,
  opts: { status?: string; offset?: number; limit?: number }
): { generations: GenerationRecord[]; total: number } {
  const where = opts.status && opts.status !== "all" ? "WHERE status = ?" : "";
  const params: any[] = opts.status && opts.status !== "all" ? [opts.status] : [];

  const total = (
    db.prepare(`SELECT COUNT(*) as count FROM generations ${where}`).get(...params) as { count: number }
  ).count;

  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  const rows = db
    .prepare(`SELECT * FROM generations ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as GenerationRecord[];

  return { generations: rows, total };
}

// ── Revisions ──────────────────────────────────────────────

export function insertRevision(
  db: Database.Database,
  data: {
    generation_id: number;
    action: string;
    instruction?: string;
    input_draft: string;
    output_draft: string;
    quality_gate_json?: string;
    input_tokens?: number;
    output_tokens?: number;
    cost_cents?: number;
  }
): number {
  const result = db
    .prepare(
      `INSERT INTO generation_revisions
       (generation_id, action, instruction, input_draft, output_draft, quality_gate_json, input_tokens, output_tokens, cost_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.generation_id,
      data.action,
      data.instruction ?? null,
      data.input_draft,
      data.output_draft,
      data.quality_gate_json ?? null,
      data.input_tokens ?? null,
      data.output_tokens ?? null,
      data.cost_cents ?? null
    );
  return Number(result.lastInsertRowid);
}

// ── Coaching Syncs ─────────────────────────────────────────

export function insertCoachingSync(
  db: Database.Database,
  changes_json: string
): number {
  const result = db
    .prepare("INSERT INTO coaching_syncs (changes_json) VALUES (?)")
    .run(changes_json);
  return Number(result.lastInsertRowid);
}

export function getCoachingSync(
  db: Database.Database,
  id: number
): { id: number; changes_json: string; decisions_json: string | null; accepted_count: number; skipped_count: number; status: string } | undefined {
  return db
    .prepare("SELECT * FROM coaching_syncs WHERE id = ?")
    .get(id) as any;
}

export function completeCoachingSync(
  db: Database.Database,
  id: number,
  decisions_json: string,
  accepted: number,
  skipped: number
): void {
  db.prepare(
    `UPDATE coaching_syncs SET status = 'completed', decisions_json = ?, accepted_count = ?, skipped_count = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(decisions_json, accepted, skipped, id);
}

// ── Coaching Change Log ────────────────────────────────────

export function insertCoachingChangeLog(
  db: Database.Database,
  data: {
    sync_id: number;
    insight_id?: number;
    change_type: string;
    old_text?: string;
    new_text?: string;
    evidence?: string;
  }
): number {
  const result = db
    .prepare(
      `INSERT INTO coaching_change_log (sync_id, insight_id, change_type, old_text, new_text, evidence)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(data.sync_id, data.insight_id ?? null, data.change_type, data.old_text ?? null, data.new_text ?? null, data.evidence ?? null);
  return Number(result.lastInsertRowid);
}

export function updateCoachingChangeDecision(
  db: Database.Database,
  id: number,
  decision: string
): void {
  db.prepare(
    "UPDATE coaching_change_log SET decision = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(decision, id);
}

export function getCoachingChangeLog(
  db: Database.Database,
  syncId: number
): CoachingChange[] {
  return db
    .prepare("SELECT * FROM coaching_change_log WHERE sync_id = ? ORDER BY id")
    .all(syncId) as CoachingChange[];
}

export function getCoachingSyncHistory(
  db: Database.Database
): Array<{ id: number; accepted_count: number; skipped_count: number; status: string; created_at: string; completed_at: string | null }> {
  return db
    .prepare("SELECT id, accepted_count, skipped_count, status, created_at, completed_at FROM coaching_syncs ORDER BY id DESC LIMIT 20")
    .all() as any[];
}

// ── Topic Log ──────────────────────────────────────────────

export function insertTopicLog(
  db: Database.Database,
  data: { generation_id: number; topic_category?: string; was_stretch?: boolean }
): void {
  db.prepare(
    "INSERT INTO generation_topic_log (generation_id, topic_category, was_stretch) VALUES (?, ?, ?)"
  ).run(data.generation_id, data.topic_category ?? null, data.was_stretch ? 1 : 0);
}

export function getRecentTopics(
  db: Database.Database,
  limit: number = 10
): Array<{ topic_category: string; was_stretch: number; created_at: string }> {
  return db
    .prepare("SELECT topic_category, was_stretch, created_at FROM generation_topic_log ORDER BY created_at DESC LIMIT ?")
    .all(limit) as any[];
}

// ── Default Rules ──────────────────────────────────────────

export const DEFAULT_RULES: Array<{ category: string; rule_text: string; example_text?: string; sort_order: number }> = [
  // Voice & tone
  { category: "voice_tone", rule_text: "Write as a practitioner sharing hard-won experience, not a thought leader pontificating", sort_order: 0 },
  { category: "voice_tone", rule_text: "Favor concrete specifics over vague abstractions", example_text: "Favor: \"$400/month replacing $400k/year\" — Avoid: \"cost-effective solution\"", sort_order: 1 },
  { category: "voice_tone", rule_text: "Use embodied experience (\"I shipped\", \"We discovered\") not generic descriptions (\"Companies should\", \"Leaders must\")", sort_order: 2 },
  { category: "voice_tone", rule_text: "One idea per post. Resist the urge to cover everything", sort_order: 3 },
  { category: "voice_tone", rule_text: "Match conversational register — write like you'd explain it to a sharp colleague over coffee", sort_order: 4 },
  // Structure & formatting
  { category: "structure_formatting", rule_text: "Open with friction, a claim, or a surprising insight — never context, history, or a rhetorical question", sort_order: 0 },
  { category: "structure_formatting", rule_text: "Close with a question that invites informed disagreement or practitioner reflection, not a generic opinion poll", sort_order: 1 },
  { category: "structure_formatting", rule_text: "Keep paragraphs to 1-2 sentences. Use line breaks for rhythm", sort_order: 2 },
  { category: "structure_formatting", rule_text: "End by extending the idea forward, not summarizing or recapping what was already said", sort_order: 3 },
  { category: "structure_formatting", rule_text: "250-400 words. Shorter is better if the idea is complete", sort_order: 4 },
  // Anti-AI tropes
  { category: "anti_ai_tropes", rule_text: "No hedging words: \"actually\", \"just\", \"maybe\", \"perhaps\", \"honestly\"", sort_order: 0 },
  { category: "anti_ai_tropes", rule_text: "No correlative filler: \"Not X, but Y\" / \"It's not about X, it's about Y\" constructions", sort_order: 1 },
  { category: "anti_ai_tropes", rule_text: "No rhetorical questions as filler or transitions", sort_order: 2 },
  { category: "anti_ai_tropes", rule_text: "No meandering intros that set context before getting to the point", sort_order: 3 },
  { category: "anti_ai_tropes", rule_text: "No recapping conclusions that summarize what was already said", sort_order: 4 },
  { category: "anti_ai_tropes", rule_text: "No emoji as bullet points or section markers", sort_order: 5 },
  { category: "anti_ai_tropes", rule_text: "No \"Here's the thing\" / \"Let me tell you\" / \"The truth is\" throat-clearing", sort_order: 6 },
  { category: "anti_ai_tropes", rule_text: "No abstract industry analysis without personal stakes or direct experience", sort_order: 7 },
];

export function seedDefaultRules(db: Database.Database): void {
  replaceAllRules(db, DEFAULT_RULES);
}
