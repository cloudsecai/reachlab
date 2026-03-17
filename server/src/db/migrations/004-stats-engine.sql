-- Settings key-value store (timezone, writing_prompt)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Writing prompt revision history
CREATE TABLE IF NOT EXISTS writing_prompt_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_text TEXT NOT NULL,
  source TEXT NOT NULL,
  suggestion_evidence TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Analysis gaps logged per run, deduplicated by gap_type + stable_key
CREATE TABLE IF NOT EXISTS ai_analysis_gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER REFERENCES ai_runs(id),
  gap_type TEXT NOT NULL,
  stable_key TEXT NOT NULL,
  description TEXT NOT NULL,
  impact TEXT NOT NULL,
  times_flagged INTEGER DEFAULT 1,
  first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gaps_type_key
  ON ai_analysis_gaps(gap_type, stable_key);

-- Add prompt_suggestions_json to ai_overview
ALTER TABLE ai_overview ADD COLUMN prompt_suggestions_json TEXT;
