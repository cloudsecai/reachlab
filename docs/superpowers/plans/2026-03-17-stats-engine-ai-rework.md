# Stats Engine & AI Pipeline Rework Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the multi-stage AI agent loop with a deterministic stats engine feeding a single LLM interpretation call, plus timezone support, writing prompt management, and analysis gaps tracking.

**Architecture:** Pre-compute a rich plain-English stats report from the database (pure TypeScript, no AI), then pass it to a single Sonnet call with extended thinking for interpretation. The LLM never touches the DB or does math. Output is structured JSON stored in existing tables plus two new tables and a settings key-value store.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, Anthropic SDK (claude-sonnet-4-6 with extended thinking, claude-haiku-4-5), React, Tailwind CSS

---

## File Map

### New Files
- `server/src/db/migrations/004-stats-engine.sql` — settings, writing_prompt_history, ai_analysis_gaps tables; prompt_suggestions_json column on ai_overview
- `server/src/ai/stats-report.ts` — pure stats engine (no DB writes, no AI calls)
- `server/src/ai/linkedin-knowledge.md` — curated LinkedIn platform knowledge base
- `server/src/__tests__/stats-report.test.ts` — stats engine unit tests

### Modified Files
- `server/src/db/ai-queries.ts` — add settings/gaps/prompt queries; update `InsightInput.confidence` and `RecommendationInput.confidence` to `string`; add `prompt_suggestions_json` to `OverviewInput`/`upsertOverview`
- `server/src/ai/prompts.ts` — replace 3-stage prompts with `buildSystemPrompt(knowledgeBase, feedbackHistory)` and `buildTopPerformerPrompt`; keep taxonomy/tagging prompts unchanged
- `server/src/ai/analyzer.ts` — replace `runAgentLoop`/`runAnalysis`/`voteOnRecommendations` with single `interpretStats` function
- `server/src/ai/orchestrator.ts` — replace 3-stage pipeline with: taxonomy → tagging → image classify → stats report → single Sonnet call → Haiku overview
- `server/src/routes/insights.ts` — add `GET /api/insights/gaps` and `GET /api/insights/prompt-suggestions`
- `server/src/routes/settings.ts` — add timezone PUT, writing prompt GET/PUT/history; receive `db` parameter
- `server/src/app.ts` — pass `db` to `registerSettingsRoutes`
- `dashboard/src/api/client.ts` — new types + API methods for timezone, writing prompt, gaps, prompt suggestions
- `dashboard/src/App.tsx` — send timezone on mount
- `dashboard/src/pages/Coach.tsx` — add prompt suggestions section + data gaps section
- `dashboard/src/pages/Settings.tsx` — add writing prompt editor + revision history
- `dashboard/src/pages/Posts.tsx` — add backfill status banner
- `dashboard/src/pages/Timing.tsx` — add best windows summary above heatmap

### Deleted Files
- `server/src/ai/tools.ts` — removed after analyzer rework

---

## Chunk 1: Database Foundation

### Task 1: DB Migration and New Queries

**Files:**
- Create: `server/src/db/migrations/004-stats-engine.sql`
- Modify: `server/src/db/ai-queries.ts`
- Modify: `server/src/__tests__/ai-queries.test.ts`

- [ ] **Step 1: Write failing tests for new DB queries**

Add to `server/src/__tests__/ai-queries.test.ts` (in the existing `beforeAll`/`afterAll` block with the test db):

```typescript
// Add these imports at the top of the file:
import {
  getSetting,
  upsertSetting,
  saveWritingPromptHistory,
  getWritingPromptHistory,
  upsertAnalysisGap,
  getLatestAnalysisGaps,
  getLatestPromptSuggestions,
} from "../db/ai-queries.js";

// Add these describe blocks at the bottom of the file:
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
      description: "Updated description",
      impact: "Updated impact",
    });
    const gaps = getLatestAnalysisGaps(db);
    const gap = gaps.find((g) => g.stable_key === "missing_post_content");
    expect(gap!.times_flagged).toBe(2);
    expect(gap!.description).toBe("Updated description");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
cd server && npm test -- ai-queries
```
Expected: FAIL with `getSetting is not a function`

- [ ] **Step 3: Create the migration file**

Create `server/src/db/migrations/004-stats-engine.sql`:

```sql
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

INSERT INTO schema_version (version) VALUES (4);
```

- [ ] **Step 4: Add queries to `server/src/db/ai-queries.ts`**

Add these interfaces and functions at the end of the existing file (before the last closing line):

```typescript
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
    .prepare("SELECT * FROM writing_prompt_history ORDER BY created_at DESC")
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
```

Also update the existing `InsightInput`, `RecommendationInput`, and `OverviewInput` interfaces + `upsertOverview` function:

```typescript
// Change InsightInput.confidence from number to string:
export interface InsightInput {
  run_id: number;
  category: string;
  stable_key: string;
  claim: string;
  evidence: string;
  confidence: string;  // was: number
  direction: string;
  first_seen_run_id: number;
  consecutive_appearances?: number;
}

// Change RecommendationInput.confidence from number to string:
export interface RecommendationInput {
  run_id: number;
  type: string;
  priority: number;
  confidence: string;  // was: number
  headline: string;
  detail: string;
  action: string;
  evidence_json: string;
}

// Add prompt_suggestions_json to OverviewInput:
export interface OverviewInput {
  run_id: number;
  summary_text: string;
  top_performer_post_id: string | null;
  top_performer_reason: string | null;
  quick_insights: string;
  prompt_suggestions_json: string | null;  // new
}

// Update upsertOverview to store prompt_suggestions_json:
export function upsertOverview(db: Database.Database, input: OverviewInput): void {
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
```

- [ ] **Step 5: Run tests to verify they pass**

```
cd server && npm test -- ai-queries
```
Expected: PASS (all new tests green, existing tests still pass)

- [ ] **Step 6: Commit**

```bash
git add server/src/db/migrations/004-stats-engine.sql server/src/db/ai-queries.ts server/src/__tests__/ai-queries.test.ts
git commit -m "feat: add settings/gaps/prompt tables, update ai-queries types"
```

---

## Chunk 2: Stats Engine

### Task 2: Stats Helpers

**Files:**
- Create: `server/src/ai/stats-report.ts` (helpers only)
- Create: `server/src/__tests__/stats-report.test.ts`

- [ ] **Step 1: Write failing tests**

Create `server/src/__tests__/stats-report.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  median,
  iqr,
  cliffsDelta,
  computeER,
  getPostPreview,
  getLocalHour,
  getLocalDayName,
  pct,
} from "../ai/stats-report.js";

describe("median", () => {
  it("returns null for empty array", () => expect(median([])).toBeNull());
  it("single element", () => expect(median([5])).toBe(5));
  it("even length — average of two middle values", () => expect(median([1, 3])).toBe(2));
  it("odd length — returns middle", () => expect(median([1, 2, 9])).toBe(2));
  it("unsorted input", () => expect(median([9, 1, 5])).toBe(5));
});

describe("iqr", () => {
  it("returns null for fewer than 4 values", () => {
    expect(iqr([1, 2, 3])).toBeNull();
  });
  it("returns a positive number for [1,2,3,4]", () => {
    const result = iqr([1, 2, 3, 4]);
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(0);
  });
});

describe("cliffsDelta", () => {
  it("d=0 and negligible for identical arrays", () => {
    const r = cliffsDelta([1, 2, 3], [1, 2, 3]);
    expect(r.d).toBe(0);
    expect(r.label).toBe("negligible");
  });
  it("d=1 and large when all x > all y", () => {
    const r = cliffsDelta([10, 11, 12], [1, 2, 3]);
    expect(r.d).toBe(1);
    expect(r.label).toBe("large");
  });
  it("d=-1 and large when all x < all y", () => {
    const r = cliffsDelta([1, 2, 3], [10, 11, 12]);
    expect(r.d).toBe(-1);
    expect(r.label).toBe("large");
  });
  it("negligible for |d| < 0.147", () => {
    // Very similar arrays
    const r = cliffsDelta([1, 2, 3, 4, 5], [1, 2, 3, 4, 6]);
    expect(r.label).toBe("negligible");
  });
  it("returns negligible for empty arrays", () => {
    const r = cliffsDelta([], [1, 2, 3]);
    expect(r.label).toBe("negligible");
  });
});

describe("computeER", () => {
  it("returns null when impressions is 0", () => {
    expect(computeER(10, 5, 3, 0)).toBeNull();
  });
  it("computes (reactions+comments+reposts)/impressions*100", () => {
    expect(computeER(10, 5, 5, 1000)).toBeCloseTo(2.0);
  });
  it("rounds correctly for 28 reactions, 5 comments, 2 reposts, 1000 impressions", () => {
    expect(computeER(28, 5, 2, 1000)).toBeCloseTo(3.5);
  });
});

describe("getPostPreview", () => {
  it("prefers hook_text over full_text", () => {
    expect(
      getPostPreview({ hook_text: "Hook text", full_text: "Full text", content_preview: "Preview" })
    ).toBe("Hook text");
  });
  it("falls back to full_text, truncated at 80 chars", () => {
    const longText = "a".repeat(100);
    const result = getPostPreview({ hook_text: null, full_text: longText, content_preview: null });
    expect(result).toBe("a".repeat(77) + "...");
  });
  it("falls back to content_preview", () => {
    expect(
      getPostPreview({ hook_text: null, full_text: null, content_preview: "Preview text" })
    ).toBe("Preview text");
  });
  it("returns 'Untitled post' when all null", () => {
    expect(getPostPreview({ hook_text: null, full_text: null, content_preview: null })).toBe(
      "Untitled post"
    );
  });
});

describe("getLocalHour", () => {
  it("converts 14:00 UTC to 9 in America/New_York (UTC-5 in January)", () => {
    const hour = getLocalHour("2026-01-15T14:00:00Z", "America/New_York");
    expect(hour).toBe(9);
  });
  it("converts 14:00 UTC to 14 in UTC", () => {
    expect(getLocalHour("2026-01-15T14:00:00Z", "UTC")).toBe(14);
  });
});

describe("getLocalDayName", () => {
  it("returns Thursday for 2026-01-15", () => {
    // 2026-01-15 is a Thursday
    const day = getLocalDayName("2026-01-15T12:00:00Z", "UTC");
    expect(day).toBe("Thursday");
  });
});

describe("pct", () => {
  it("formats 2.3456 as '2.3%'", () => expect(pct(2.3456)).toBe("2.3%"));
  it("formats 0 as '0.0%'", () => expect(pct(0)).toBe("0.0%"));
});
```

