-- Migration 009: Post generation tables
-- Writing rules for post generation (3 categories)
CREATE TABLE IF NOT EXISTS generation_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,           -- 'voice_tone' | 'structure_formatting' | 'anti_ai_tropes'
  rule_text TEXT NOT NULL,
  example_text TEXT,                -- optional italic example
  sort_order INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1,        -- for anti-AI tropes master toggle
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Coaching insights (evolving, AI-managed)
CREATE TABLE IF NOT EXISTS coaching_insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  prompt_text TEXT NOT NULL,         -- the actual instruction injected into prompts
  evidence TEXT,                     -- why this insight exists
  status TEXT NOT NULL DEFAULT 'active',  -- 'candidate' | 'active' | 'under_review' | 'retired'
  source_sync_id INTEGER,            -- which coaching sync introduced it
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  retired_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_coaching_insights_status ON coaching_insights(status);

-- Post type templates
CREATE TABLE IF NOT EXISTS post_type_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_type TEXT NOT NULL UNIQUE,    -- 'news' | 'topic' | 'insight'
  template_text TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Research sessions (step 1 output)
CREATE TABLE IF NOT EXISTS generation_research (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_type TEXT NOT NULL,
  stories_json TEXT NOT NULL,         -- JSON array of 3 stories
  sources_json TEXT,                  -- sources metadata
  article_count INTEGER,
  source_count INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Generation records (tracks the full pipeline for one post)
CREATE TABLE IF NOT EXISTS generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  research_id INTEGER REFERENCES generation_research(id),
  post_type TEXT NOT NULL,
  selected_story_index INTEGER,
  drafts_json TEXT,                   -- JSON array of 3 draft variations
  selected_draft_indices TEXT,        -- JSON array e.g. [0, 2]
  combining_guidance TEXT,
  final_draft TEXT,
  quality_gate_json TEXT,             -- JSON: { passed, checks[] }
  status TEXT NOT NULL DEFAULT 'draft',  -- 'draft' | 'copied' | 'published' | 'discarded'
  matched_post_id TEXT REFERENCES posts(id),
  prompt_snapshot TEXT,               -- full assembled prompt used
  total_input_tokens INTEGER,
  total_output_tokens INTEGER,
  total_cost_cents REAL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_generations_status ON generations(status);
CREATE INDEX IF NOT EXISTS idx_generations_created_at ON generations(created_at);

-- Revision log for edits within a generation
CREATE TABLE IF NOT EXISTS generation_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generation_id INTEGER NOT NULL REFERENCES generations(id),
  action TEXT NOT NULL,               -- 'regenerate' | 'shorten' | 'strengthen_close' | 'custom' | 'combine'
  instruction TEXT,                   -- user instruction for 'custom' action
  input_draft TEXT,                   -- draft before revision
  output_draft TEXT,                  -- draft after revision
  quality_gate_json TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_cents REAL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_generation_revisions_gen ON generation_revisions(generation_id);

-- Weekly coaching sync sessions
CREATE TABLE IF NOT EXISTS coaching_syncs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  changes_json TEXT NOT NULL,         -- proposed changes array
  decisions_json TEXT,                -- user accept/skip/retire decisions
  accepted_count INTEGER DEFAULT 0,
  skipped_count INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'completed'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

-- Coaching insight change history (for revision history view)
CREATE TABLE IF NOT EXISTS coaching_change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_id INTEGER NOT NULL REFERENCES coaching_syncs(id),
  insight_id INTEGER REFERENCES coaching_insights(id),
  change_type TEXT NOT NULL,          -- 'new' | 'updated' | 'retired'
  old_text TEXT,
  new_text TEXT,
  evidence TEXT,
  decision TEXT,                      -- 'accept' | 'skip' | 'keep' | 'retire'
  decided_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_coaching_change_log_sync ON coaching_change_log(sync_id);

-- Golden reference posts for regression testing
CREATE TABLE IF NOT EXISTS golden_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL REFERENCES posts(id),
  reason TEXT,                        -- why this is a golden post
  added_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Topic selection log for anti-narrowing
CREATE TABLE IF NOT EXISTS generation_topic_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generation_id INTEGER NOT NULL REFERENCES generations(id),
  topic_category TEXT,
  was_stretch INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_generation_topic_log_created ON generation_topic_log(created_at);

-- Seed default post type templates (refined)
INSERT OR IGNORE INTO post_type_templates (post_type, template_text) VALUES
  ('news', 'Write a LinkedIn post reacting to a news story.

Structure:
- Hook: State a non-obvious take on the news in one punchy sentence. Do NOT start with the news itself.
- Context: 1-2 sentences on what happened (assume reader hasn''t seen it).
- Take: Your practitioner perspective — what this means for people who build/ship/operate. Use specific experience.
- Close: A process question that invites practitioners to share their approach.

Constraints:
- One take per post. Don''t hedge with "on one hand."
- Ground claims in what you''ve built, shipped, or observed — not industry analysis.
- 150-250 words. Every sentence earns its place.'),

  ('topic', 'Write a LinkedIn post exploring a professional topic from practitioner experience.

Structure:
- Hook: A surprising insight, counterintuitive claim, or friction point. Not a question.
- Setup: What you observed, built, or broke that led to this insight. Be specific.
- Expansion: One concrete example with named tools, metrics, or outcomes.
- Close: A question that triggers substantive practitioner responses about their process.

Constraints:
- Draw from direct experience, not secondhand analysis.
- One idea per post. If the outline has two ideas, pick the sharper one.
- 150-300 words. Favor short declarative sentences for impact.'),

  ('insight', 'Write a LinkedIn post sharing a hard-won professional insight.

Structure:
- Hook: The sharpest version of the lesson in one sentence. Lead with the conclusion.
- Story: The specific moment or experience that taught this lesson. Include sensory/emotional detail.
- Principle: The generalizable takeaway, grounded in the specific story.
- Close: A reflective question that makes other practitioners examine their own experience.

Constraints:
- The insight must come from direct experience, not observation or reading.
- Include at least one specific detail (a tool name, a dollar amount, a timeline, a failure mode).
- 150-250 words. The story should be tight — no scene-setting preamble.');
