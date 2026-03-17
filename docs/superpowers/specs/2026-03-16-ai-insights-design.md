# AI Insights System — Design Spec

> Transform the LinkedIn analytics dashboard from metric-first to insight-first, using an agentic LLM to analyze post performance and generate personalized, evidence-backed recommendations.

## 1. Goals

- **Primary**: Help the user understand what's working in their LinkedIn content and double down there
- **Secondary**: Surface compound patterns (topic × hook × timing) that manual analysis would miss
- **Tertiary**: Make insights evolve over time — each analysis builds on the last

### Non-goals

- Content generation (no "write this post for me")
- Real-time analysis (cached, refreshed on sync)
- Multi-user support (single creator, local SQLite)

## 2. Architecture Overview

```
Extension Sync → POST /api/ingest → Auto-trigger AI Pipeline
                                          ↓
                    ┌─────────────────────────────────────┐
                    │  Step 1: Tag (Haiku)                │
                    │  Classify each new post:            │
                    │  topics, hook type, tone, format    │
                    ├─────────────────────────────────────┤
                    │  Step 2: Analyze (Sonnet)           │
                    │  Agentic SQL-tool loop:             │
                    │  Pattern detection → Verification   │
                    ├─────────────────────────────────────┤
                    │  Step 3: Recommend (Sonnet)         │
                    │  3x self-consistency sampling        │
                    │  Keep findings in 2+ of 3 runs      │
                    └─────────────────────────────────────┘
                                          ↓
                    SQLite: ai_tags, insights, ai_logs,
                            recommendations, taxonomy
                                          ↓
                    Dashboard: Overview tab + Coach tab
```

### LLM Provider

OpenRouter via `TRUSTMIND_LLM_API_KEY` (OpenRouter key, format `sk-or-v1-...`). Uses Anthropic-compatible endpoint with `@anthropic-ai/sdk` — switching to direct Anthropic API later requires only changing `baseURL`.

Models:
- **Haiku** (`claude-haiku-4-5-20251001`): Post tagging (~$0.25/100 posts)
- **Sonnet** (`claude-sonnet-4-6`): Analysis + recommendations (~$0.07/run each)
- **Opus** (`claude-opus-4-6`): Taxonomy discovery (one-time, ~$0.15)

### Why Agentic (Not Static Prompts)

Research-backed decision (see `docs/ai-analysis-approach-research.md`):
- Static prompts can only find patterns the prompt author anticipated
- An agentic LLM with SQL tools can notice a signal, drill deeper, then control for confounders
- The CRITIC pattern (tool-grounded verification) produces substantial gains over introspection alone
- Multi-agent debate does NOT outperform simpler methods (ICML 2024)
- Self-consistency (3x sampling, majority vote) is the most cost-effective quality improvement

## 3. Database Additions

All new tables in the existing SQLite database.