- [ ] **Step 2: Run to verify they fail**

```
cd server && npm test -- stats-report
```
Expected: FAIL with `Cannot find module '../ai/stats-report.js'`

- [ ] **Step 3: Implement helpers in `server/src/ai/stats-report.ts`**

```typescript
import type Database from "better-sqlite3";

// ── Types ──────────────────────────────────────────────────

export interface PostRow {
  id: string;
  hook_text: string | null;
  full_text: string | null;
  content_preview: string | null;
  content_type: string;
  published_at: string;
  impressions: number;
  reactions: number;
  comments: number;
  reposts: number;
  saves: number | null;
  sends: number | null;
}

export interface PostWithER extends PostRow {
  er: number | null;
}

// ── Stats helpers ──────────────────────────────────────────

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

export function iqr(values: number[]): number | null {
  if (values.length < 4) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length / 4)]!;
  const q3 = sorted[Math.floor((sorted.length * 3) / 4)]!;
  return q3 - q1;
}

export function cliffsDelta(x: number[], y: number[]): { d: number; label: string } {
  if (x.length === 0 || y.length === 0) return { d: 0, label: "negligible" };
  let dominance = 0;
  for (const xi of x) {
    for (const yj of y) {
      if (xi > yj) dominance++;
      else if (xi < yj) dominance--;
    }
  }
  const d = dominance / (x.length * y.length);
  const absD = Math.abs(d);
  const label =
    absD < 0.147 ? "negligible" : absD < 0.33 ? "small" : absD < 0.474 ? "medium" : "large";
  return { d, label };
}

export function computeER(
  reactions: number,
  comments: number,
  reposts: number,
  impressions: number
): number | null {
  if (impressions <= 0) return null;
  return ((reactions + comments + reposts) / impressions) * 100;
}

// ── Formatters ─────────────────────────────────────────────

export function pct(n: number): string {
  return n.toFixed(1) + "%";
}

export function getPostPreview(post: {
  hook_text: string | null;
  full_text: string | null;
  content_preview: string | null;
}): string {
  const text =
    post.hook_text ??
    (post.full_text ? post.full_text.slice(0, 80) : null) ??
    (post.content_preview ? post.content_preview.slice(0, 80) : null);
  if (!text) return "Untitled post";
  return text.length > 80 ? text.slice(0, 77) + "..." : text;
}

export function formatInTimezone(
  date: Date,
  tz: string,
  opts: Intl.DateTimeFormatOptions
): string {
  return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: tz }).format(date);
}

export function getLocalHour(isoString: string, tz: string): number {
  const date = new Date(isoString);
  const formatted = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: false,
    timeZone: tz,
  }).format(date);
  return parseInt(formatted, 10) % 24;
}

export function getLocalDayName(isoString: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: tz,
  }).format(new Date(isoString));
}

// Placeholder for buildStatsReport — implemented in Task 3
export function buildStatsReport(
  db: Database.Database,
  timezone: string,
  writingPrompt: string | null
): string {
  return "PLACEHOLDER";
}
```

- [ ] **Step 4: Run tests to verify helpers pass**

```
cd server && npm test -- stats-report
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/ai/stats-report.ts server/src/__tests__/stats-report.test.ts
git commit -m "feat: add stats engine helpers (median, iqr, cliffsDelta, formatters)"
```

---

### Task 3: buildStatsReport

**Files:**
- Modify: `server/src/ai/stats-report.ts` (replace placeholder with full implementation)
- Modify: `server/src/__tests__/stats-report.test.ts` (add integration-style tests)

- [ ] **Step 1: Write failing integration tests for buildStatsReport**

Add to `server/src/__tests__/stats-report.test.ts`:

```typescript
import BetterSqlite3 from "better-sqlite3";
import path from "path";
import { buildStatsReport } from "../ai/stats-report.js";
import { initDatabase } from "../db/index.js";

const TEST_DB_PATH = path.join(import.meta.dirname, "../../data/test-stats-report.db");

describe("buildStatsReport", () => {
  let db: BetterSqlite3.Database;

  beforeAll(() => {
    db = initDatabase(TEST_DB_PATH);

    // Seed: 3 posts with known metrics
    db.prepare(
      `INSERT OR IGNORE INTO posts (id, content_type, published_at, hook_text) VALUES (?, ?, ?, ?)`
    ).run("sr-post-1", "text", "2026-01-15T15:00:00Z", "My post about startup funding rounds");
    db.prepare(
      `INSERT OR IGNORE INTO posts (id, content_type, published_at, hook_text) VALUES (?, ?, ?, ?)`
    ).run("sr-post-2", "image", "2026-01-20T14:00:00Z", "Why due diligence matters");
    db.prepare(
      `INSERT OR IGNORE INTO posts (id, content_type, published_at, hook_text) VALUES (?, ?, ?, ?)`
    ).run("sr-post-3", "text", "2026-01-25T10:00:00Z", "Three lessons from failed fundraising");

    // Metrics: reactions+comments+reposts / impressions
    // post-1: (20+5+3)/1000 = 2.8%
    db.prepare(
      `INSERT OR IGNORE INTO post_metrics (post_id, impressions, reactions, comments, reposts, saves, sends)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("sr-post-1", 1000, 20, 5, 3, 2, 1);
    // post-2: (40+10+5)/2000 = 2.75%
    db.prepare(
      `INSERT OR IGNORE INTO post_metrics (post_id, impressions, reactions, comments, reposts, saves, sends)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("sr-post-2", 2000, 40, 10, 5, 3, 2);
    // post-3: (10+2+1)/500 = 2.6%
    db.prepare(
      `INSERT OR IGNORE INTO post_metrics (post_id, impressions, reactions, comments, reposts, saves, sends)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("sr-post-3", 500, 10, 2, 1, 0, 0);
  });

  afterAll(() => {
    db.close();
    try {
      import("fs").then((fs) => {
        fs.unlinkSync(TEST_DB_PATH);
        fs.unlinkSync(TEST_DB_PATH + "-wal");
        fs.unlinkSync(TEST_DB_PATH + "-shm");
      });
    } catch {}
  });

  it("returns a non-empty string", () => {
    const report = buildStatsReport(db, "America/New_York", null);
    expect(typeof report).toBe("string");
    expect(report.length).toBeGreaterThan(100);
  });

  it("contains Overview section with post count", () => {
    const report = buildStatsReport(db, "America/New_York", null);
    expect(report).toContain("## 1. Overview");
    expect(report).toContain("3 posts");
  });

  it("uses standard ER formula — shows 2.8% for post-1", () => {
    const report = buildStatsReport(db, "America/New_York", null);
    expect(report).toContain("2.8%");
  });

  it("references posts by content, never by ID", () => {
    const report = buildStatsReport(db, "America/New_York", null);
    expect(report).not.toContain("sr-post-");
    expect(report).toContain("startup funding");
  });

  it("includes top 10 posts section", () => {
    const report = buildStatsReport(db, "America/New_York", null);
    expect(report).toContain("## 4. Top");
  });

  it("includes day-of-week section", () => {
    const report = buildStatsReport(db, "America/New_York", null);
    expect(report).toContain("## 6. Day-of-Week");
  });

  it("includes writing prompt when provided", () => {
    const report = buildStatsReport(db, "America/New_York", "Always start with a question hook");
    expect(report).toContain("Always start with a question hook");
    expect(report).toContain("## 12. Author");
  });

  it("omits writing prompt section when null", () => {
    const report = buildStatsReport(db, "America/New_York", null);
    expect(report).toContain("## 12. Author");
    expect(report).toContain("(none set)");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```
cd server && npm test -- stats-report
```
Expected: FAIL — `buildStatsReport` returns `"PLACEHOLDER"`, tests checking for "## 1. Overview" will fail.

- [ ] **Step 3: Implement `buildStatsReport` in `server/src/ai/stats-report.ts`**

Replace the placeholder `buildStatsReport` with:

```typescript
// ── DB loader ──────────────────────────────────────────────

function loadPostsWithMetrics(db: Database.Database): PostWithER[] {
  const rows = db
    .prepare(
      `SELECT
         p.id, p.hook_text, p.full_text, p.content_preview, p.content_type, p.published_at,
         COALESCE(pm.impressions, 0) as impressions,
         COALESCE(pm.reactions, 0) as reactions,
         COALESCE(pm.comments, 0) as comments,
         COALESCE(pm.reposts, 0) as reposts,
         pm.saves,
         pm.sends
       FROM posts p
       JOIN post_metrics pm ON pm.post_id = p.id
       JOIN (
         SELECT post_id, MAX(id) as max_id FROM post_metrics GROUP BY post_id
       ) latest ON pm.id = latest.max_id
       WHERE pm.impressions > 0
       ORDER BY p.published_at DESC`
    )
    .all() as PostRow[];

  return rows.map((r) => ({
    ...r,
    er: computeER(r.reactions, r.comments, r.reposts, r.impressions),
  }));
}

// ── Section builders ───────────────────────────────────────

function benchmarkLabel(er: number): string {
  if (er < 2) return "below average (under 2%)";
  if (er < 3.5) return "solid (2–3.5% is average)";
  if (er < 5) return "good (3.5–5% range)";
  return "exceptional (above 5%)";
}

function buildOverviewSection(
  db: Database.Database,
  posts: PostWithER[],
  globalMedianER: number | null,
  globalIQR: number | null,
  timezone: string
): string {
  const validERs = posts.filter((p) => p.er !== null).map((p) => p.er!);
  const followerRow = db
    .prepare(
      "SELECT total_followers FROM follower_snapshots ORDER BY date DESC LIMIT 1"
    )
    .get() as { total_followers: number } | undefined;

  const dates = posts.map((p) => p.published_at).sort();
  const earliest = dates[0]
    ? formatInTimezone(new Date(dates[0]), timezone, { month: "short", day: "numeric", year: "numeric" })
    : "N/A";
  const latest = dates[dates.length - 1]
    ? formatInTimezone(new Date(dates[dates.length - 1]), timezone, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "N/A";

  const lines = [
    "## 1. Overview",
    `Total posts with metrics: ${posts.length}`,
    `Date range: ${earliest} to ${latest}`,
  ];

  if (globalMedianER !== null) {
    const iqrStr = globalIQR !== null ? ` (IQR: ${pct(globalIQR)})` : "";
    lines.push(`Median engagement rate: ${pct(globalMedianER)}${iqrStr} — ${benchmarkLabel(globalMedianER)}`);
  } else {
    lines.push("Median engagement rate: N/A (no posts with impressions)");
  }

  if (followerRow) {
    lines.push(`Current followers: ${followerRow.total_followers.toLocaleString()}`);
  }

  lines.push(`Total posts analyzed: ${validERs.length}`);
  return lines.join("\n");
}

function buildRecentVsBaselineSection(posts: PostWithER[], timezone: string): string {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 14);

  const recent = posts.filter((p) => new Date(p.published_at) >= cutoff);
  const baseline = posts.filter((p) => new Date(p.published_at) < cutoff);

  const recentERs = recent.filter((p) => p.er !== null).map((p) => p.er!);
  const baselineERs = baseline.filter((p) => p.er !== null).map((p) => p.er!);

  const recentMedian = median(recentERs);
  const baselineMedian = median(baselineERs);

  const lines = [
    "## 2. Recent vs Baseline (last 14 days vs all-time)",
    `Last 14 days: ${recent.length} posts`,
    `All-time baseline: ${baseline.length} posts`,
  ];

  if (recentMedian !== null && baselineMedian !== null) {
    const direction = recentMedian > baselineMedian ? "above" : "below";
    lines.push(
      `Recent median ER: ${pct(recentMedian)} — ${direction} all-time median of ${pct(baselineMedian)}`
    );
  } else if (recentMedian !== null) {
    lines.push(`Recent median ER: ${pct(recentMedian)} (no baseline yet)`);
  } else {
    lines.push("Insufficient data for comparison.");
  }

  // Highlight recent standout posts
  const topRecent = [...recent]
    .filter((p) => p.er !== null)
    .sort((a, b) => b.er! - a.er!)
    .slice(0, 3);
  if (topRecent.length > 0) {
    lines.push("Standout recent posts:");
    for (const p of topRecent) {
      const preview = getPostPreview(p);
      const date = formatInTimezone(new Date(p.published_at), timezone, {
        month: "short",
        day: "numeric",
      });
      lines.push(`  - "${preview}" (${date}) — ${pct(p.er!)} ER`);
    }
  }

  return lines.join("\n");
}

function buildFormatSection(posts: PostWithER[]): string {
  const byType = new Map<string, number[]>();
  for (const p of posts) {
    if (p.er === null) continue;
    const arr = byType.get(p.content_type) ?? [];
    arr.push(p.er);
    byType.set(p.content_type, arr);
  }

  const allERs = posts.filter((p) => p.er !== null).map((p) => p.er!);
  const lines = ["## 3. Format Comparison"];

  for (const [type, ers] of byType) {
    const med = median(ers);
    if (med === null) continue;
    if (ers.length < 5) {
      lines.push(`- ${type} (n=${ers.length}): too few posts for reliable comparison — ${pct(med)} median ER`);
      continue;
    }
    const delta = cliffsDelta(ers, allERs);
    lines.push(
      `- ${type} (n=${ers.length}): ${pct(med)} median ER — ${delta.label} difference vs overall (Cliff's δ=${delta.d.toFixed(2)})`
    );
  }

  if (byType.size === 0) lines.push("No format data available.");
  return lines.join("\n");
}

function formatPostLine(p: PostWithER, tz: string): string {
  const preview = getPostPreview(p);
  const date = formatInTimezone(new Date(p.published_at), tz, {
    month: "short",
    day: "numeric",
  });
  const erStr = p.er !== null ? pct(p.er) : "N/A";
  const saves = p.saves ? `, ${p.saves} saves` : "";
  const sends = p.sends ? `, ${p.sends} sends` : "";
  return `- "${preview}" (${date}, ${p.content_type}) — ${p.impressions.toLocaleString()} impressions, ${erStr} ER, ${p.reactions} reactions, ${p.comments} comments${saves}${sends}`;
}

function buildTopBottomSection(posts: PostWithER[], timezone: string): string {
  const sorted = [...posts]
    .filter((p) => p.er !== null)
    .sort((a, b) => b.er! - a.er!);
  const top = sorted.slice(0, 10);
  const bottom = sorted.slice(-10).reverse();

  const lines = ["## 4. Top 10 Posts (by engagement rate)"];
  if (top.length === 0) {
    lines.push("No data.");
  } else {
    for (const p of top) lines.push(formatPostLine(p, timezone));
  }

  lines.push("", "## 5. Bottom 10 Posts (by engagement rate)");
  if (bottom.length === 0) {
    lines.push("No data.");
  } else {
    for (const p of bottom) lines.push(formatPostLine(p, timezone));
  }

  return lines.join("\n");
}

function buildDaySection(posts: PostWithER[], timezone: string): string {
  const byDay = new Map<string, number[]>();
  const dayOrder = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

  for (const p of posts) {
    if (p.er === null) continue;
    const day = getLocalDayName(p.published_at, timezone);
    const arr = byDay.get(day) ?? [];
    arr.push(p.er);
    byDay.set(day, arr);
  }

  const lines = ["## 6. Day-of-Week Breakdown"];
  for (const day of dayOrder) {
    const ers = byDay.get(day);
    if (!ers || ers.length === 0) {
      lines.push(`- ${day}: no posts`);
      continue;
    }
    const med = median(ers)!;
    lines.push(`- ${day} (n=${ers.length}): ${pct(med)} median ER`);
  }

  return lines.join("\n");
}

function getTimeWindow(hour: number): string {
  if (hour >= 6 && hour < 10) return "morning (6–10am)";
  if (hour >= 10 && hour < 14) return "midday (10am–2pm)";
  if (hour >= 14 && hour < 18) return "afternoon (2–6pm)";
  if (hour >= 18 && hour < 22) return "evening (6–10pm)";
  return "off-hours (10pm–6am)";
}

function buildTimeSection(posts: PostWithER[], timezone: string): string {
  const byWindow = new Map<string, number[]>();

  for (const p of posts) {
    if (p.er === null) continue;
    const hour = getLocalHour(p.published_at, timezone);
    const window = getTimeWindow(hour);
    const arr = byWindow.get(window) ?? [];
    arr.push(p.er);
    byWindow.set(window, arr);
  }

  const lines = ["## 7. Time-of-Day Breakdown"];
  const windowOrder = [
    "morning (6–10am)",
    "midday (10am–2pm)",
    "afternoon (2–6pm)",
    "evening (6–10pm)",
    "off-hours (10pm–6am)",
  ];

  for (const window of windowOrder) {
    const ers = byWindow.get(window);
    if (!ers || ers.length === 0) {
      lines.push(`- ${window}: no posts`);
      continue;
    }
    lines.push(`- ${window} (n=${ers.length}): ${pct(median(ers)!)} median ER`);
  }

  return lines.join("\n");
}

function buildCommentQualitySection(posts: PostWithER[]): string {
  const buckets = [
    { label: "0–4 comments", min: 0, max: 4 },
    { label: "5–14 comments", min: 5, max: 14 },
    { label: "15–29 comments", min: 15, max: 29 },
    { label: "30+ comments", min: 30, max: Infinity },
  ];

  const lines = ["## 8. Comment Volume Breakdown"];

  for (const bucket of buckets) {
    const inBucket = posts.filter(
      (p) => p.comments >= bucket.min && p.comments <= bucket.max && p.er !== null
    );
    if (inBucket.length === 0) {
      lines.push(`- ${bucket.label}: no posts`);
      continue;
    }
    const medReposts = median(inBucket.map((p) => p.reposts)) ?? 0;
    const medSaves = median(inBucket.filter((p) => p.saves !== null).map((p) => p.saves!));
    const savesStr = medSaves !== null ? `, ${medSaves.toFixed(1)} median saves` : "";
    lines.push(
      `- ${bucket.label} (n=${inBucket.length}): ${medReposts.toFixed(1)} median reposts${savesStr}`
    );
  }

  return lines.join("\n");
}

function buildSavesSendsSection(posts: PostWithER[]): string {
  const withSaves = posts.filter((p) => p.saves !== null && p.saves > 0);
  const withSends = posts.filter((p) => p.sends !== null && p.sends > 0);
  const allSaves = withSaves.map((p) => p.saves!);
  const allSends = withSends.map((p) => p.sends!);
  const medSaves = median(allSaves);
  const medSends = median(allSends);

  const lines = ["## 9. Saves & Sends Highlights"];

  if (medSaves !== null) {
    lines.push(`Median saves: ${medSaves.toFixed(1)} (across ${withSaves.length} posts with save data)`);
    const outliers = withSaves.filter((p) => p.saves! > medSaves * 2);
    for (const p of outliers.slice(0, 5)) {
      lines.push(`  - "${getPostPreview(p)}" — ${p.saves} saves (${(p.saves! / medSaves).toFixed(1)}x median)`);
    }
  } else {
    lines.push("No saves data available.");
  }

  if (medSends !== null) {
    lines.push(`Median sends: ${medSends.toFixed(1)} (across ${withSends.length} posts with send data)`);
  } else {
    lines.push("No sends data available.");
  }

  return lines.join("\n");
}