```sql
-- Content taxonomy (auto-discovered by Opus)
CREATE TABLE ai_taxonomy (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  version INTEGER DEFAULT 1
);

-- Junction table for post-topic relationships (enables clean taxonomy re-mapping)
CREATE TABLE ai_post_topics (
  post_id TEXT NOT NULL REFERENCES posts(id),
  taxonomy_id INTEGER NOT NULL REFERENCES ai_taxonomy(id),
  PRIMARY KEY (post_id, taxonomy_id)
);

-- Per-post AI tags (non-topic dimensions)
CREATE TABLE ai_tags (
  post_id TEXT PRIMARY KEY REFERENCES posts(id),
  hook_type TEXT NOT NULL,        -- contrarian|story|question|statistic|listicle|observation|how-to|social-proof|vulnerable|none
  tone TEXT NOT NULL,             -- educational|inspirational|conversational|provocative|analytical|humorous|vulnerable
  format_style TEXT NOT NULL,     -- short-punchy|medium-structured|long-narrative|long-educational
  tagged_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  model TEXT
);

-- Analysis run metadata
CREATE TABLE ai_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  triggered_by TEXT NOT NULL,     -- 'sync' | 'manual' | 'schedule'
  status TEXT DEFAULT 'running',  -- 'running' | 'completed' | 'failed'
  post_count INTEGER,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  total_input_tokens INTEGER,
  total_output_tokens INTEGER,
  total_cost_cents REAL,
  error TEXT                     -- error message if status = 'failed'
);

-- Persisted insights with lineage
CREATE TABLE insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES ai_runs(id),
  category TEXT NOT NULL,         -- 'topic_performance' | 'compound_pattern' | 'format_insight' | 'timing' | 'trend' | 'hidden_opportunity'
  stable_key TEXT NOT NULL,       -- LLM-assigned stable identifier for cross-run matching (e.g. 'topic:hiring:positive', 'compound:story+contrarian')
  claim TEXT NOT NULL,
  evidence TEXT NOT NULL,          -- JSON: sample sizes, values, breakdowns, SQL queries used
  confidence TEXT NOT NULL,        -- 'strong' | 'moderate' | 'weak' | 'insufficient'
  direction TEXT,                  -- 'positive' | 'negative' | 'neutral' | 'reversal'
  first_seen_run_id INTEGER,
  consecutive_appearances INTEGER DEFAULT 1,
  status TEXT DEFAULT 'active',    -- 'active' | 'weakening' | 'reversed' | 'retired'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Insight lineage across runs
CREATE TABLE insight_lineage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  insight_id INTEGER NOT NULL REFERENCES insights(id),
  predecessor_id INTEGER REFERENCES insights(id),
  relationship TEXT NOT NULL       -- 'confirms' | 'strengthens' | 'weakens' | 'reverses' | 'supersedes'
);

-- User-facing recommendations
CREATE TABLE recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES ai_runs(id),
  type TEXT NOT NULL,              -- 'topic_opportunity' | 'format_suggestion' | 'timing' | 'trend_alert' | 'content_idea' | 'hidden_opportunity' | 'growth_insight'
  priority TEXT NOT NULL,          -- 'high' | 'medium' | 'low'
  confidence TEXT NOT NULL,        -- 'strong' | 'moderate' | 'weak'
  headline TEXT NOT NULL,
  detail TEXT NOT NULL,
  action TEXT NOT NULL,
  evidence_json TEXT,              -- JSON: supporting insight IDs, numbers, post references
  feedback TEXT,                   -- 'useful' | 'not_useful' | NULL
  feedback_at DATETIME,
  acted_on INTEGER DEFAULT 0,
  acted_on_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Overview summary cache
CREATE TABLE ai_overview (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES ai_runs(id),
  summary_text TEXT NOT NULL,      -- Natural language "what happened + why"
  top_performer_post_id TEXT REFERENCES posts(id),
  top_performer_reason TEXT,
  quick_insights TEXT NOT NULL,    -- JSON array of short insight strings
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Full I/O logging for every LLM call
CREATE TABLE ai_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER REFERENCES ai_runs(id),
  step TEXT NOT NULL,              -- 'taxonomy' | 'tagging' | 'pattern_detection' | 'verification' | 'recommendations' | 'overview'
  model TEXT NOT NULL,
  input_messages TEXT NOT NULL,    -- Full prompt/messages JSON
  output_text TEXT NOT NULL,       -- Full response
  tool_calls TEXT,                 -- JSON array of tool calls and results
  input_tokens INTEGER,
  output_tokens INTEGER,
  thinking_tokens INTEGER,
  duration_ms INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## 4. AI Pipeline

### 4.1 Taxonomy Discovery (Opus, one-time + re-discovery)

**When**: First run, or when post count doubles, or manual trigger.

**Input**: All post content previews + full research context (metric hierarchy, what we're optimizing for, content pillar framework from research doc).

**Output**: 5-15 topic categories at the right granularity for the creator's actual content. Stored in `ai_taxonomy`.

**Re-discovery**: Preserves continuity — merge/split/rename existing categories, don't restart from scratch. The Opus prompt receives the current taxonomy and outputs a migration plan: which IDs to keep, merge, split, or rename. Code applies the migration by updating `ai_post_topics` rows (simple UPDATE/DELETE on a junction table, no JSON parsing needed).

### 4.2 Post Tagging (Haiku, incremental)

**When**: After sync, for any untagged posts.

**Process**: Batch 20 posts per request. Haiku classifies each post on 4 dimensions (topics, hook_type, tone, format_style) using structured outputs (Zod schema). Tags stored in `ai_tags`.

**Cost**: ~$0.25 per 100 posts.

### 4.3 Analysis — Three-Stage Agentic Pipeline (Sonnet)

Uses `@anthropic-ai/sdk` with `toolRunner` via OpenRouter. The LLM gets two tools:

**Tool 1: `query_db`** — Executes read-only SQL SELECT against the analytics SQLite database. Schema description embedded in tool description. Results capped at 100 rows, formatted as markdown tables.

**Tool 2: `submit_analysis`** — Structured output tool the LLM calls to submit findings in a typed JSON schema.

The database connection for `query_db` is read-only (safety net).

#### Stage 1: Pattern Detection

System prompt includes:
- Pre-computed summary (~200 tokens): post count, date range, follower count, overall avg engagement
- Database schema description
- Instructions to explore freely, find noteworthy patterns
- For each pattern: state observation, generate 3+ explanations (including confounder-based), identify distinguishing SQL queries to run

The LLM runs 3-8 SQL queries iteratively, building understanding. Max 15 tool turns (safety cap).

#### Stage 2: Hypothesis Testing

Input: Stage 1 findings + domain-specific confounder checklist.

**Confounder checklist** (embedded in prompt):
- **Content confounders**: Topic/subject matter, content length, hook quality, CTA presence
- **Timing confounders**: Day of week, time of day, seasonality, posting frequency
- **Audience confounders**: Follower count at time of posting, external amplification
- **Measurement confounders**: Metric maturity (older posts had more time), impression threshold

For each finding: test alternative explanations via SQL, classify as SUPPORTED / PARTIALLY SUPPORTED / CONFOUNDED / INSUFFICIENT DATA.

Critical: confounded findings are still reported with the confounder identified (e.g., "your image posts underperform not because of format, but because they're generic tips rather than personal stories").

#### Stage 3: Synthesis + Recommendations

Input: Verified findings + uncertainty framework + feedback history.

**Self-consistency**: Run 3 independent recommendation generations. Each recommendation includes a structured `key` field (e.g. `topic:hiring:opportunity`, `format:carousel:suggestion`). After all 3 runs, code groups recommendations by key and keeps those appearing in 2+ of 3 runs. For kept recommendations, the version with the richest detail is selected. Cost: ~$0.21 total.

**Evidence strength labels** (NOT percentages — research shows LLMs cluster at 80-100% regardless):
- **STRONG**: Pattern consistent across subgroups, large effect, confounders ruled out
- **MODERATE**: Pattern visible but 1-2 confounders can't be ruled out
- **WEAK / PRELIMINARY**: Small sample (<10 per group), multiple alternatives
- **INSUFFICIENT**: Too few posts or wrong variables

**Sample size guardrails** (hard rules in every prompt):
- <5 posts per group: "Potential area to explore" only
- 5-10: "Preliminary signal, based on small sample"
- 10-20: "Moderate evidence, though sample is limited"
- 20+: Standard confidence language
- Always report exact group sizes: "text posts (n=23) vs image posts (n=8)"

**Data-tiered analysis** — capabilities gated by post count:

| Tier | Posts | Capabilities |
|------|-------|-------------|
| Foundation | 10-30 | Descriptive stats, simple rankings, content type comparison with caveats |
| Patterns | 30-60 | Topic clustering, hook analysis, day-of-week analysis, initial recommendations |
| Trends | 60-120 | Temporal trends, topic fatigue, statistical significance testing |
| Prediction | 120-250 | Seasonal patterns, audience evolution, predictive engagement ranges |
| Strategic | 250+ | Multi-variable analysis, content series analysis, algorithm sensitivity |

### 4.4 Insight Lineage

**Cross-run matching**: Each insight has a `stable_key` — a structured identifier assigned by the LLM via the `submit_analysis` tool (e.g. `topic:hiring:positive`, `compound:story+contrarian:positive`). The Stage 2 prompt receives all active insights from the previous run with their stable keys. The LLM is instructed to reuse existing keys when the same pattern is found, or create new keys for genuinely new patterns. Code matches new insights to predecessors by `stable_key`, then records the relationship:

- **CONFIRMED**: Same pattern, consistent evidence (consecutive_appearances++)
- **STRENGTHENED**: Same pattern, stronger evidence or larger sample
- **WEAKENED**: Same pattern but effect size decreasing or confounders emerging
- **REVERSED**: Previous insight no longer holds
- **SUPERSEDED**: New insight replaces old with better explanation

Insights that persist across 5+ runs are flagged as highly reliable. Insights that appeared once may be noise. Active insights from the previous run that are NOT matched by any new insight are marked `status = 'retired'`.

### 4.5 Overview Summary Generation

After analysis completes, a lightweight Haiku call generates:
- Natural-language summary sentence ("Your engagement rate hit a 30-day high this week...")
- Top performer identification with one-line explanation
- 2-3 quick insights pulled from the analysis

**Top performer selection**: Pre-computed in code before the Haiku call. Rank posts from the last 30 days by weighted engagement score (`comments*5 + shares*3 + saves*3 + sends*3 + reactions*1`), pick the highest. The post ID and its metrics are passed to Haiku, which generates the "why it worked" explanation using the post's AI tags.

Cached in `ai_overview`, served directly to the Overview tab.

## 5. API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/insights` | Latest cached analysis (patterns + recommendations) |
| GET | `/api/insights/overview` | AI summary for Overview tab |
| GET | `/api/insights/changelog` | What changed since last run |
| GET | `/api/insights/tags` | AI tags for all posts |
| GET | `/api/insights/taxonomy` | Current content taxonomy |
| POST | `/api/insights/refresh` | Trigger fresh analysis |
| PATCH | `/api/insights/recommendations/:id/feedback` | Record feedback (useful/not_useful/acted_on) |
| GET | `/api/insights/logs/:runId` | Full AI logs for a run (debugging) |

All insight endpoints return cached data from SQLite. No LLM calls on read.

## 6. Trigger & Caching Strategy

**Minimum threshold**: The analysis pipeline (Stages 1-3) requires at least 10 posts with metrics in the database. Tagging (Haiku) can run with fewer posts. If below threshold, the dashboard shows a message: "Need 10+ posts to generate insights. Keep syncing!"

**Auto-trigger**: After each successful `/api/ingest` sync, if 3+ new posts since last analysis run AND total posts >= 10.

**Concurrent run prevention**: `POST /api/insights/refresh` checks for `ai_runs` with `status = 'running'`. If one exists, return 409 with the run's start time. Only one analysis pipeline runs at a time.

**Staleness check**: Compare post count in latest `ai_runs` vs actual post count. Also check if any posts lack tags.

**No LLM calls on page load**: Dashboard always reads from cache. "Refresh" button triggers a new run.

**Error handling**: Each pipeline stage commits its results independently. If tagging succeeds but analysis fails, the tags are kept. A failed run (`status = 'failed'`) does NOT overwrite the previous successful run's cached data — the dashboard always shows the latest completed run. The `ai_runs` row stores error details in a `error TEXT` column. No automatic retry; the user can manually trigger a refresh.

**Query safety for `query_db` tool**: The tool enforces a 5-second query timeout, appends `LIMIT 100` to all queries (regardless of what the LLM writes), and restricts access to these tables only: `posts`, `post_metrics`, `follower_snapshots`, `profile_snapshots`, `ai_tags`, `ai_post_topics`, `ai_taxonomy`. The `ai_logs` table is excluded (could be very large).