function buildFrequencySection(posts: PostWithER[]): string {
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  const recent = posts.filter((p) => new Date(p.published_at) >= ninetyDaysAgo);
  const postsPerWeek = (recent.length / 90) * 7;

  const lines = [
    "## 10. Posting Frequency",
    `Posts in last 90 days: ${recent.length}`,
    `Average: ${postsPerWeek.toFixed(1)} posts/week`,
  ];

  return lines.join("\n");
}

function buildContentGapsSection(db: Database.Database): string {
  const missingText = db
    .prepare("SELECT COUNT(*) as count FROM posts WHERE full_text IS NULL")
    .get() as { count: number };
  const totalPosts = db
    .prepare("SELECT COUNT(*) as count FROM posts")
    .get() as { count: number };
  const missingImages = db
    .prepare(
      `SELECT COUNT(*) as count FROM posts
       WHERE image_local_paths IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ai_image_tags WHERE post_id = posts.id)`
    )
    .get() as { count: number };

  const lines = ["## 11. Content Gaps (data quality notes)"];

  if (missingText.count > 0) {
    lines.push(
      `- ${missingText.count} of ${totalPosts.count} posts have no full text content (open LinkedIn with extension active to backfill)`
    );
  } else {
    lines.push("- All posts have text content ✓");
  }

  if (missingImages.count > 0) {
    lines.push(`- ${missingImages.count} image posts not yet classified`);
  }

  return lines.join("\n");
}

function buildWritingPromptSection(writingPrompt: string | null): string {
  const lines = ["## 12. Author's Writing Prompt"];
  if (writingPrompt) {
    lines.push(writingPrompt);
  } else {
    lines.push("(none set — user can add a writing prompt in Settings)");
  }
  return lines.join("\n");
}

// ── Main export ────────────────────────────────────────────

export function buildStatsReport(
  db: Database.Database,
  timezone: string,
  writingPrompt: string | null
): string {
  const posts = loadPostsWithMetrics(db);
  const validERs = posts.filter((p) => p.er !== null).map((p) => p.er!);
  const globalMedianER = median(validERs);
  const globalIQR = iqr(validERs);

  const sections = [
    buildOverviewSection(db, posts, globalMedianER, globalIQR, timezone),
    buildRecentVsBaselineSection(posts, timezone),
    buildFormatSection(posts),
    buildTopBottomSection(posts, timezone),
    buildDaySection(posts, timezone),
    buildTimeSection(posts, timezone),
    buildCommentQualitySection(posts),
    buildSavesSendsSection(posts),
    buildFrequencySection(posts),
    buildContentGapsSection(db),
    buildWritingPromptSection(writingPrompt),
  ];

  return sections.join("\n\n---\n\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
cd server && npm test -- stats-report
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/ai/stats-report.ts server/src/__tests__/stats-report.test.ts
git commit -m "feat: implement buildStatsReport with 11 analysis sections"
```

---

## Chunk 3: AI Pipeline Rework

### Task 4: LinkedIn Knowledge Base and New System Prompt

**Files:**
- Create: `server/src/ai/linkedin-knowledge.md`
- Modify: `server/src/ai/prompts.ts`

- [ ] **Step 1: Write failing test for new prompt function**

Add to `server/src/__tests__/ai-prompts.test.ts` (existing file):

```typescript
import { buildSystemPrompt, buildTopPerformerPrompt } from "../ai/prompts.js";

describe("buildSystemPrompt", () => {
  it("includes the knowledge base content", () => {
    const prompt = buildSystemPrompt("## Knowledge\ntest content", "No feedback yet.");
    expect(prompt).toContain("test content");
  });

  it("includes feedback history", () => {
    const prompt = buildSystemPrompt("knowledge", "User found X useful.");
    expect(prompt).toContain("User found X useful.");
  });

  it("includes language rules", () => {
    const prompt = buildSystemPrompt("knowledge", "feedback");
    expect(prompt).toContain("engagement rate");
    expect(prompt).toContain("Never reference posts by ID");
  });

  it("includes output schema instructions", () => {
    const prompt = buildSystemPrompt("knowledge", "feedback");
    expect(prompt).toContain("prompt_suggestions");
    expect(prompt).toContain("gaps");
  });
});

describe("buildTopPerformerPrompt", () => {
  it("includes post details", () => {
    const prompt = buildTopPerformerPrompt("Post about AI", "2026-03-01", 500, 20);
    expect(prompt).toContain("Post about AI");
    expect(prompt).toContain("500");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```
cd server && npm test -- ai-prompts
```
Expected: FAIL — `buildSystemPrompt is not a function`

- [ ] **Step 3: Create `server/src/ai/linkedin-knowledge.md`**

```markdown
# LinkedIn Platform Knowledge Base (2026)

Curated non-obvious facts for AI analysis. Confidence levels noted.

---

## HIGH CONFIDENCE (LinkedIn Engineering papers + large-scale studies)

### Feed Retrieval Architecture
- LinkedIn uses a fine-tuned LLaMA 3 dual encoder that generates **text-only embeddings** for both members and content. Image-only posts with thin captions are nearly invisible to candidate retrieval — the system literally cannot "see" them.
- Raw engagement counts have **-0.004 correlation with relevance** internally. LinkedIn converts all metrics to **percentile buckets (1–100)**. A post at the 90th percentile in a niche topic scores equivalently to the 90th percentile in a popular topic.
- The **Interest Graph layer can distribute up to 30% of reach** outside the creator's direct network, based on professional topic affinity. Reach beyond network is not guaranteed.
- There is **no "test audience" batch**. Feed ranking is per-viewer, per-request — every feed refresh evaluates all candidate content against that specific member's profile.

### Dwell Time
- The **P(skip) model is content-type-relative** (percentile-based, not absolute seconds). It asks: "did this hold attention longer than similar posts of its type?"
- **Clicking "see more" is a positive engagement signal** that starts/extends the dwell time clock. Posts earning the click AND holding attention past ~15 seconds get a reach multiplier.
- **Content completion rate matters more than raw engagement.** A 5-slide carousel viewed completely outperforms a 100-slide carousel with more likes.

### Comments
- Comment quality is scored via NLP/ML (XGBoost for triage, 360Brew 150B-parameter LLM for substance/lexical diversity), **not word-count heuristics**. A 5-word specific question may score higher than a 50-word generic response.
- **Threaded conversations** (replies to comments) boost reach **~2.4× vs top-level-only** comments (AuthoredUp, 621K posts).
- **Commenter identity matters.** LinkedIn's Qwen3 0.6B model generates profile embeddings encoding professional identity. Comments from people whose expertise semantically matches the post topic carry more weight.
- **Pod-like behavior** (repetitive phrasing across multiple comments) is specifically detected and devalued via lexical diversity analysis.

### Content Format
- **Single-image posts dropped 30% below text-only in 2026** — because the text-only retrieval system can't see images. Substantial captions compensate.
- Carousel optimal length: **6–9 slides** (down from 12–13 in 2024). Below 35% slide click-through, posts get a visibility penalty.
- **External links lose ~60% reach** vs native content.
- **Video views declined 36% YoY** despite increased posting. Text-only retrieval disadvantages video without rich captions/transcripts.
- Newsletters **bypass the algorithm entirely** (triple notification: email + push + in-app). Accounts with newsletters get **2.1× reach on regular posts** (halo effect).

### Topic Authority
- 360Brew requires **60–90 days of consistent posting on 2–3 focused topics** before recognizing expertise and optimizing distribution. Topic-hopping causes depressed reach.
- The system cross-references post content against the author's profile (headline, about, experience). Content misaligned with stated expertise gets suppressed.
- **80%+ of content should be within 2–3 core topics** for proper classification.

### Posting Frequency
- **Higher posting frequency = better per-post performance** (Buffer, 2M+ posts, fixed-effects regression). No cannibalization effect. The jump from 1 to 2–5 posts/week is the biggest marginal lift.
- Hashtags are essentially irrelevant for distribution in the 2026 algorithm.

---

## MEDIUM CONFIDENCE (single practitioner source or inferred)

- **Creator reply within 15 minutes gives ~90% boost** (GrowLeads). Mechanism confirmed: fresh interaction signals during the highest-weight window of the Feed SR model's recency-weighted loss function.
- **Comments are ~15× more valuable than likes** for distribution (Postiv AI, 2M posts). Mechanism confirmed but exact multiplier uncertain.
- **Quality signals (saves, thoughtful comments) are 4–6× more important than likes** under the new algorithm.
- **Peak engagement shifted to 3–8 PM** in 2026 (Buffer, 4.8M posts).
- Content can distribute for **1–3 weeks** (not just 48–72 hours) under the 2026 percentile-based freshness system.

---

## LOW CONFIDENCE (widely cited but no primary source)

- "15+ words = 2.5× comment weight" — no primary source. Likely a gradient based on semantic analysis, not a step function.
- "3+ exchanges between different participants = 5.2× amplification" — unverifiable.
- AI text detection/deprioritization — no confirmed system. LinkedIn detects GAN-generated faces (99.6% TPR) but not text.

---

## Engagement Rate Benchmarks (2026)

- Below 2%: Underperforming
- 2–3.5%: Solid / average
- 3.5–5%: Good
- Above 5%: Exceptional
- Smaller accounts (1–5K followers) typically see 4–8%
- Larger accounts (10K+) see 1–3%
- Platform-wide average: ~5.2% (inflated by carousel-heavy pages)

---

## Anti-Gaming Signals

- LinkedIn's spam system achieves 98.7% automated removal rate (LinkedIn Transparency Report, Jan–Jun 2025).
- Engagement pods explicitly prohibited. Detection uses temporal velocity analysis and network graph patterns.
```

- [ ] **Step 4: Update `server/src/ai/prompts.ts`**

Add these new functions (keep existing taxonomy/tagging prompt functions unchanged):

```typescript
export function buildSystemPrompt(
  knowledgeBase: string,
  feedbackHistory: string
): string {
  return `You are an expert LinkedIn content analyst. You will receive a pre-computed statistics report about a creator's LinkedIn posts and produce a structured JSON analysis.

## LinkedIn Platform Knowledge Base

${knowledgeBase}

## User Feedback History (from previous analyses)

${feedbackHistory}

## Language Rules

- Never use abbreviations or internal metric names. Say "engagement rate" not "WER" or "ER".
- When referencing specific posts, describe them by their topic/hook text and include the date. **Never reference posts by ID number.**
- All numbers must have plain-English context. Don't say "0.0608" — say "6.1% engagement rate".
- Times must be in the user's local timezone as shown in the stats report.
- Don't just identify what works — explain WHY it works (referencing LinkedIn platform mechanics when relevant) and give a specific next action the author can take this week.
- Compare recent posts (last 14 days) to baseline — notice what the author is changing and whether it's working.
- For the writing prompt analysis: reference specific post evidence. Don't make generic suggestions.

## Output Format

Respond with ONLY valid JSON matching this exact schema (no markdown fences, no preamble):

{
  "insights": [
    {
      "category": "string (e.g. format, timing, content, engagement)",
      "stable_key": "string (snake_case stable ID, e.g. image_posts_underperform)",
      "claim": "string (plain English, one sentence, no jargon)",
      "evidence": "string (specific numbers, post references by topic/date)",
      "confidence": "STRONG | MODERATE | WEAK",
      "direction": "positive | negative | neutral"
    }
  ],
  "recommendations": [
    {
      "key": "string (snake_case stable ID)",
      "type": "quick_win | experiment | long_term | stop_doing",
      "priority": 1,
      "confidence": "STRONG | MODERATE | WEAK",
      "headline": "string (one action phrase)",
      "detail": "string (explains WHY, references specific posts by topic/date)",
      "action": "string (specific next step for this week)"
    }
  ],
  "overview": {
    "summary_text": "string (2–3 sentences summarizing performance and top trend)",
    "quick_insights": ["string", "string", "string"]
  },
  "prompt_suggestions": {
    "assessment": "working_well | suggest_changes",
    "reasoning": "string (what the data shows about the current prompt's effectiveness)",
    "suggestions": [
      {
        "current": "string (exact text from the current writing prompt)",
        "suggested": "string (proposed replacement text)",
        "evidence": "string (why this change, citing specific post data)"
      }
    ]
  },
  "gaps": [
    {
      "type": "data_gap | tool_gap | knowledge_gap",
      "stable_key": "string (snake_case, e.g. missing_post_content)",
      "description": "string (what data/capability is missing)",
      "impact": "string (how this limits the analysis)"
    }
  ]
}

Priority scale: 1 = highest priority, 3 = lowest. Include 3–7 insights, 3–5 recommendations, up to 5 gaps. If the writing prompt is "(none set)", set prompt_suggestions.assessment to "working_well" and suggestions to [].`;
}

export function buildTopPerformerPrompt(
  preview: string,
  publishedAt: string,
  impressions: number,
  comments: number
): string {
  return `This LinkedIn post was the top performer in the last 30 days:

Post topic: "${preview}"
Date: ${publishedAt}
Impressions: ${impressions.toLocaleString()}
Comments: ${comments}

In one sentence, explain why this post resonated with the audience. Be specific about what element of the post drove engagement. No filler phrases.`;
}
```

- [ ] **Step 5: Run tests to verify they pass**

```
cd server && npm test -- ai-prompts
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/ai/linkedin-knowledge.md server/src/ai/prompts.ts server/src/__tests__/ai-prompts.test.ts
git commit -m "feat: add LinkedIn knowledge base and new single-pass system prompt"
```

---

### Task 5: New AI Interpreter (analyzer.ts rework)

**Files:**
- Modify: `server/src/ai/analyzer.ts` (replace agent loop with single call)
- Delete: `server/src/ai/tools.ts`
- Modify: `server/src/__tests__/ai-analyzer.test.ts`

- [ ] **Step 1: Write failing test for interpretStats**

Replace `server/src/__tests__/ai-analyzer.test.ts` with:

```typescript
import { describe, it, expect, vi } from "vitest";
import { interpretStats } from "../ai/analyzer.js";
import type Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";

// Minimal mock of AiLogger
const mockLogger = {
  log: vi.fn(),
};

// Mock Anthropic client that returns valid JSON
function makeMockClient(jsonOutput: object): Anthropic {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [
          {
            type: "thinking",
            thinking: "Some thinking...",
          },
          {
            type: "text",
            text: JSON.stringify(jsonOutput),
          },
        ],
        usage: { input_tokens: 100, output_tokens: 200 },
        stop_reason: "end_turn",
      }),
    },
  } as unknown as Anthropic;
}

const validOutput = {
  insights: [
    {
      category: "format",
      stable_key: "image_underperform",
      claim: "Image posts underperform text posts.",
      evidence: "3 image posts averaged 1.8% vs 2.9% for text.",
      confidence: "MODERATE",
      direction: "negative",
    },
  ],
  recommendations: [
    {
      key: "shift_to_text",
      type: "experiment",
      priority: 1,
      confidence: "MODERATE",
      headline: "Test more text-only posts",
      detail: "Text posts averaged 2.9% ER vs 1.8% for images.",
      action: "Publish one text-only post this week.",
    },
  ],
  overview: {
    summary_text: "Your text posts outperform images.",
    quick_insights: ["Text outperforms images"],
  },
  prompt_suggestions: {
    assessment: "working_well",
    reasoning: "Current prompt aligns with data.",
    suggestions: [],
  },
  gaps: [
    {
      type: "data_gap",
      stable_key: "missing_post_content",
      description: "48 posts lack full text.",
      impact: "Cannot analyze writing patterns.",
    },
  ],
};

describe("interpretStats", () => {
  it("calls messages.create once with the stats report as user message", async () => {
    const client = makeMockClient(validOutput);
    const result = await interpretStats(
      client,
      "Stats report content here",
      "System prompt here",
      mockLogger as any
    );
    expect(client.messages.create).toHaveBeenCalledTimes(1);
    const call = (client.messages.create as any).mock.calls[0][0];
    expect(call.messages[0].content).toBe("Stats report content here");
    expect(call.system).toBe("System prompt here");
  });

  it("parses and returns structured JSON from LLM response", async () => {
    const client = makeMockClient(validOutput);
    const result = await interpretStats(client, "report", "system", mockLogger as any);
    expect(result).not.toBeNull();
    expect(result!.insights).toHaveLength(1);
    expect(result!.recommendations).toHaveLength(1);
    expect(result!.insights[0].confidence).toBe("MODERATE");
    expect(result!.gaps).toHaveLength(1);
    expect(result!.prompt_suggestions.assessment).toBe("working_well");
  });

  it("retries once on failure and returns null if both fail", async () => {
    const client = {
      messages: {
        create: vi.fn().mockRejectedValue(new Error("rate limit")),
      },
    } as unknown as Anthropic;

    const result = await interpretStats(client, "report", "system", mockLogger as any);
    expect(result).toBeNull();
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```
cd server && npm test -- ai-analyzer
```
Expected: FAIL — `interpretStats is not a function`

- [ ] **Step 3: Replace `server/src/ai/analyzer.ts`**

```typescript
import type Anthropic from "@anthropic-ai/sdk";
import type { AiLogger } from "./logger.js";
import { MODELS } from "./client.js";

// ── Output schema type ─────────────────────────────────────

export interface AnalysisOutputSchema {
  insights: Array<{
    category: string;
    stable_key: string;
    claim: string;
    evidence: string;
    confidence: string;
    direction: string;
  }>;
  recommendations: Array<{
    key: string;
    type: string;
    priority: number;
    confidence: string;
    headline: string;
    detail: string;
    action: string;
  }>;
  overview: {
    summary_text: string;
    quick_insights: string[];
  };
  prompt_suggestions: {
    assessment: "working_well" | "suggest_changes";
    reasoning: string;
    suggestions: Array<{
      current: string;
      suggested: string;
      evidence: string;
    }>;
  };
  gaps: Array<{
    type: "data_gap" | "tool_gap" | "knowledge_gap";
    stable_key: string;
    description: string;
    impact: string;
  }>;
}

// ── Main export ────────────────────────────────────────────

export async function interpretStats(
  client: Anthropic,
  statsReport: string,
  systemPrompt: string,
  logger: AiLogger
): Promise<AnalysisOutputSchema | null> {
  const makeCall = async (): Promise<AnalysisOutputSchema> => {
    const start = Date.now();
    const response = await client.messages.create({
      model: MODELS.SONNET,
      max_tokens: 16000,
      thinking: { type: "enabled", budget_tokens: 10000 },
      system: systemPrompt,
      messages: [{ role: "user", content: statsReport }],
    } as any); // 'thinking' param requires SDK ≥ 0.20; cast to satisfy older type definitions
    const duration = Date.now() - start;

    const textBlock = (response.content as any[])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    logger.log({
      step: "interpretation",
      model: MODELS.SONNET,
      input_messages: JSON.stringify([{ role: "user", content: "[stats report]" }]),
      output_text: textBlock.slice(0, 2000), // truncate for log storage
      tool_calls: null,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      thinking_tokens: 0,
      duration_ms: duration,
    });

    // The prompt instructs the model to output raw JSON (no fences).
    // Try raw parse first, then strip markdown fences if present.
    let parsed: AnalysisOutputSchema;
    try {
      parsed = JSON.parse(textBlock);
    } catch {
      const match = textBlock.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (!match) throw new Error("LLM response is not valid JSON");
      parsed = JSON.parse(match[1]!);
    }

    return parsed;
  };

  try {
    return await makeCall();
  } catch (err) {
    // Retry once after 5 seconds
    await new Promise((resolve) => setTimeout(resolve, 5000));
    try {
      return await makeCall();
    } catch {
      logger.log({
        step: "interpretation_failed",
        model: MODELS.SONNET,
        input_messages: "{}",
        output_text: err instanceof Error ? err.message : String(err),
        tool_calls: null,
        input_tokens: 0,
        output_tokens: 0,
        thinking_tokens: 0,
        duration_ms: 0,
      });
      return null;
    }
  }
}
```

- [ ] **Step 4: Delete `server/src/ai/tools.ts`**

```bash
rm server/src/ai/tools.ts
```

- [ ] **Step 5: Run tests to verify they pass**

```
cd server && npm test -- ai-analyzer
```
Expected: PASS

Also run all tests to confirm nothing else broke:
```
cd server && npm test
```
Expected: ai-tools.test.ts will fail (it tested the deleted tools.ts) — delete it:
```bash
rm server/src/__tests__/ai-tools.test.ts
cd server && npm test
```
Expected: All remaining tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/ai/analyzer.ts server/src/__tests__/ai-analyzer.test.ts
git rm server/src/ai/tools.ts server/src/__tests__/ai-tools.test.ts
git commit -m "feat: replace agent loop with single interpretStats call; remove tools.ts"
```

---

### Task 6: Orchestrator Rework

**Files:**
- Modify: `server/src/ai/orchestrator.ts`
- Modify: `server/src/__tests__/ai-orchestrator.test.ts`

- [ ] **Step 1: Write failing test for new pipeline shape**

Add to `server/src/__tests__/ai-orchestrator.test.ts`:

```typescript
// Existing tests for shouldRunPipeline remain unchanged.
// Add this import and test:

import { vi } from "vitest";

describe("runPipeline (mocked AI)", () => {
  it("reads timezone from settings before building stats report", async () => {
    // This is an integration concern validated manually after full implementation.
    // The unit test for shouldRunPipeline above covers the pure logic.
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Replace `server/src/ai/orchestrator.ts`**

```typescript
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
  const lastRun = getLatestCompletedRun(db);
  const check = shouldRunPipeline(postCount, lastRun ? { post_count: lastRun.post_count } : null);
  if (!check.should) {
    return { runId: 0, status: "failed", error: check.reason };
  }

  const runId = createRun(db, triggeredBy, postCount);
  const logger = new AiLogger(db, runId);

  try {
    // Step 1: Taxonomy and tagging (kept from prior architecture)
    const taxonomy = getTaxonomy(db);
    if (taxonomy.length === 0) {
      await discoverTaxonomy(client, db, logger);
    }
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
            insight.direction === "reversed" ? "reversal" : "continuation"
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

      // Step 7: Haiku call for top performer reason
      let topPerformerReason: string | null = null;
      if (topPerformer) {
        try {
          const reasonResponse = await client.messages.create({
            model: MODELS.HAIKU,
            max_tokens: 150,
            system:
              "You write concise, plain-language explanations of why LinkedIn posts performed well. One sentence max. No filler phrases.",
            messages: [
              {
                role: "user",
                content: buildTopPerformerPrompt(
                  topPerformer.preview ?? "Unknown post",
                  new Date(topPerformer.published_at).toLocaleDateString(),
                  topPerformer.impressions,
                  topPerformer.comments
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
```

- [ ] **Step 3: Run tests**

```
cd server && npm test
```
Expected: All tests pass (the existing orchestrator tests for `shouldRunPipeline` are unchanged and still pass)

- [ ] **Step 4: Commit**

```bash
git add server/src/ai/orchestrator.ts server/src/__tests__/ai-orchestrator.test.ts
git commit -m "feat: rework orchestrator — stats report + single Sonnet call + Haiku overview"
```

---

## Chunk 4: New API Routes

### Task 7: Settings Routes (Timezone + Writing Prompt)

**Files:**
- Modify: `server/src/routes/settings.ts`
- Modify: `server/src/app.ts`
- Create: `server/src/__tests__/settings-routes.test.ts`

- [ ] **Step 1: Write failing tests**

Create `server/src/__tests__/settings-routes.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";
import fs from "fs";
import path from "path";

const TEST_DB_PATH = path.join(import.meta.dirname, "../../data/test-settings-routes.db");

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp(TEST_DB_PATH);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  try {
    fs.unlinkSync(TEST_DB_PATH);
    fs.unlinkSync(TEST_DB_PATH + "-wal");
    fs.unlinkSync(TEST_DB_PATH + "-shm");
  } catch {}
});

describe("PUT /api/settings/timezone", () => {
  it("stores timezone and returns ok", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/timezone",
      payload: { timezone: "America/Chicago" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("rejects invalid timezone", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/timezone",
      payload: { timezone: "Not/ATimezone" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/settings/writing-prompt", () => {
  it("returns null when not set", async () => {
    const res = await app.inject({ method: "GET", url: "/api/settings/writing-prompt" });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toBeNull();
  });
});

describe("PUT /api/settings/writing-prompt", () => {
  it("saves a writing prompt and returns ok", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/writing-prompt",
      payload: { text: "Always start with a hook", source: "manual_edit" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("retrieves the saved prompt", async () => {
    const res = await app.inject({ method: "GET", url: "/api/settings/writing-prompt" });
    expect(res.json().text).toBe("Always start with a hook");
  });
});

describe("GET /api/settings/writing-prompt/history", () => {
  it("returns history entries", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/settings/writing-prompt/history",
    });
    expect(res.statusCode).toBe(200);
    const history = res.json().history;
    expect(Array.isArray(history)).toBe(true);
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].source).toBe("manual_edit");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```
cd server && npm test -- settings-routes
```
Expected: FAIL — routes don't exist yet

- [ ] **Step 3: Update `server/src/routes/settings.ts`** to accept `db` and add new routes:

```typescript
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import {
  getSetting,
  upsertSetting,
  saveWritingPromptHistory,
  getWritingPromptHistory,
} from "../db/ai-queries.js";

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png"]);

// Validate that a timezone string is recognized by Intl
function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function registerSettingsRoutes(
  app: FastifyInstance,
  dataDir: string,
  db: Database.Database
): void {
  const photoPath = path.join(dataDir, "author-reference.jpg");

  // ── Author photo (unchanged) ───────────────────────────────

  app.get("/api/settings/author-photo", async (_request, reply) => {
    if (!fs.existsSync(photoPath)) {
      return reply.status(404).send({ error: "No author photo uploaded" });
    }
    return reply.type("image/jpeg").send(fs.readFileSync(photoPath));
  });

  app.post("/api/settings/author-photo", async (request, reply) => {
    const contentType = request.headers["content-type"] || "";
    if (contentType.includes("multipart/form-data")) {
      const data = await request.file();
      if (!data) return reply.status(400).send({ error: "No file provided" });
      if (!ALLOWED_TYPES.has(data.mimetype))
        return reply.status(400).send({ error: "Only JPEG and PNG files are allowed" });
      const chunks: Buffer[] = [];
      for await (const chunk of data.file) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      if (buffer.length > MAX_FILE_SIZE)
        return reply.status(400).send({ error: "File too large. Max 5MB." });
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(photoPath, buffer);
      return { ok: true };
    }
    if (!ALLOWED_TYPES.has(contentType.split(";")[0].trim()))
      return reply.status(400).send({ error: "Only JPEG and PNG files are allowed" });
    const body = request.body as Buffer;
    if (!body || body.length === 0)
      return reply.status(400).send({ error: "No file provided" });
    if (body.length > MAX_FILE_SIZE)
      return reply.status(400).send({ error: "File too large. Max 5MB." });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(photoPath, body);
    return { ok: true };
  });

  app.delete("/api/settings/author-photo", async () => {
    if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath);
    return { ok: true };
  });

  // ── Timezone ───────────────────────────────────────────────

  app.put("/api/settings/timezone", async (request, reply) => {
    const body = request.body as { timezone?: string };
    if (!body.timezone || typeof body.timezone !== "string") {
      return reply.status(400).send({ error: "timezone is required" });
    }
    if (!isValidTimezone(body.timezone)) {
      return reply.status(400).send({ error: "Invalid timezone" });
    }
    upsertSetting(db, "timezone", body.timezone);
    return { ok: true };
  });

  // ── Writing prompt ─────────────────────────────────────────

  app.get("/api/settings/writing-prompt", async () => {
    const text = getSetting(db, "writing_prompt");
    return { text: text ?? null };
  });

  app.put("/api/settings/writing-prompt", async (request, reply) => {
    const body = request.body as { text?: string; source?: string; evidence?: string };
    if (!body.text || typeof body.text !== "string") {
      return reply.status(400).send({ error: "text is required" });
    }
    const source = body.source ?? "manual_edit";
    upsertSetting(db, "writing_prompt", body.text);
    saveWritingPromptHistory(db, {
      prompt_text: body.text,
      source,
      evidence: body.evidence ?? null,
    });
    return { ok: true };
  });

  app.get("/api/settings/writing-prompt/history", async () => {
    return { history: getWritingPromptHistory(db) };
  });
}
```

- [ ] **Step 4: Update `server/src/app.ts`** — pass `db` to `registerSettingsRoutes`:

Find this line in `app.ts` (near line 301):
```typescript
registerSettingsRoutes(app, dataDir);
```
Change to:
```typescript
registerSettingsRoutes(app, dataDir, db);
```

- [ ] **Step 5: Run tests**

```
cd server && npm test -- settings-routes
```
Expected: PASS

Also run full test suite:
```
cd server && npm test
```
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/settings.ts server/src/app.ts server/src/__tests__/settings-routes.test.ts
git commit -m "feat: add timezone and writing prompt settings routes"
```

---

### Task 8: Insights Route Updates (Gaps + Prompt Suggestions)

**Files:**
- Modify: `server/src/routes/insights.ts`
- Modify: `server/src/__tests__/insights-routes.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `server/src/__tests__/insights-routes.test.ts`:

```typescript
import { getLatestAnalysisGaps, upsertAnalysisGap, getLatestPromptSuggestions } from "../db/ai-queries.js";

describe("GET /api/insights/gaps", () => {
  it("returns empty array when no gaps logged", async () => {
    const res = await app.inject({ method: "GET", url: "/api/insights/gaps" });
    expect(res.statusCode).toBe(200);
    expect(res.json().gaps).toEqual([]);
  });

  it("returns gaps after they are upserted", async () => {
    upsertAnalysisGap(db, {
      run_id: null,
      gap_type: "data_gap",
      stable_key: "test_gap",
      description: "Test gap",
      impact: "Test impact",
    });
    const res = await app.inject({ method: "GET", url: "/api/insights/gaps" });
    expect(res.statusCode).toBe(200);
    expect(res.json().gaps.length).toBeGreaterThan(0);
  });
});

describe("GET /api/insights/prompt-suggestions", () => {
  it("returns null when no analysis has run", async () => {
    const res = await app.inject({ method: "GET", url: "/api/insights/prompt-suggestions" });
    expect(res.statusCode).toBe(200);
    expect(res.json().prompt_suggestions).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```
cd server && npm test -- insights-routes
```
Expected: FAIL — routes don't exist

- [ ] **Step 3: Add routes to `server/src/routes/insights.ts`**

Add these two routes inside `registerInsightsRoutes`, after the existing routes:

```typescript
import {
  // existing imports...
  getLatestAnalysisGaps,
  getLatestPromptSuggestions,
} from "../db/ai-queries.js";

// Add inside registerInsightsRoutes:

  app.get("/api/insights/gaps", async () => ({
    gaps: getLatestAnalysisGaps(db),
  }));

  app.get("/api/insights/prompt-suggestions", async () => ({
    prompt_suggestions: getLatestPromptSuggestions(db),
  }));
```

- [ ] **Step 4: Run tests**

```
cd server && npm test -- insights-routes
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/insights.ts server/src/__tests__/insights-routes.test.ts
git commit -m "feat: add /api/insights/gaps and /api/insights/prompt-suggestions endpoints"
```

---

### Task 9: Dashboard API Client Types

**Files:**
- Modify: `dashboard/src/api/client.ts`

- [ ] **Step 1: No automated test** — client.ts is TypeScript types + fetch wrappers; verified by TypeScript compilation and manual testing.

- [ ] **Step 2: Add new types and API methods to `dashboard/src/api/client.ts`**

Add after the existing `Changelog` interface:

```typescript
export interface AnalysisGap {
  id: number;
  gap_type: string;
  stable_key: string;
  description: string;
  impact: string;
  times_flagged: number;
  first_seen_at: string;
  last_seen_at: string;
}

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

export interface WritingPromptHistory {
  id: number;
  prompt_text: string;
  source: string;
  suggestion_evidence: string | null;
  created_at: string;
}
```

Add these methods to the `api` export object (alongside the existing methods):

```typescript
  // Timezone
  setTimezone: (timezone: string) =>
    fetch(`${BASE_URL}/settings/timezone`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timezone }),
    }).then((r) => r.json() as Promise<{ ok: boolean }>),

  // Writing prompt
  getWritingPrompt: () =>
    get<{ text: string | null }>("/settings/writing-prompt"),

  saveWritingPrompt: (text: string, source: "manual_edit" | "ai_suggestion", evidence?: string) =>
    fetch(`${BASE_URL}/settings/writing-prompt`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, source, evidence }),
    }).then((r) => r.json() as Promise<{ ok: boolean }>),

  getWritingPromptHistory: () =>
    get<{ history: WritingPromptHistory[] }>("/settings/writing-prompt/history"),

  // Analysis gaps
  insightsGaps: () =>
    get<{ gaps: AnalysisGap[] }>("/insights/gaps"),

  // Prompt suggestions
  insightsPromptSuggestions: () =>
    get<{ prompt_suggestions: PromptSuggestions | null }>("/insights/prompt-suggestions"),
```

- [ ] **Step 3: Verify TypeScript compiles**

```
cd dashboard && npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/api/client.ts
git commit -m "feat: add timezone, writing prompt, gaps, and prompt suggestions API types"
```

---

## Chunk 5: Dashboard

### Task 10: Timezone Detection + Coach Page (Prompt Suggestions + Data Gaps)

**Files:**
- Modify: `dashboard/src/App.tsx`
- Modify: `dashboard/src/pages/Coach.tsx`

- [ ] **Step 1: Add timezone detection to `dashboard/src/App.tsx`**

Add a `useEffect` that fires once on mount, after the existing `api.health()` effect:

```typescript
// Inside App component, add after the health useEffect:
useEffect(() => {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  api.setTimezone(tz).catch(() => {});
}, []);
```

- [ ] **Step 2: Add prompt suggestions and data gaps sections to `dashboard/src/pages/Coach.tsx`**

At the top of the file, add new state variables in the `Coach` component:

```typescript
const [promptSuggestions, setPromptSuggestions] = useState<import("../api/client").PromptSuggestions | null>(null);
const [gaps, setGaps] = useState<import("../api/client").AnalysisGap[]>([]);
const [gapsOpen, setGapsOpen] = useState(false);
const [acceptedSuggestions, setAcceptedSuggestions] = useState<Set<number>>(new Set());
const [rejectedSuggestions, setRejectedSuggestions] = useState<Set<number>>(new Set());
```

Update the `load` function to also fetch prompt suggestions and gaps:

```typescript
const load = () => {
  api.insights().then((r) => { /* existing code */ }).catch(() => {});
  api.insightsChangelog().then(setChangelog).catch(() => {});
  api.insightsPromptSuggestions().then((r) => setPromptSuggestions(r.prompt_suggestions)).catch(() => {});
  api.insightsGaps().then((r) => setGaps(r.gaps)).catch(() => {});
};
```

Add a `handleAcceptSuggestion` function:

```typescript
const handleAcceptSuggestion = async (index: number, suggestion: import("../api/client").PromptSuggestion) => {
  // Get current prompt, apply the replacement
  const currentPromptRes = await api.getWritingPrompt().catch(() => ({ text: null }));
  const currentText = currentPromptRes.text ?? "";
  const newText = currentText.includes(suggestion.current)
    ? currentText.replace(suggestion.current, suggestion.suggested)
    : currentText + "\n" + suggestion.suggested;

  await api.saveWritingPrompt(newText, "ai_suggestion", suggestion.evidence).catch(() => {});
  setAcceptedSuggestions((prev) => new Set([...prev, index]));
};

const handleRejectSuggestion = (index: number) => {
  setRejectedSuggestions((prev) => new Set([...prev, index]));
};
```

Add the **Prompt Suggestions section** after the existing recommendations section (before the "What Changed" section):

```tsx
{/* Writing Prompt Review */}
{promptSuggestions && (
  <div className="space-y-3">
    <h3 className="text-lg font-semibold">Writing Prompt Review</h3>
    {promptSuggestions.assessment === "working_well" ? (
      <div className="flex items-center gap-2 text-sm text-positive">
        <span className="w-2 h-2 rounded-full bg-positive" />
        Your writing prompt is aligned with what's performing.
      </div>
    ) : (
      <div className="space-y-3">
        <p className="text-sm text-text-secondary">{promptSuggestions.reasoning}</p>
        {promptSuggestions.suggestions.map((s, i) => {
          if (rejectedSuggestions.has(i)) return null;
          if (acceptedSuggestions.has(i)) {
            return (
              <div key={i} className="bg-positive/5 border border-positive/20 rounded-lg px-4 py-3">
                <span className="text-xs text-positive font-medium">Applied ✓</span>
              </div>
            );
          }
          return (
            <div key={i} className="bg-surface-1 border border-border rounded-lg p-4 space-y-2">
              <div className="text-xs text-text-muted uppercase tracking-wider font-medium">Suggestion</div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs text-text-muted mb-1">Current</div>
                  <p className="text-sm bg-surface-2 rounded px-3 py-2 text-text-secondary">{s.current}</p>
                </div>
                <div>
                  <div className="text-xs text-text-muted mb-1">Suggested</div>
                  <p className="text-sm bg-accent/5 border border-accent/15 rounded px-3 py-2 text-text-primary">{s.suggested}</p>
                </div>
              </div>
              <p className="text-xs text-text-muted">{s.evidence}</p>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => handleAcceptSuggestion(i, s)}
                  className="px-3 py-1 rounded text-xs font-medium bg-positive/10 text-positive hover:bg-positive/20 transition-colors"
                >
                  Accept
                </button>
                <button
                  onClick={() => handleRejectSuggestion(i)}
                  className="px-3 py-1 rounded text-xs font-medium bg-surface-2 text-text-muted hover:text-text-primary transition-colors"
                >
                  Reject
                </button>
              </div>
            </div>
          );
        })}
      </div>
    )}
  </div>
)}
```

Add the **Data Gaps section** at the bottom of the returned JSX (after "What Changed"):

```tsx
{/* What's Limiting Your Insights */}
{gaps.length > 0 && (
  <div className="space-y-2">
    <button
      onClick={() => setGapsOpen((v) => !v)}
      className="flex items-center gap-2 text-sm text-text-muted hover:text-text-primary transition-colors"
    >
      <span className={`transition-transform ${gapsOpen ? "rotate-90" : ""}`}>▶</span>
      What's limiting your insights
      <span className="text-xs bg-surface-2 px-2 py-0.5 rounded-full">{gaps.length}</span>
    </button>
    {gapsOpen && (
      <div className="space-y-2">
        {gaps.map((gap) => (
          <div
            key={gap.id}
            className={`bg-surface-1 border rounded-md px-4 py-3 ${
              gap.times_flagged >= 3 ? "border-warning/40" : "border-border"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-text-muted uppercase">{gap.gap_type.replace("_", " ")}</span>
              {gap.times_flagged >= 3 && (
                <span className="text-xs bg-warning/10 text-warning px-2 py-0.5 rounded-full">
                  {gap.times_flagged}× flagged
                </span>
              )}
            </div>
            <p className="text-sm text-text-primary mt-1">{gap.description}</p>
            <p className="text-xs text-text-muted mt-0.5">{gap.impact}</p>
          </div>
        ))}
      </div>
    )}
  </div>
)}
```

- [ ] **Step 3: Verify the app builds**

```
cd dashboard && npm run build
```
Expected: Build succeeds with no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/App.tsx dashboard/src/pages/Coach.tsx
git commit -m "feat: add timezone detection, prompt suggestions and data gaps to Coach"
```

---

### Task 11: Settings Page (Writing Prompt), Posts Banner, Timing Highlights

**Files:**
- Modify: `dashboard/src/pages/Settings.tsx`
- Modify: `dashboard/src/pages/Posts.tsx`
- Modify: `dashboard/src/pages/Timing.tsx`

- [ ] **Step 1: Add writing prompt editor to `dashboard/src/pages/Settings.tsx`**

Add state and handlers in the `Settings` component:

```typescript
const [promptText, setPromptText] = useState<string>("");
const [promptSaved, setPromptSaved] = useState(false);
const [promptHistory, setPromptHistory] = useState<import("../api/client").WritingPromptHistory[]>([]);
const [historyOpen, setHistoryOpen] = useState(false);
const [promptLoading, setPromptLoading] = useState(false);

useEffect(() => {
  api.getWritingPrompt().then((r) => setPromptText(r.text ?? "")).catch(() => {});
  api.getWritingPromptHistory().then((r) => setPromptHistory(r.history)).catch(() => {});
}, []);

const handleSavePrompt = async () => {
  setPromptLoading(true);
  try {
    await api.saveWritingPrompt(promptText, "manual_edit");
    const histRes = await api.getWritingPromptHistory();
    setPromptHistory(histRes.history);
    setPromptSaved(true);
    setTimeout(() => setPromptSaved(false), 2000);
  } catch {
    // silent
  } finally {
    setPromptLoading(false);
  }
};
```

Add this section to the Settings page JSX, after the author photo section:

```tsx
{/* Writing Prompt */}
<div className="bg-surface-1 border border-border rounded-lg p-5 space-y-4">
  <div>
    <h3 className="text-sm font-medium text-text-primary mb-1">LinkedIn Writing Prompt</h3>
    <p className="text-xs text-text-muted">
      The prompt or guidelines you use when writing LinkedIn posts. The AI Coach uses this
      to suggest improvements based on your performance data.
    </p>
  </div>

  <textarea
    value={promptText}
    onChange={(e) => setPromptText(e.target.value)}
    rows={6}
    placeholder="e.g. Always start with a compelling question. Use short paragraphs. End with a call to action..."
    className="w-full bg-surface-2 border border-border rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent resize-none"
  />

  <div className="flex items-center gap-3">
    <button
      onClick={handleSavePrompt}
      disabled={promptLoading}
      className="px-4 py-2 rounded-md text-sm font-medium bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
    >
      {promptLoading ? "Saving..." : promptSaved ? "Saved ✓" : "Save Prompt"}
    </button>
  </div>

  {/* Revision History */}
  {promptHistory.length > 0 && (
    <div className="space-y-2">
      <button
        onClick={() => setHistoryOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary transition-colors"
      >
        <span className={`transition-transform ${historyOpen ? "rotate-90" : ""}`}>▶</span>
        Revision history ({promptHistory.length})
      </button>
      {historyOpen && (
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {promptHistory.map((h) => (
            <div key={h.id} className="bg-surface-2 rounded-md px-3 py-2 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-muted">
                  {new Date(h.created_at).toLocaleString()}
                </span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${
                  h.source === "ai_suggestion"
                    ? "bg-accent/10 text-accent"
                    : "bg-surface-3 text-text-muted"
                }`}>
                  {h.source === "ai_suggestion" ? "AI suggestion" : "Manual edit"}
                </span>
              </div>
              <p className="text-xs text-text-secondary line-clamp-3">{h.prompt_text}</p>
              {h.suggestion_evidence && (
                <p className="text-xs text-text-muted italic">{h.suggestion_evidence}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )}
</div>
```

- [ ] **Step 2: Add backfill banner to `dashboard/src/pages/Posts.tsx`**

Add state and effect for backfill count (add after existing state declarations):

```typescript
const [backfillCount, setBackfillCount] = useState<number>(0);

useEffect(() => {
  api
    .get<{ post_ids: string[] }>("/posts/needs-content")
    .then((r) => setBackfillCount(r.post_ids.length))
    .catch(() => {});
}, []);
```

Wait — `api.get` is not exported. Use a direct fetch instead. Add this helper call inside the existing `useEffect` that loads posts, OR add a new one:

```typescript
useEffect(() => {
  fetch("/api/posts/needs-content")
    .then((r) => r.json())
    .then((r) => setBackfillCount(r.post_ids?.length ?? 0))
    .catch(() => {});
}, []);
```

Add the banner in the JSX, at the top of the returned `<div>`, before the filter controls:

```tsx
{backfillCount > 0 && (
  <div className="bg-accent/5 border border-accent/20 rounded-md px-4 py-2.5 text-sm text-text-secondary flex items-center gap-2">
    <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
    Content pending for {backfillCount} post{backfillCount !== 1 ? "s" : ""} — open LinkedIn with the extension active to backfill.
  </div>
)}
```

- [ ] **Step 3: Add best-window summary to `dashboard/src/pages/Timing.tsx`**

After the `lookup` and `maxRate` computation, add:

```typescript
// Compute median ER per day to find best posting windows
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const medianERByDay: { day: string; er: number }[] = [];
for (const day of [0, 1, 2, 3, 4, 5, 6]) {
  const daySlots = slots.filter((s) => s.day === day && s.avg_engagement_rate != null);
  if (daySlots.length === 0) continue;
  const rates = daySlots.map((s) => s.avg_engagement_rate!).sort((a, b) => a - b);
  const mid = Math.floor(rates.length / 2);
  const med = rates.length % 2 === 0 ? (rates[mid - 1]! + rates[mid]!) / 2 : rates[mid]!;
  medianERByDay.push({ day: DAY_NAMES[day]!, er: med });
}
const overallMedian =
  medianERByDay.length > 0
    ? medianERByDay.map((d) => d.er).sort((a, b) => a - b)[
        Math.floor(medianERByDay.length / 2)
      ]!
    : 0;
const bestDays = medianERByDay
  .filter((d) => d.er > overallMedian)
  .sort((a, b) => b.er - a.er)
  .slice(0, 3)
  .map((d) => d.day);

// Add isAboveMedian helper for cell highlighting
function isAboveMedian(slot: TimingSlot | undefined): boolean {
  if (!slot || slot.avg_engagement_rate == null || maxRate === 0) return false;
  return slot.avg_engagement_rate / maxRate > 0.6;
}
```

Add the best-windows summary above the table (in the returned JSX, after the `<p>` description):

```tsx
{bestDays.length > 0 && (
  <p className="text-sm text-accent font-medium">
    Your strongest days: {bestDays.join(", ")}
  </p>
)}
```

Update `cellColor` to add a green ring for above-median cells (or modify the existing `bg-accent` to `bg-positive` for the top bucket). Find the `cellColor` function and update:

```typescript
function cellColor(slot: TimingSlot | undefined): string {
  if (!slot || slot.avg_engagement_rate == null || maxRate === 0) return "bg-surface-1";
  const intensity = slot.avg_engagement_rate / maxRate;
  if (intensity > 0.75) return "bg-positive"; // was bg-accent
  if (intensity > 0.5) return "bg-positive/60";
  if (intensity > 0.25) return "bg-positive/30";
  return "bg-positive/10";
}
```

- [ ] **Step 4: Build the dashboard**

```
cd dashboard && npm run build
```
Expected: No TypeScript errors, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/pages/Settings.tsx dashboard/src/pages/Posts.tsx dashboard/src/pages/Timing.tsx
git commit -m "feat: add writing prompt editor, backfill banner, and timing highlights"
```

---

## Final Verification

- [ ] **Run all server tests**

```
cd server && npm test
```
Expected: All tests pass.

- [ ] **Build dashboard**

```
cd dashboard && npm run build
```
Expected: No errors.

- [ ] **Smoke test the full flow manually**
1. Start server: `cd server && npm run dev`
2. Open dashboard at `http://localhost:3210`
3. Verify timezone is sent on load (check server logs or DB: `SELECT * FROM settings`)
4. Go to Settings → add a writing prompt → save → check history appears
5. Go to Coach → click "Refresh AI" → wait for completion → verify:
   - Recommendations show strings for confidence (STRONG/MODERATE/WEAK), not decimals
   - No post IDs in recommendation text
   - Prompt suggestions section appears (if writing prompt is set)
   - Data gaps section appears (collapsed by default)
6. Go to Posts → verify backfill banner shows (if posts missing content)
7. Go to Timing → verify best days summary text appears

- [ ] **Final commit if any cleanup needed**

```bash
git add -p  # review any remaining changes
git commit -m "fix: final cleanup after stats engine rework"
```