**Cost control**: ~$0.45-0.80 per full analysis run. Monthly at daily syncs: ~$5-14.

## 7. Server Module Structure

```
server/src/
  ai/
    client.ts          -- OpenRouter client setup (@anthropic-ai/sdk with custom baseURL)
    tools.ts           -- query_db + submit_analysis tool definitions
    prompts.ts         -- System prompts for each stage (pattern detection, verification, synthesis)
    tagger.ts          -- Post classification (Haiku, structured outputs)
    taxonomy.ts        -- Taxonomy discovery (Opus)
    analyzer.ts        -- Three-stage agentic analysis (Sonnet)
    recommender.ts     -- Recommendation generation with self-consistency
    orchestrator.ts    -- Coordinates full pipeline: tag → analyze → recommend → overview
    logger.ts          -- Writes to ai_logs table
  db/
    ai-schema.sql      -- All new tables
    ai-queries.ts      -- Query functions for AI tables
  routes/
    insights.ts        -- All /api/insights/* route handlers
```

## 8. Dashboard Changes

### 8.1 Overview Tab (Transform)

**Remove**: Raw KPIs without context, static "recent posts" list (→ Posts tab), engagement by content type chart (→ Coach).

**Add**:
- **AI summary card**: Natural language "what happened + why" at the top
- **KPI cards with context**: Impressions, weighted engagement rate — each with % change vs previous 30 days
- **Top performer card**: Best post this period with "why it worked" explanation from AI
- **Quick insights**: 2-3 bullet points pulled from AI analysis

**Weighted engagement formula**: `(Comments×5 + Shares×3 + Saves×3 + Sends×3 + Reactions×1) / Impressions`

Note: The existing `queryOverview` function uses unweighted `(reactions + comments + reposts) / impressions`. The Overview tab will show the new weighted metric as the primary KPI, and the existing unweighted rate as a secondary/tooltip value. The Posts list keeps the unweighted rate for consistency with what LinkedIn shows natively.

### 8.2 Coach Tab (New)

Card-based, not chat-based. Research shows creators want scannable recommendations, not conversations.

**Each recommendation card shows**:
- Priority badge (HIGH / MED / LOW)
- Category label (Topic opportunity, Compound pattern, Format insight, etc.)
- Evidence strength indicator (Strong / Moderate / Weak)
- Headline (15 words max)
- Detail with specific numbers, sample sizes, and post references
- "Try next" action with specific suggestion
- Feedback buttons: Useful / Not useful / Done

**"What Changed" section** at the bottom:
- CONFIRMED: Pattern still holds (Nth consecutive run)
- NEW SIGNAL: Pattern emerging with early data
- REVERSED: Previous insight no longer true
- RETIRED: Previous recommendation withdrawn

**Key design principle**: The AI never says "X outperforms Y" without stating effect size and sample size, and flagging when confounders can't be ruled out. Honest uncertainty is more valuable than false confidence.

### 8.3 Post-Level Annotations

On the Posts tab, each post gets inline badges from AI tags:
- Topic tags
- Hook type
- Performance indicator (above/below/at average)
- Notable metrics (e.g., "12 saves — 4x your avg")

## 9. Observability

Every LLM call logged to `ai_logs` with full inputs, outputs, tool calls, token counts, and duration. This enables:
- Seeing exactly what SQL queries the agent ran
- Tracing the reasoning chain for any recommendation
- Comparing outputs across model versions or prompt iterations
- Re-running Stage 3 (synthesis) with different prompts without re-running analysis
- Debugging why a specific recommendation was generated or not

Stage 1 and Stage 2 outputs stored separately from Stage 3. Analytical reasoning doesn't clutter the dashboard.

## 10. Feedback Loop

Store recommendation feedback in the `recommendations` table. Include feedback history in future LLM prompts:
- Don't repeat dismissed recommendation types
- Weight towards categories the user finds valuable
- Track which recommendations led to action

## 11. Environment & Configuration

AI features gated behind `TRUSTMIND_LLM_API_KEY` env var. No API key = no AI features, dashboard works as before with static metrics.

Server `.env` file (gitignored):
```
TRUSTMIND_LLM_API_KEY=sk-or-v1-...
```

## 12. Cost Estimates

| Operation | Estimated Cost |
|-----------|---------------|
| Taxonomy discovery (Opus) | ~$0.15 (one-time) |
| Classify 100 posts (Haiku) | ~$0.25 |
| Pattern detection + verification (Sonnet) | ~$0.14 |
| Recommendations with 3x self-consistency (Sonnet) | ~$0.21 |
| Overview summary (Haiku) | ~$0.03 |
| **Total full analysis run** | **~$0.63** |

Monthly at daily analysis: ~$5-14. With prompt caching on subsequent runs: ~$0.25/run.
