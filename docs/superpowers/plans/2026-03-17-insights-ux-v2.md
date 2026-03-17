# AI Insights UX v2 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture full post content and images, classify images with a vision model, improve AI output quality, and add feedback loops — making AI insights immediately actionable and human-readable.

**Architecture:** Three-layer changes: (1) Extension scraper visits actual post pages to capture full text, hook text, and image URLs. (2) Server downloads images, classifies them with Haiku vision, stores tags in DB. (3) Prompts rewritten for plain language, dashboard updated with richer display, feedback "why" field added.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, Anthropic SDK (via OpenRouter), React + Tailwind, Chrome Extension APIs, Zod validation, Vitest

**Spec:** `docs/superpowers/specs/2026-03-17-insights-ux-v2-design.md`

---

## File Structure

### New Files
- `server/src/db/migrations/003-content-images.sql` — Schema migration: new columns on posts, new ai_image_tags table
- `server/src/ai/image-classifier.ts` — Image classification with Haiku vision model
- `server/src/ai/image-downloader.ts` — Download LinkedIn CDN images to local storage
- `server/src/routes/settings.ts` — Author photo upload/serve/delete endpoints
- `dashboard/src/pages/Settings.tsx` — Settings page with author photo upload

### Modified Files
- `server/src/schemas.ts` — Make content_type/published_at optional, add full_text/hook_text/image_urls
- `server/src/db/index.ts` — Run migration 003
- `server/src/db/queries.ts` — Update upsertPost for new columns, update queryPosts to return hook_text/full_text
- `server/src/db/ai-queries.ts` — Add image tag CRUD, add feedback-with-reasons query
- `server/src/ai/tools.ts` — Add ai_image_tags to ALLOWED_TABLES
- `server/src/ai/prompts.ts` — Language rules, updated schema description, image analysis instructions
- `server/src/ai/analyzer.ts` — Update buildSummary with hook_text, tagger uses COALESCE(full_text, content_preview)
- `server/src/ai/orchestrator.ts` — Add classifyImages step, improve top performer reason, wire feedback
- `server/src/app.ts` — Register settings routes, serve images, add needs-content endpoint, trigger image downloads
- `server/src/routes/insights.ts` — Update feedback endpoint for JSON body with reason
- `dashboard/src/api/client.ts` — Add Post.hook_text/full_text, settings API, update feedback method
- `dashboard/src/pages/Overview.tsx` — Fix "vs prior" labels, improve top performer card
- `dashboard/src/pages/Posts.tsx` — Show hook_text, add image thumbnails
- `dashboard/src/pages/Coach.tsx` — Add feedback "why" text field
- `dashboard/src/App.tsx` — Add Settings tab
- `extension/src/content/scrapers.ts` — Add scrapePostPage() function
- `extension/src/content/index.ts` — Handle post-page URL pattern
- `extension/src/shared/types.ts` — Add post-content schema and message type
- `extension/src/background/service-worker.ts` — Add post page visit step, backfill logic

---

## Chunk 1: Schema Migration + Ingest Changes

### Task 1: Database Migration — New Columns and Table

**Files:**
- Create: `server/src/db/migrations/003-content-images.sql`
- Modify: `server/src/db/index.ts`
- Test: `server/src/__tests__/db.test.ts`

- [ ] **Step 1: Write failing test — new columns exist after migration**

Add to `server/src/__tests__/db.test.ts`:

```typescript
test("posts table has full_text, hook_text, image_urls, image_local_paths columns", () => {
  const info = db.prepare("PRAGMA table_info(posts)").all() as { name: string }[];
  const names = info.map((c) => c.name);
  expect(names).toContain("full_text");
  expect(names).toContain("hook_text");
  expect(names).toContain("image_urls");
  expect(names).toContain("image_local_paths");
});

test("ai_image_tags table exists with correct columns", () => {
  const info = db.prepare("PRAGMA table_info(ai_image_tags)").all() as { name: string }[];
  const names = info.map((c) => c.name);
  expect(names).toContain("post_id");
  expect(names).toContain("image_index");
  expect(names).toContain("format");
  expect(names).toContain("people");
  expect(names).toContain("setting");
  expect(names).toContain("text_density");
  expect(names).toContain("energy");
  expect(names).toContain("tagged_at");
  expect(names).toContain("model");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- --run -t "full_text"`
Expected: FAIL — columns don't exist yet

- [ ] **Step 3: Write the migration SQL**

Create `server/src/db/migrations/003-content-images.sql`:

```sql
-- Add content and image columns to posts
ALTER TABLE posts ADD COLUMN full_text TEXT;
ALTER TABLE posts ADD COLUMN hook_text TEXT;
ALTER TABLE posts ADD COLUMN image_urls TEXT;
ALTER TABLE posts ADD COLUMN image_local_paths TEXT;

-- Image classification tags
CREATE TABLE IF NOT EXISTS ai_image_tags (
  post_id TEXT NOT NULL REFERENCES posts(id),
  image_index INTEGER NOT NULL DEFAULT 0,
  format TEXT NOT NULL,
  people TEXT NOT NULL,
  setting TEXT NOT NULL,
  text_density TEXT NOT NULL,
  energy TEXT NOT NULL,
  tagged_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  model TEXT,
  PRIMARY KEY (post_id, image_index)
);

CREATE INDEX IF NOT EXISTS idx_ai_image_tags_post_id ON ai_image_tags(post_id);
```

The migration runner in `server/src/db/index.ts` already handles numbered migration files automatically (it reads the `migrations/` directory and runs files with version > current schema_version). No code change needed in `index.ts` — the existing `runMigrations()` function will pick up `003-content-images.sql`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- --run -t "full_text"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/db/migrations/003-content-images.sql server/src/__tests__/db.test.ts
git commit -m "feat: add schema migration for full_text, hook_text, image columns and ai_image_tags table"
```

---

### Task 2: Update Ingest Schema — Accept Content Fields

**Files:**
- Modify: `server/src/schemas.ts`
- Test: `server/src/__tests__/server.test.ts`

- [ ] **Step 1: Write failing test — ingest accepts full_text, hook_text, image_urls**

Add to `server/src/__tests__/server.test.ts`:

```typescript
test("POST /api/ingest accepts full_text, hook_text, image_urls on posts", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/ingest",
    payload: {
      posts: [
        {
          id: "content-fields-test",
          content_type: "image",
          published_at: "2025-01-15T10:00:00+00:00",
          full_text: "This is the full post text with lots of details.",
          hook_text: "This is the hook text...",
          image_urls: ["https://media.licdn.com/dms/image/test1.jpg"],
        },
      ],
    },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.posts_upserted).toBe(1);
});

test("POST /api/ingest accepts partial post without content_type and published_at", async () => {
  // First create the post with required fields
  await app.inject({
    method: "POST",
    url: "/api/ingest",
    payload: {
      posts: [
        {
          id: "partial-update-test",
          content_type: "text",
          published_at: "2025-01-15T10:00:00+00:00",
        },
      ],
    },
  });

  // Then update with just content fields
  const response = await app.inject({
    method: "POST",
    url: "/api/ingest",
    payload: {
      posts: [
        {
          id: "partial-update-test",
          full_text: "Full text added later",
          hook_text: "Hook text added later",
        },
      ],
    },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().posts_upserted).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- --run -t "accepts full_text"`
Expected: FAIL — Zod validation rejects unknown fields / requires content_type

- [ ] **Step 3: Update the Zod schema**

In `server/src/schemas.ts`, update `postSchema`:

```typescript
const postSchema = z.object({
  id: z.string().min(1),
  content_preview: z.string().optional(),
  content_type: contentTypeSchema.optional(),
  published_at: z.string().datetime({ offset: true }).optional(),
  url: z.string().optional(),
  full_text: z.string().optional(),
  hook_text: z.string().optional(),
  image_urls: z.array(z.string()).optional(),
});
```

- [ ] **Step 4: Update upsertPost to handle new columns**

In `server/src/db/queries.ts`, update the `upsertPost` function signature and SQL:

```typescript
export function upsertPost(
  db: Database.Database,
  post: {
    id: string;
    content_preview?: string | null;
    content_type?: string | null;
    published_at?: string | null;
    url?: string | null;
    full_text?: string | null;
    hook_text?: string | null;
    image_urls?: string[] | null;
  }
): void {
  db.prepare(
    `INSERT INTO posts (id, content_preview, content_type, published_at, url, full_text, hook_text, image_urls)
     VALUES (@id, @content_preview, @content_type, @published_at, @url, @full_text, @hook_text, @image_urls)
     ON CONFLICT(id) DO UPDATE SET
       content_preview = COALESCE(@content_preview, content_preview),
       content_type = COALESCE(@content_type, content_type),
       published_at = COALESCE(@published_at, published_at),
       url = COALESCE(@url, url),
       full_text = COALESCE(@full_text, full_text),
       hook_text = COALESCE(@hook_text, hook_text),
       image_urls = COALESCE(@image_urls, image_urls)`
  ).run({
    id: post.id,
    content_preview: post.content_preview ?? null,
    content_type: post.content_type ?? null,
    published_at: post.published_at ?? null,
    url: post.url ?? null,
    full_text: post.full_text ?? null,
    hook_text: post.hook_text ?? null,
    image_urls: post.image_urls ? JSON.stringify(post.image_urls) : null,
  });
}
```

Also update the ingest handler in `server/src/app.ts` to pass new fields through to `upsertPost`:

In the `payload.posts` loop, change from:
```typescript
upsertPost(db, post);
```
to:
```typescript
upsertPost(db, {
  ...post,
  image_urls: post.image_urls ?? undefined,
});
```

(Since the schema now makes `content_type` and `published_at` optional, and `upsertPost` uses COALESCE, partial updates work.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w server -- --run`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/schemas.ts server/src/db/queries.ts server/src/app.ts server/src/__tests__/server.test.ts
git commit -m "feat: extend ingest schema for full_text, hook_text, image_urls with partial update support"
```

---

### Task 3: Needs-Content Endpoint + Image Tag CRUD

**Files:**
- Modify: `server/src/app.ts`
- Modify: `server/src/db/ai-queries.ts`
- Modify: `server/src/ai/tools.ts`
- Test: `server/src/__tests__/server.test.ts`
- Test: `server/src/__tests__/ai-queries.test.ts`

- [ ] **Step 1: Write failing test — GET /api/posts/needs-content**

Add to `server/src/__tests__/server.test.ts`:

```typescript
test("GET /api/posts/needs-content returns post IDs missing full_text", async () => {
  // Insert a post without full_text
  await app.inject({
    method: "POST",
    url: "/api/ingest",
    payload: {
      posts: [
        {
          id: "needs-content-1",
          content_type: "text",
          published_at: "2025-01-15T10:00:00+00:00",
        },
      ],
    },
  });
  // Insert a post WITH full_text
  await app.inject({
    method: "POST",
    url: "/api/ingest",
    payload: {
      posts: [
        {
          id: "needs-content-2",
          content_type: "text",
          published_at: "2025-01-15T10:00:00+00:00",
          full_text: "Already has content",
        },
      ],
    },
  });

  const response = await app.inject({
    method: "GET",
    url: "/api/posts/needs-content",
  });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.post_ids).toContain("needs-content-1");
  expect(body.post_ids).not.toContain("needs-content-2");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- --run -t "needs-content"`
Expected: FAIL — 404, route doesn't exist

- [ ] **Step 3: Add the endpoint**

In `server/src/app.ts`, add before the insights routes registration:

```typescript
// Posts needing content backfill
app.get("/api/posts/needs-content", async () => {
  const rows = db
    .prepare("SELECT id FROM posts WHERE full_text IS NULL ORDER BY published_at DESC")
    .all() as { id: string }[];
  return { post_ids: rows.map((r) => r.id) };
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- --run -t "needs-content"`
Expected: PASS

- [ ] **Step 5: Write failing test — image tag CRUD**

Add to `server/src/__tests__/ai-queries.test.ts`:

```typescript
test("upsertImageTag inserts and retrieves image tags", () => {
  // Create a test post first
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

test("getUnclassifiedImagePosts returns posts with images but no tags", () => {
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
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -w server -- --run -t "upsertImageTag"`
Expected: FAIL — functions don't exist

- [ ] **Step 7: Implement image tag CRUD functions**

Add to `server/src/db/ai-queries.ts`:

```typescript
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
```

Also add `ai_image_tags` to the ALLOWED_TABLES set in `server/src/ai/tools.ts`:

```typescript
const ALLOWED_TABLES = new Set([
  "posts",
  "post_metrics",
  "follower_snapshots",
  "profile_snapshots",
  "ai_tags",
  "ai_post_topics",
  "ai_taxonomy",
  "ai_image_tags",
]);
```

- [ ] **Step 8: Run all tests**

Run: `npm test -w server -- --run`
Expected: ALL PASS

- [ ] **Step 9: Commit**

```bash
git add server/src/app.ts server/src/db/ai-queries.ts server/src/ai/tools.ts server/src/__tests__/server.test.ts server/src/__tests__/ai-queries.test.ts
git commit -m "feat: add needs-content endpoint, image tag CRUD, ai_image_tags to query allowlist"
```

---

## Chunk 2: Extension Scraper Enhancement

### Task 4: Post Page Scraper Function

**Files:**
- Modify: `extension/src/content/scrapers.ts`
- Modify: `extension/src/shared/types.ts`
- Test: `extension/src/__tests__/scrapers.test.ts`

- [ ] **Step 1: Write failing test — scrapePostPage extracts full_text, hook_text, image_urls**

Add to `extension/src/__tests__/scrapers.test.ts`:

```typescript
import { scrapePostPage } from "../content/scrapers";

describe("scrapePostPage", () => {
  test("extracts hook_text from truncated view and full_text after expansion", () => {
    const html = `
      <div class="feed-shared-update-v2">
        <div class="feed-shared-inline-show-more-text">
          <span class="break-words">
            <span dir="ltr">This is the hook text that appears before see more</span>
          </span>
          <button class="feed-shared-inline-show-more-text__see-more-less-toggle">...see more</button>
        </div>
      </div>
    `;
    const doc = new DOMParser().parseFromString(html, "text/html");
    const result = scrapePostPage(doc);
    expect(result.hook_text).toBe("This is the hook text that appears before see more");
    expect(result.image_urls).toEqual([]);
  });

  test("extracts image URLs from post media container", () => {
    const html = `
      <div class="feed-shared-update-v2">
        <div class="feed-shared-inline-show-more-text">
          <span class="break-words"><span dir="ltr">Post text</span></span>
        </div>
        <div class="feed-shared-image">
          <img src="https://media.licdn.com/dms/image/v2/test1.jpg" />
        </div>
      </div>
    `;
    const doc = new DOMParser().parseFromString(html, "text/html");
    const result = scrapePostPage(doc);
    expect(result.image_urls).toEqual(["https://media.licdn.com/dms/image/v2/test1.jpg"]);
  });

  test("extracts multiple image URLs from carousel", () => {
    const html = `
      <div class="feed-shared-update-v2">
        <div class="feed-shared-inline-show-more-text">
          <span class="break-words"><span dir="ltr">Carousel post</span></span>
        </div>
        <div class="feed-shared-carousel">
          <img src="https://media.licdn.com/dms/image/v2/slide1.jpg" />
          <img src="https://media.licdn.com/dms/image/v2/slide2.jpg" />
          <img src="https://media.licdn.com/dms/image/v2/slide3.jpg" />
        </div>
      </div>
    `;
    const doc = new DOMParser().parseFromString(html, "text/html");
    const result = scrapePostPage(doc);
    expect(result.image_urls).toHaveLength(3);
  });

  test("returns empty arrays for text-only posts", () => {
    const html = `
      <div class="feed-shared-update-v2">
        <div class="feed-shared-inline-show-more-text">
          <span class="break-words"><span dir="ltr">Just text, no images</span></span>
        </div>
      </div>
    `;
    const doc = new DOMParser().parseFromString(html, "text/html");
    const result = scrapePostPage(doc);
    expect(result.hook_text).toBe("Just text, no images");
    expect(result.image_urls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w extension -- --run -t "scrapePostPage"`
Expected: FAIL — function doesn't exist

- [ ] **Step 3: Add Zod schema for post page scrape result**

In `extension/src/shared/types.ts`, add:

```typescript
export const scrapedPostContentSchema = z.object({
  hook_text: z.string().nullable(),
  full_text: z.string().nullable(),
  image_urls: z.array(z.string()),
});

export type ScrapedPostContent = z.infer<typeof scrapedPostContentSchema>;
```

Update the `ContentMessage` union to include:

```typescript
export type ContentMessage =
  | { type: "top-posts"; data: ScrapedPost[] }
  | { type: "post-detail"; postId: string; data: ScrapedPostMetrics }
  | { type: "post-content"; data: ScrapedPostContent }
  | { type: "audience"; data: ScrapedAudience }
  | { type: "profile-views"; data: ScrapedProfileViews }
  | { type: "search-appearances"; data: ScrapedSearchAppearances }
  | { type: "scrape-error"; page: string; error: string };
```

- [ ] **Step 4: Implement scrapePostPage**

In `extension/src/content/scrapers.ts`, add:

```typescript
import type { ScrapedPostContent } from "../shared/types.js";

export function scrapePostPage(doc: Document): ScrapedPostContent {
  // Extract hook text — the visible text before "see more"
  let hookText: string | null = null;
  let fullText: string | null = null;

  const textContainer = doc.querySelector(".feed-shared-inline-show-more-text");
  if (textContainer) {
    // Hook text: text content of the span before the "see more" button
    const textSpan = textContainer.querySelector(".break-words");
    if (textSpan) {
      hookText = textSpan.textContent?.trim() || null;
    }

    // Full text: if there's a "see more" button, the full text may be in a
    // data attribute or revealed after click. For now, we capture what's visible.
    // The service worker will click "see more" and re-scrape if needed.
    fullText = hookText; // Will be updated after "see more" click
  }

  // Extract image URLs — look for LinkedIn CDN images in the post
  const imageUrls: string[] = [];
  const images = doc.querySelectorAll(
    '.feed-shared-image img[src*="media.licdn.com"], ' +
    '.feed-shared-carousel img[src*="media.licdn.com"], ' +
    '.feed-shared-document img[src*="media.licdn.com"]'
  );
  for (const img of images) {
    const src = img.getAttribute("src");
    if (src && src.includes("media.licdn.com")) {
      imageUrls.push(src);
    }
  }

  return { hook_text: hookText, full_text: fullText, image_urls: imageUrls };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -w extension -- --run -t "scrapePostPage"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add extension/src/content/scrapers.ts extension/src/shared/types.ts extension/src/__tests__/scrapers.test.ts
git commit -m "feat: add scrapePostPage function for full text, hook text, and image URLs"
```

---

### Task 5: Wire Post Page Scraping into Content Script and Sync Flow

**Files:**
- Modify: `extension/src/content/index.ts`
- Modify: `extension/src/background/service-worker.ts`

- [ ] **Step 1: Add two-phase post-content handling to content script**

The content script needs to support TWO scrape phases for post pages: first to capture hook text (before "see more" click), then to capture full text (after expansion). The service worker orchestrates the click between phases.

In `extension/src/content/index.ts`, add the import:

```typescript
import { scrapePostPage } from "./scrapers.js";
import { scrapedPostContentSchema } from "../shared/types.js";
```

And add a new URL pattern handler in `scrapeCurrent()`:

```typescript
if (url.includes("/feed/update/urn:li:activity:")) {
  // Wait for the post text container to render
  await requireSelector(".feed-shared-inline-show-more-text, .feed-shared-update-v2__description", "post-page");
  const raw = scrapePostPage(document);
  const data = validate(scrapedPostContentSchema, raw, "post-content");
  return { type: "post-content", data };
}
```

Place this BEFORE the existing URL pattern checks (since `/feed/update/` is a distinct path from `/analytics/`).

- [ ] **Step 2: Add post page visit step to service worker**

**IMPORTANT: Hook text must be captured BEFORE clicking "see more".** The spec says: "Grab the text content of the post body element BEFORE clicking 'see more'. The visible text IS the hook." The service worker orchestrates this two-phase scrape:

1. Navigate to post page → scrape → get hook_text (truncated view)
2. Click "see more" → scrape again → get full_text (expanded view)

In `extension/src/background/service-worker.ts`, add a new function `scrapePostPages`:

```typescript
async function scrapePostPages(
  tabId: number,
  postIds: string[],
  isBackfill: boolean
): Promise<void> {
  const pacingMin = isBackfill ? BACKFILL_PACING_MIN_MS : PACING_MIN_MS;
  const pacingMax = isBackfill ? BACKFILL_PACING_MAX_MS : PACING_MAX_MS;

  for (const postId of postIds) {
    const postUrl = `https://www.linkedin.com/feed/update/urn:li:activity:${postId}/`;

    await chrome.tabs.update(tabId, { url: postUrl });
    await waitForTabLoad(tabId);
    await randomDelay(pacingMin, pacingMax);

    // Phase 1: Scrape BEFORE "see more" click — captures hook_text (truncated view)
    const hookResult = await sendScrapeCommand(tabId);
    let hookText: string | null = null;
    let imageUrls: string[] = [];

    if (hookResult.type === "post-content") {
      hookText = hookResult.data.hook_text;
      imageUrls = hookResult.data.image_urls;
    }

    // Phase 2: Click "see more" if present, then re-scrape for full_text
    let fullText: string | null = hookText; // default to hook if no expansion
    try {
      const [clickResult] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const seeMore = document.querySelector(
            '.feed-shared-inline-show-more-text__see-more-less-toggle'
          ) as HTMLElement | null;
          if (seeMore) {
            seeMore.click();
            return true;
          }
          return false;
        },
      });

      if (clickResult?.result) {
        // Wait for text expansion
        await new Promise((r) => setTimeout(r, 1500));
        // Re-scrape to get full expanded text
        const fullResult = await sendScrapeCommand(tabId);
        if (fullResult.type === "post-content") {
          fullText = fullResult.data.full_text;
        }
      }
    } catch {
      // No see more button or script injection failed — continue with hook as full
    }

    // POST content to server as a partial post update
    await postToServer({
      posts: [
        {
          id: postId,
          full_text: fullText,
          hook_text: hookText,
          image_urls: imageUrls,
        },
      ],
    });
  }
}
```

In `startSync()`, after POSTing top posts and before filtering for detail scraping, add a call to check which posts need content and scrape them:

```typescript
// After: await postToServer({ posts: ... });

// Scrape post pages for full text + images (only for posts missing content)
try {
  const needsContentRes = await fetch(`${SERVER_URL}/api/posts/needs-content`);
  if (needsContentRes.ok) {
    const { post_ids: needsContentIds } = await needsContentRes.json();
    // Only scrape posts that are in the current top-posts set
    const currentPostIds = new Set(posts.map((p: ScrapedPost) => p.id));
    const toScrape = needsContentIds.filter((id: string) => currentPostIds.has(id));
    if (toScrape.length > 0) {
      await scrapePostPages(tab.id!, toScrape, isBackfill);
    }
  }
} catch (err: any) {
  console.error("[LinkedIn Analytics] Post page scraping failed:", err.message);
  // Non-fatal — continue with detail metrics
}
```

- [ ] **Step 3: Update extension manifest to allow feed page content script**

**REQUIRED:** In `extension/manifest.json`, add `"*://*.linkedin.com/feed/*"` to the content script's `matches` array. Without this, the content script will NOT run on post pages and scraping will silently fail. Also ensure the `scripting` permission is present for `chrome.scripting.executeScript`. Add the manifest file to the commit.

- [ ] **Step 4: Test manually with Chrome DevTools**

Build the extension, load it, trigger a sync, and verify:
- Post pages are visited
- Content is sent to the server
- `full_text`, `hook_text`, `image_urls` columns are populated

- [ ] **Step 5: Commit**

```bash
git add extension/src/content/index.ts extension/src/background/service-worker.ts
git commit -m "feat: wire post page scraping into extension sync flow for full text and images"
```

---

## Chunk 3: Image Download + Storage + Serving

### Task 6: Image Downloader Module

**Files:**
- Create: `server/src/ai/image-downloader.ts`
- Test: `server/src/__tests__/image-downloader.test.ts`

- [ ] **Step 1: Write failing test — downloadPostImages downloads and saves images**

Create `server/src/__tests__/image-downloader.test.ts`:

```typescript
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { downloadPostImages } from "../ai/image-downloader";

const TEST_DIR = path.join(import.meta.dirname, "../../test-data-images");

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

test("downloadPostImages saves images and returns local paths", async () => {
  // Mock fetch to return fake image data
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
  });

  try {
    const paths = await downloadPostImages(
      "test-post-1",
      ["https://media.licdn.com/dms/image/test1.jpg", "https://media.licdn.com/dms/image/test2.jpg"],
      TEST_DIR
    );

    expect(paths).toHaveLength(2);
    expect(paths[0]).toContain("test-post-1/0.jpg");
    expect(paths[1]).toContain("test-post-1/1.jpg");
    expect(fs.existsSync(path.join(TEST_DIR, "test-post-1", "0.jpg"))).toBe(true);
    expect(fs.existsSync(path.join(TEST_DIR, "test-post-1", "1.jpg"))).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("downloadPostImages retries on failure", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = vi.fn().mockImplementation(() => {
    attempts++;
    if (attempts < 3) return Promise.reject(new Error("Network error"));
    return Promise.resolve({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    });
  });

  try {
    const paths = await downloadPostImages(
      "retry-test",
      ["https://media.licdn.com/dms/image/retry.jpg"],
      TEST_DIR
    );
    expect(paths).toHaveLength(1);
    expect(attempts).toBe(3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("downloadPostImages returns empty array on total failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

  try {
    const paths = await downloadPostImages(
      "fail-test",
      ["https://media.licdn.com/dms/image/fail.jpg"],
      TEST_DIR
    );
    expect(paths).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- --run -t "downloadPostImages"`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement image downloader**

Create `server/src/ai/image-downloader.ts`:

```typescript
import fs from "fs";
import path from "path";

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1000, 3000, 10000];

async function fetchWithRetry(url: string): Promise<ArrayBuffer> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.arrayBuffer();
    } catch (err) {
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        continue;
      }
      throw err;
    }
  }
  throw new Error("unreachable");
}

/**
 * Downloads images for a post and saves them to disk.
 * Returns array of local paths (relative to dataDir), or empty array on failure.
 */
export async function downloadPostImages(
  postId: string,
  imageUrls: string[],
  dataDir: string
): Promise<string[]> {
  const postDir = path.join(dataDir, postId);
  fs.mkdirSync(postDir, { recursive: true });

  const localPaths: string[] = [];

  for (let i = 0; i < imageUrls.length; i++) {
    const filename = `${i}.jpg`;
    const filePath = path.join(postDir, filename);
    const relativePath = path.join(postId, filename);

    try {
      const data = await fetchWithRetry(imageUrls[i]);
      fs.writeFileSync(filePath, Buffer.from(data));
      localPaths.push(relativePath);
    } catch (err) {
      console.error(
        `[Image Download] Failed for post ${postId}, image ${i}: ${err instanceof Error ? err.message : err}`
      );
      // Skip this image, continue with others
    }
  }

  return localPaths;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- --run -t "downloadPostImages"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/ai/image-downloader.ts server/src/__tests__/image-downloader.test.ts
git commit -m "feat: add image downloader with retry logic for LinkedIn CDN images"
```

---

### Task 7: Image Serving Endpoint + Download Trigger on Ingest

**Files:**
- Modify: `server/src/app.ts`
- Modify: `server/src/db/queries.ts`
- Test: `server/src/__tests__/server.test.ts`

- [ ] **Step 1: Write failing tests — GET /api/images/:postId/:index**

Add to `server/src/__tests__/server.test.ts`:

```typescript
import fs from "fs";
import path from "path";

test("GET /api/images/:postId/:index returns 404 when image doesn't exist", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/api/images/nonexistent/0",
  });
  expect(response.statusCode).toBe(404);
});

test("GET /api/images/:postId/:index serves image when it exists", async () => {
  // Create a test image file in the expected location
  const dataDir = path.join(path.dirname(dbPath), "data", "images");
  const postDir = path.join(dataDir, "serve-test");
  fs.mkdirSync(postDir, { recursive: true });
  fs.writeFileSync(path.join(postDir, "0.jpg"), Buffer.from([0xFF, 0xD8, 0xFF])); // JPEG magic bytes

  const response = await app.inject({
    method: "GET",
    url: "/api/images/serve-test/0",
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toContain("image/jpeg");

  // Cleanup
  fs.rmSync(postDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- --run -t "images"`
Expected: FAIL — 404 because route doesn't exist (falls through to SPA handler)

- [ ] **Step 3: Add image serving endpoint and download trigger**

In `server/src/app.ts`, add:

```typescript
import path from "path";
import fs from "fs";

// Serve post images
app.get("/api/images/:postId/:index", async (request, reply) => {
  const { postId, index } = request.params as { postId: string; index: string };
  const dataDir = path.join(path.dirname(dbPath), "data", "images");
  const imagePath = path.join(dataDir, postId, `${index}.jpg`);

  if (!fs.existsSync(imagePath)) {
    return reply.status(404).send({ error: "Image not found" });
  }

  return reply.type("image/jpeg").send(fs.readFileSync(imagePath));
});
```

In the ingest handler, after the `upsertPost` loop and before sending the response, add image download triggering:

```typescript
// After upsert loop, before return:
// Trigger image downloads for posts with image_urls but no local paths
if (payload.posts) {
  const postsWithImages = payload.posts.filter(
    (p) => p.image_urls && p.image_urls.length > 0
  );
  if (postsWithImages.length > 0) {
    // Fire and forget — don't block the response
    import("./ai/image-downloader.js").then(({ downloadPostImages }) => {
      const dataDir = path.join(path.dirname(dbPath), "data", "images");
      for (const post of postsWithImages) {
        // Check if already downloaded
        const existing = db
          .prepare("SELECT image_local_paths FROM posts WHERE id = ?")
          .get(post.id) as { image_local_paths: string | null } | undefined;
        if (existing?.image_local_paths) continue;

        downloadPostImages(post.id, post.image_urls!, dataDir).then((paths) => {
          if (paths.length > 0) {
            db.prepare("UPDATE posts SET image_local_paths = ? WHERE id = ?").run(
              JSON.stringify(paths),
              post.id
            );
          }
        }).catch((err) => {
          console.error(`[Image Download] Failed for ${post.id}:`, err.message);
        });
      }
    }).catch(() => {});
  }
}
```

- [ ] **Step 4: Run all server tests**

Run: `npm test -w server -- --run`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/app.ts server/src/__tests__/server.test.ts
git commit -m "feat: add image serving endpoint and auto-download trigger on ingest"
```

---

## Chunk 4: Settings Page — Author Photo

### Task 8: Server Settings Routes

**Files:**
- Create: `server/src/routes/settings.ts`
- Modify: `server/src/app.ts`
- Test: `server/src/__tests__/server.test.ts`

- [ ] **Step 1: Install @fastify/multipart dependency**

```bash
npm install -w server @fastify/multipart
```

Register it in `server/src/app.ts`:

```typescript
import multipart from "@fastify/multipart";
app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } });
```

- [ ] **Step 2: Write failing tests for settings endpoints**

Add to `server/src/__tests__/server.test.ts`:

```typescript
test("GET /api/settings/author-photo returns 404 when no photo", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/api/settings/author-photo",
  });
  expect(response.statusCode).toBe(404);
});

test("DELETE /api/settings/author-photo returns ok even when no photo", async () => {
  const response = await app.inject({
    method: "DELETE",
    url: "/api/settings/author-photo",
  });
  expect(response.statusCode).toBe(200);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- --run -t "author-photo"`
Expected: FAIL — routes don't exist

- [ ] **Step 3: Implement settings routes**

Create `server/src/routes/settings.ts`:

```typescript
import type { FastifyInstance } from "fastify";
import fs from "fs";
import path from "path";

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png"]);

export function registerSettingsRoutes(app: FastifyInstance, dataDir: string): void {
  const photoPath = path.join(dataDir, "author-reference.jpg");

  app.get("/api/settings/author-photo", async (_request, reply) => {
    if (!fs.existsSync(photoPath)) {
      return reply.status(404).send({ error: "No author photo uploaded" });
    }
    return reply.type("image/jpeg").send(fs.readFileSync(photoPath));
  });

  app.post("/api/settings/author-photo", async (request, reply) => {
    const contentType = request.headers["content-type"] || "";

    // Handle multipart form data
    if (contentType.includes("multipart/form-data")) {
      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ error: "No file provided" });
      }
      if (!ALLOWED_TYPES.has(data.mimetype)) {
        return reply.status(400).send({ error: "Only JPEG and PNG files are allowed" });
      }
      const chunks: Buffer[] = [];
      for await (const chunk of data.file) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      if (buffer.length > MAX_FILE_SIZE) {
        return reply.status(400).send({ error: "File too large. Max 5MB." });
      }
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(photoPath, buffer);
      return { ok: true };
    }

    // Handle raw binary upload
    const body = request.body as Buffer;
    if (!body || body.length === 0) {
      return reply.status(400).send({ error: "No file provided" });
    }
    if (body.length > MAX_FILE_SIZE) {
      return reply.status(400).send({ error: "File too large. Max 5MB." });
    }
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(photoPath, body);
    return { ok: true };
  });

  app.delete("/api/settings/author-photo", async () => {
    if (fs.existsSync(photoPath)) {
      fs.unlinkSync(photoPath);
    }
    return { ok: true };
  });
}
```

Register in `server/src/app.ts`:

```typescript
import { registerSettingsRoutes } from "./routes/settings.js";

// After insights routes:
const dataDir = path.join(path.dirname(dbPath), "data");
registerSettingsRoutes(app, dataDir);
```

(`@fastify/multipart` was already installed and registered in Step 1.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w server -- --run -t "author-photo"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/settings.ts server/src/app.ts server/package.json server/package-lock.json server/src/__tests__/server.test.ts
git commit -m "feat: add settings routes for author reference photo upload/serve/delete"
```

---

### Task 9: Dashboard Settings Page

**Files:**
- Create: `dashboard/src/pages/Settings.tsx`
- Modify: `dashboard/src/api/client.ts`
- Modify: `dashboard/src/App.tsx`

- [ ] **Step 1: Add settings API methods to client**

In `dashboard/src/api/client.ts`, add to the `api` object:

```typescript
authorPhoto: () =>
  fetch(`${BASE_URL}/settings/author-photo`).then((r) =>
    r.ok ? r.blob().then((b) => URL.createObjectURL(b)) : null
  ),
uploadAuthorPhoto: (file: File) =>
  fetch(`${BASE_URL}/settings/author-photo`, {
    method: "POST",
    body: file,
    headers: { "Content-Type": file.type },
  }).then((r) => r.json()),
deleteAuthorPhoto: () =>
  fetch(`${BASE_URL}/settings/author-photo`, { method: "DELETE" }).then((r) => r.json()),
```

- [ ] **Step 2: Create Settings page component**

Create `dashboard/src/pages/Settings.tsx`:

```tsx
import { useState, useEffect, useRef } from "react";
import { api } from "../api/client";

export default function Settings() {
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.authorPhoto().then(setPhotoUrl).catch(() => {});
  }, []);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!["image/jpeg", "image/png"].includes(file.type)) {
      alert("Please upload a JPEG or PNG file.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      alert("File too large. Max 5MB.");
      return;
    }

    setUploading(true);
    try {
      await api.uploadAuthorPhoto(file);
      const url = await api.authorPhoto();
      setPhotoUrl(url);
    } catch {
      alert("Upload failed. Please try again.");
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async () => {
    await api.deleteAuthorPhoto();
    setPhotoUrl(null);
  };

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Settings</h2>

      <div className="bg-surface-1 border border-border rounded-lg p-5 space-y-4">
        <div>
          <h3 className="text-sm font-medium text-text-primary mb-1">
            Author Reference Photo
          </h3>
          <p className="text-xs text-text-muted">
            Upload a photo of yourself so the AI can identify you in post
            images. Used for image classification — helps determine which posts
            feature you vs. other people.
          </p>
        </div>

        {photoUrl ? (
          <div className="flex items-center gap-4">
            <img
              src={photoUrl}
              alt="Author reference"
              className="w-24 h-24 rounded-lg object-cover border border-border"
            />
            <div className="flex flex-col gap-2">
              <button
                onClick={() => fileInput.current?.click()}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-surface-2 text-text-primary hover:bg-surface-3 transition-colors"
              >
                Replace
              </button>
              <button
                onClick={handleDelete}
                className="px-3 py-1.5 rounded-md text-xs font-medium text-negative hover:bg-negative/10 transition-colors"
              >
                Remove
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => fileInput.current?.click()}
            disabled={uploading}
            className="px-4 py-2 rounded-md text-sm font-medium bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
          >
            {uploading ? "Uploading..." : "Upload Photo"}
          </button>
        )}

        <input
          ref={fileInput}
          type="file"
          accept="image/jpeg,image/png"
          onChange={handleUpload}
          className="hidden"
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add Settings tab to App.tsx**

In `dashboard/src/App.tsx`:

1. Import: `import Settings from "./pages/Settings";`
2. Update tabs: `const tabs = ["Overview", "Posts", "Coach", "Timing", "Followers", "Settings"] as const;`
3. Add render: `{tab === "Settings" && <Settings />}`

- [ ] **Step 4: Verify in browser**

Build dashboard (`npm run build -w dashboard`), start server, open dashboard, navigate to Settings tab. Upload a photo and verify it displays.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/pages/Settings.tsx dashboard/src/api/client.ts dashboard/src/App.tsx
git commit -m "feat: add Settings page with author reference photo upload"
```

---

## Chunk 5: Image Classification

### Task 10: Image Classifier Module

**Files:**
- Create: `server/src/ai/image-classifier.ts`
- Test: `server/src/__tests__/image-classifier.test.ts`

- [ ] **Step 1: Write failing test — buildClassifierPrompt produces expected structure**

Create `server/src/__tests__/image-classifier.test.ts`:

```typescript
import { describe, test, expect } from "vitest";
import { buildClassifierPrompt, parseClassifierResponse } from "../ai/image-classifier";

test("buildClassifierPrompt returns system prompt with taxonomy", () => {
  const prompt = buildClassifierPrompt();
  expect(prompt).toContain("Format");
  expect(prompt).toContain("People");
  expect(prompt).toContain("Setting");
  expect(prompt).toContain("Text Density");
  expect(prompt).toContain("Energy");
  expect(prompt).toContain("photo");
  expect(prompt).toContain("author-solo");
});

test("parseClassifierResponse extracts valid classifications", () => {
  const response = JSON.stringify({
    format: "photo",
    people: "author-solo",
    setting: "casual-or-personal",
    text_density: "no-text",
    energy: "raw",
  });

  const result = parseClassifierResponse(response);
  expect(result).toEqual({
    format: "photo",
    people: "author-solo",
    setting: "casual-or-personal",
    text_density: "no-text",
    energy: "raw",
  });
});

test("parseClassifierResponse returns null for invalid JSON", () => {
  expect(parseClassifierResponse("not json")).toBeNull();
});

test("parseClassifierResponse returns null for missing fields", () => {
  const response = JSON.stringify({ format: "photo" });
  expect(parseClassifierResponse(response)).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- --run -t "buildClassifierPrompt"`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement image classifier**

Create `server/src/ai/image-classifier.ts`:

```typescript
import type Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { MODELS } from "./client.js";
import type { AiLogger } from "./logger.js";
import { upsertImageTag, getUnclassifiedImagePosts } from "../db/ai-queries.js";

// Valid values for each dimension
const FORMATS = ["photo", "screenshot", "designed-graphic", "chart-or-data", "meme", "slide"] as const;
const PEOPLE = ["author-solo", "author-with-others", "others-only", "no-people"] as const;
const SETTINGS = ["stage-or-event", "office-or-workspace", "casual-or-personal", "digital-only"] as const;
const TEXT_DENSITIES = ["text-heavy", "text-light", "no-text"] as const;
const ENERGIES = ["polished", "raw", "bold", "informational"] as const;

export interface ImageClassification {
  format: string;
  people: string;
  setting: string;
  text_density: string;
  energy: string;
}

export function buildClassifierPrompt(): string {
  return `You are an image classifier for LinkedIn post images. Classify each image along five orthogonal dimensions.

## Format — What kind of image is this?
- photo: Real photograph (camera/phone)
- screenshot: Screen capture (app, tweet, article, DM)
- designed-graphic: Intentionally created visual (quote card, branded graphic)
- chart-or-data: Graph, table, data visualization
- meme: Humor/reaction format
- slide: Presentation-style carousel slide

## People — Who's in it?
- author-solo: The post author only
- author-with-others: Author plus other people
- others-only: People visible but not the author
- no-people: No humans visible

## Setting — What's the context?
- stage-or-event: Speaking, conference, panel, meetup
- office-or-workspace: Professional/work setting
- casual-or-personal: Informal, outdoor, lifestyle
- digital-only: Screenshot, graphic, no physical setting

## Text Density — How much readable text is in the image?
- text-heavy: Text is the primary content
- text-light: Some text/labels, image is primary
- no-text: Purely visual

## Energy — What's the vibe?
- polished: Professional, clean, high production value
- raw: Authentic, unfiltered, casual
- bold: High contrast, attention-grabbing
- informational: Educational, structured, neutral

Return ONLY a JSON object with these five keys. No other text.`;
}

export function parseClassifierResponse(text: string): ImageClassification | null {
  try {
    // Extract JSON from response (may have surrounding text)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    if (
      !parsed.format || !parsed.people || !parsed.setting ||
      !parsed.text_density || !parsed.energy
    ) {
      return null;
    }

    // Validate values
    if (!FORMATS.includes(parsed.format)) return null;
    if (!PEOPLE.includes(parsed.people)) return null;
    if (!SETTINGS.includes(parsed.setting)) return null;
    if (!TEXT_DENSITIES.includes(parsed.text_density)) return null;
    if (!ENERGIES.includes(parsed.energy)) return null;

    return {
      format: parsed.format,
      people: parsed.people,
      setting: parsed.setting,
      text_density: parsed.text_density,
      energy: parsed.energy,
    };
  } catch {
    return null;
  }
}

/**
 * Classify all unclassified images in the database.
 * Runs as a pipeline step in the orchestrator.
 */
export async function classifyImages(
  client: Anthropic,
  db: Database.Database,
  dataDir: string,
  logger: AiLogger
): Promise<void> {
  const posts = getUnclassifiedImagePosts(db);
  if (posts.length === 0) return;

  // Check for author reference photo
  const authorPhotoPath = path.join(dataDir, "author-reference.jpg");
  const hasAuthorPhoto = fs.existsSync(authorPhotoPath);
  const authorPhotoBase64 = hasAuthorPhoto
    ? fs.readFileSync(authorPhotoPath).toString("base64")
    : null;

  const systemPrompt = buildClassifierPrompt();

  for (const post of posts) {
    const imagePaths: string[] = JSON.parse(post.image_local_paths);

    for (let i = 0; i < imagePaths.length; i++) {
      const fullPath = path.join(dataDir, "images", imagePaths[i]);
      if (!fs.existsSync(fullPath)) continue;

      const imageBase64 = fs.readFileSync(fullPath).toString("base64");
      const content: Anthropic.Messages.ContentBlockParam[] = [];

      // Include author reference photo if available
      if (authorPhotoBase64) {
        content.push({
          type: "text",
          text: "Reference photo of the post author (use this to identify the author in the image below):",
        });
        content.push({
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: authorPhotoBase64 },
        });
      }

      content.push({
        type: "text",
        text: `LinkedIn post image to classify${post.hook_text ? `. Post caption: "${post.hook_text}"` : ""}:`,
      });
      content.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: imageBase64 },
      });

      try {
        const start = Date.now();
        const response = await client.messages.create({
          model: MODELS.HAIKU,
          max_tokens: 256,
          system: systemPrompt,
          messages: [{ role: "user", content }],
        });
        const duration = Date.now() - start;

        const text = response.content
          .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n");

        logger.log({
          step: "image_classification",
          model: MODELS.HAIKU,
          input_messages: JSON.stringify([{ role: "user", content: `[image ${i} for ${post.id}]` }]),
          output_text: text,
          tool_calls: null,
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          thinking_tokens: 0,
          duration_ms: duration,
        });

        const classification = parseClassifierResponse(text);
        if (classification) {
          upsertImageTag(db, {
            post_id: post.id,
            image_index: i,
            ...classification,
            model: MODELS.HAIKU,
          });
        }
      } catch (err) {
        console.error(
          `[Image Classifier] Failed for ${post.id} image ${i}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w server -- --run -t "Classifier"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/ai/image-classifier.ts server/src/__tests__/image-classifier.test.ts
git commit -m "feat: add image classifier with Haiku vision, 5-dimension taxonomy, author reference photo"
```

---

### Task 11: Integrate Image Classifier into Orchestrator Pipeline

**Files:**
- Modify: `server/src/ai/orchestrator.ts`

- [ ] **Step 1: Import and add classifyImages step**

In `server/src/ai/orchestrator.ts`, add import:

```typescript
import { classifyImages } from "./image-classifier.js";
```

In `runPipeline()`, after the tagging step and before the analysis step, add:

```typescript
// Classify unclassified images
const dataDir = path.join(path.dirname(db.name), "data");
await classifyImages(client, db, dataDir, logger);
```

Add the `path` import at the top:

```typescript
import path from "path";
```

- [ ] **Step 2: Run all server tests**

Run: `npm test -w server -- --run`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add server/src/ai/orchestrator.ts
git commit -m "feat: integrate image classification step into AI pipeline orchestrator"
```

---

## Chunk 6: Prompt and Output Quality Improvements

### Task 12: Prompt Rewrites — Language Rules and Schema Updates

**Files:**
- Modify: `server/src/ai/prompts.ts`
- Test: `server/src/__tests__/ai-prompts.test.ts`

- [ ] **Step 1: Write failing test — prompts include language rules**

Add to `server/src/__tests__/ai-prompts.test.ts`:

```typescript
test("patternDetectionPrompt includes language rules", () => {
  const prompt = patternDetectionPrompt("summary", "patterns");
  expect(prompt).toContain("Never use abbreviations");
  expect(prompt).toContain("engagement rate");
  expect(prompt).toContain("topic/hook text");
  expect(prompt).toContain("Never reference posts by ID");
});

test("patternDetectionPrompt includes full_text and hook_text in schema", () => {
  const prompt = patternDetectionPrompt("summary", "patterns");
  expect(prompt).toContain("full_text");
  expect(prompt).toContain("hook_text");
  expect(prompt).toContain("image_urls");
  expect(prompt).toContain("image_local_paths");
});

test("patternDetectionPrompt includes ai_image_tags schema", () => {
  const prompt = patternDetectionPrompt("summary", "patterns");
  expect(prompt).toContain("ai_image_tags");
  expect(prompt).toContain("text_density");
  expect(prompt).toContain("energy");
});

test("synthesisPrompt includes language rules", () => {
  const prompt = synthesisPrompt("findings", "feedback");
  expect(prompt).toContain("Never use abbreviations");
  expect(prompt).toContain("topic/hook text");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- --run -t "language rules"`
Expected: FAIL — prompts don't contain these strings

- [ ] **Step 3: Update prompts**

In `server/src/ai/prompts.ts`, add a shared language rules block:

```typescript
const LANGUAGE_RULES = `
## Language Rules
- Never use abbreviations or internal metric names. Say "engagement rate" not "WER". Say "shares" not "reposts".
- When referencing specific posts, describe them by their topic/hook text (e.g., "your post about due diligence questions for investors") and include the date. Never reference posts by ID number.
- All numbers must have plain-English context. Don't say "WER 0.0608" — say "6.1% engagement rate".
- Don't just identify what works — explain WHY it works and give a specific next action the author can take this week.`;
```

Update `patternDetectionPrompt` schema section to include new columns:

```
- **posts**: id (TEXT PK), content_preview (TEXT), full_text (TEXT), hook_text (TEXT), image_urls (TEXT), image_local_paths (TEXT), content_type (TEXT), published_at (DATETIME), url (TEXT), created_at (DATETIME)
```

Add `ai_image_tags` to the schema:

```
- **ai_image_tags**: post_id (TEXT), image_index (INTEGER), format (TEXT), people (TEXT), setting (TEXT), text_density (TEXT), energy (TEXT)
```

Add image analysis instruction:

```
Correlate image classifications with performance metrics. Look for patterns like: do posts with the author visible get more comments? Do screenshots get more shares? Do polished vs raw images perform differently?
```

Add `${LANGUAGE_RULES}` to the end of `patternDetectionPrompt`, `hypothesisTestingPrompt`, and `synthesisPrompt`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w server -- --run -t "prompt"`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/ai/prompts.ts server/src/__tests__/ai-prompts.test.ts
git commit -m "feat: add language rules, updated schema descriptions, and image analysis to all prompts"
```

---

### Task 13: Update Tagger and BuildSummary to Use Full Text

**Files:**
- Modify: `server/src/ai/orchestrator.ts`
- Modify: `server/src/ai/analyzer.ts`
- Test: `server/src/__tests__/ai-analyzer.test.ts`

- [ ] **Step 1: Update orchestrator to use COALESCE for tagging**

In `server/src/ai/orchestrator.ts`, change the post query for untagged posts from:

```typescript
const posts = db
  .prepare(
    `SELECT id, content_preview FROM posts WHERE id IN (${untaggedIds.map(() => "?").join(",")})`
  )
  .all(...untaggedIds) as { id: string; content_preview: string | null }[];
```

to:

```typescript
const posts = db
  .prepare(
    `SELECT id, COALESCE(full_text, content_preview) as content_preview FROM posts WHERE id IN (${untaggedIds.map(() => "?").join(",")})`
  )
  .all(...untaggedIds) as { id: string; content_preview: string | null }[];
```

- [ ] **Step 2: Update buildSummary to include hook_text in the data summary**

In `server/src/ai/analyzer.ts`, update `buildSummary()`. The function currently returns a `.join("\n")` of an array literal (lines 121-129). Replace the return statement with:

```typescript
  // Include recent post hooks for context
  const recentPosts = db
    .prepare(
      `SELECT id, COALESCE(hook_text, SUBSTR(COALESCE(full_text, content_preview), 1, 100)) as preview,
              content_type, published_at
       FROM posts
       ORDER BY published_at DESC
       LIMIT 10`
    )
    .all() as { id: string; preview: string | null; content_type: string; published_at: string }[];

  const postList = recentPosts
    .map((p) => `- [${p.content_type}] ${p.published_at?.split("T")[0] ?? "?"}: "${p.preview ?? "(no preview)"}"`)
    .join("\n");

  return [
    `Posts with metrics: ${postCount}`,
    `Date range: ${dateRange.earliest ?? "N/A"} to ${dateRange.latest ?? "N/A"}`,
    `Avg impressions: ${Math.round(avgEngagement.avg_impressions ?? 0)}`,
    `Avg reactions: ${Math.round(avgEngagement.avg_reactions ?? 0)}`,
    `Avg comments: ${Math.round(avgEngagement.avg_comments ?? 0)}`,
    `Avg reposts: ${Math.round(avgEngagement.avg_reposts ?? 0)}`,
    `Current followers: ${followerRow?.total_followers ?? "N/A"}`,
    "",
    "Recent posts (most recent first):",
    postList,
  ].join("\n");
```

- [ ] **Step 3: Run all server tests**

Run: `npm test -w server -- --run`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add server/src/ai/orchestrator.ts server/src/ai/analyzer.ts
git commit -m "feat: use full_text/hook_text for tagging and data summary, include recent posts in summary"
```

---

### Task 14: Improve Top Performer Reason and Wire Feedback History

**Files:**
- Modify: `server/src/ai/orchestrator.ts`
- Modify: `server/src/ai/analyzer.ts`
- Modify: `server/src/db/ai-queries.ts`

- [ ] **Step 1: Update top performer to use hook_text and AI-generated reason**

In `server/src/ai/orchestrator.ts`, update the top performer query to include hook_text:

```typescript
const topPerformer = db
  .prepare(
    `SELECT p.id, COALESCE(p.hook_text, SUBSTR(p.full_text, 1, 100), p.content_preview) as preview,
            p.published_at, p.url,
            pm.impressions, pm.reactions, pm.comments, pm.reposts,
            (COALESCE(pm.comments,0)*5 + COALESCE(pm.reposts,0)*3 + COALESCE(pm.saves,0)*3 + COALESCE(pm.sends,0)*3 + COALESCE(pm.reactions,0)*1) as weighted_score
     FROM posts p
     JOIN post_metrics pm ON pm.post_id = p.id
     JOIN (SELECT post_id, MAX(id) as max_id FROM post_metrics GROUP BY post_id) latest ON pm.id = latest.max_id
     WHERE p.published_at >= datetime('now', '-30 days')
     ORDER BY weighted_score DESC LIMIT 1`
  )
  .get() as { id: string; preview: string | null; published_at: string; url: string | null; impressions: number; reactions: number; comments: number; reposts: number; weighted_score: number } | undefined;
```

Generate an AI-written explanation of why the top performer resonated. Use a short Haiku call:

```typescript
let topPerformerReason: string | null = null;
if (topPerformer) {
  try {
    const reasonResponse = await client.messages.create({
      model: MODELS.HAIKU,
      max_tokens: 200,
      system: "You write concise, plain-language explanations of why LinkedIn posts performed well. One sentence max.",
      messages: [
        {
          role: "user",
          content: `This LinkedIn post was the top performer in the last 30 days:
Post topic: "${topPerformer.preview ?? "Unknown"}"
Date: ${new Date(topPerformer.published_at).toLocaleDateString()}
Impressions: ${topPerformer.impressions?.toLocaleString() ?? 0}
Comments: ${topPerformer.comments ?? 0}
Reactions: ${topPerformer.reactions ?? 0}

In one sentence, explain why this post resonated with the audience.`,
        },
      ],
    });
    const reasonText = reasonResponse.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    topPerformerReason = `"${topPerformer.preview ?? "Post"}" (${new Date(topPerformer.published_at).toLocaleDateString()}) — ${reasonText}`;
  } catch {
    // Fallback to template if LLM call fails
    topPerformerReason = `"${topPerformer.preview ?? "Post"}" (${new Date(topPerformer.published_at).toLocaleDateString()}) — ${topPerformer.impressions?.toLocaleString() ?? 0} impressions, ${topPerformer.comments ?? 0} comments, ${topPerformer.reactions ?? 0} reactions`;
  }
}
```

Then update the overview upsert:

```typescript
upsertOverview(db, {
  run_id: runId,
  summary_text: analysis.summary,
  top_performer_post_id: topPerformer?.id ?? null,
  top_performer_reason: topPerformerReason,
  quick_insights: JSON.stringify(
    analysis.insights.slice(0, 5).map((i) => i.claim)
  ),
});
```

- [ ] **Step 2: Wire feedback history into synthesis prompt**

Add a function to `server/src/db/ai-queries.ts`:

```typescript
export function getRecentFeedbackWithReasons(db: Database.Database): { headline: string; feedback: string; reason: string | null }[] {
  const rows = db
    .prepare(
      `SELECT headline, feedback FROM recommendations
       WHERE feedback IS NOT NULL
       ORDER BY feedback_at DESC
       LIMIT 20`
    )
    .all() as { headline: string; feedback: string }[];

  return rows.map((row) => {
    // Parse feedback — may be JSON { rating, reason } or plain string
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
```

In `server/src/ai/analyzer.ts`, update the synthesis stage to use feedback:

Replace the `feedbackHistory` TODO:

```typescript
const feedbackHistory = ""; // TODO: pull from recommendation feedback
```

with:

```typescript
import { getRecentFeedbackWithReasons } from "../db/ai-queries.js";

// In runAnalysis, before synthesis stage:
const feedbackRows = getRecentFeedbackWithReasons(db);
const feedbackHistory = feedbackRows.length > 0
  ? feedbackRows
      .map((f) => {
        const reason = f.reason ? ` because: "${f.reason}"` : "";
        return `- The user found "${f.headline}" ${f.feedback === "useful" ? "useful" : "not useful"}${reason}`;
      })
      .join("\n")
  : "No feedback history yet.";
```

- [ ] **Step 3: Run all server tests**

Run: `npm test -w server -- --run`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add server/src/ai/orchestrator.ts server/src/ai/analyzer.ts server/src/db/ai-queries.ts
git commit -m "feat: improve top performer display with hook text, wire feedback history into synthesis"
```

---

## Chunk 7: Dashboard Fixes

### Task 15: Fix "vs Prior" Labels

**Files:**
- Modify: `dashboard/src/pages/Overview.tsx`

- [ ] **Step 1: Update pctChange to include period label**

In `dashboard/src/pages/Overview.tsx`, change the `pctChange` function:

```typescript
function pctChange(
  current: number | null | undefined,
  previous: number | null | undefined,
  rangeDays: number,
): string | null {
  if (rangeDays === 0) return null; // "All" — no meaningful comparison
  if (current == null || previous == null || previous === 0) return null;
  const delta = ((current - previous) / previous) * 100;
  const sign = delta >= 0 ? "+" : "";
  return `${sign}${delta.toFixed(1)}% vs prev ${rangeDays}d`;
}
```

Update all calls to `pctChange` to pass `range` as the third argument:

```typescript
subtitle={pctChange(overview?.total_impressions, prevOverview?.total_impressions, range)}
```

(Do the same for all four KPICard instances.)

- [ ] **Step 2: Verify in browser**

Build and check: 7d → "+X% vs prev 7d", 30d → "+X% vs prev 30d", All → no subtitle shown.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/pages/Overview.tsx
git commit -m "fix: clarify 'vs prior' labels to show comparison period (7d, 30d, 90d)"
```

---

### Task 16: Improve Top Performer Card

**Files:**
- Modify: `dashboard/src/pages/Overview.tsx`
- Modify: `dashboard/src/api/client.ts`

- [ ] **Step 1: Update AiOverview type to include new fields**

In `dashboard/src/api/client.ts`, update `AiOverview`:

```typescript
export interface AiOverview {
  summary_text: string;
  top_performer_post_id: string | null;
  top_performer_reason: string | null;
  quick_insights: string; // JSON array string
}
```

(No change needed — the type already has these fields. The server now returns richer `top_performer_reason` text.)

- [ ] **Step 2: Update top performer card rendering**

In `dashboard/src/pages/Overview.tsx`, update the top performer card to show richer content:

```tsx
{aiOverview?.top_performer_reason && (
  <div className="bg-positive/5 border border-positive/20 rounded-lg p-5">
    <h3 className="text-sm font-medium text-positive mb-2">
      Top Performer
    </h3>
    <p className="text-sm text-text-primary leading-relaxed">
      {aiOverview.top_performer_reason}
    </p>
    {aiOverview.top_performer_post_id && (
      <a
        href={`https://www.linkedin.com/feed/update/urn:li:activity:${aiOverview.top_performer_post_id}/`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-accent hover:underline mt-2 inline-block"
      >
        View post on LinkedIn
      </a>
    )}
  </div>
)}
```

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/pages/Overview.tsx
git commit -m "feat: improve top performer card with post preview, date, and LinkedIn link"
```

---

### Task 17: Posts Table — Show Hook Text + Thumbnails

**Files:**
- Modify: `dashboard/src/api/client.ts`
- Modify: `dashboard/src/pages/Posts.tsx`
- Modify: `server/src/db/queries.ts`

- [ ] **Step 1: Update server queryPosts to return hook_text and full_text**

In `server/src/db/queries.ts`, update the `querySql` in `queryPosts`:

Change the SELECT to include:

```sql
SELECT p.id, p.content_preview, p.hook_text, p.full_text, p.image_local_paths,
       p.content_type, p.published_at, p.url,
       m.impressions, m.reactions, m.comments, m.reposts,
       ...
```

- [ ] **Step 2: Update Post type in dashboard client**

In `dashboard/src/api/client.ts`:

```typescript
export interface Post {
  id: string;
  content_preview: string | null;
  hook_text: string | null;
  full_text: string | null;
  image_local_paths: string | null;
  content_type: string;
  published_at: string;
  url: string | null;
  impressions: number | null;
  reactions: number | null;
  comments: number | null;
  reposts: number | null;
  engagement_rate: number | null;
}
```

- [ ] **Step 3: Update Posts table rendering**

In `dashboard/src/pages/Posts.tsx`, update the post preview cell:

```tsx
<td className="px-4 py-3">
  <div className="flex items-center gap-3">
    {(() => {
      // Show thumbnail for image posts
      const hasImages = p.image_local_paths && JSON.parse(p.image_local_paths).length > 0;
      if (hasImages) {
        return (
          <img
            src={`/api/images/${p.id}/0`}
            alt=""
            className="w-10 h-10 rounded object-cover shrink-0"
            loading="lazy"
          />
        );
      }
      return null;
    })()}
    <p className="truncate max-w-xs text-text-primary">
      {p.hook_text || (p.full_text ? p.full_text.slice(0, 80) : p.content_preview) || "(no preview)"}
    </p>
  </div>
</td>
```

- [ ] **Step 4: Run server tests**

Run: `npm test -w server -- --run`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/db/queries.ts dashboard/src/api/client.ts dashboard/src/pages/Posts.tsx
git commit -m "feat: show hook_text and image thumbnails in posts table"
```

---

### Task 18: Feedback "Why" Field — API + UI

**Files:**
- Modify: `server/src/routes/insights.ts`
- Modify: `dashboard/src/api/client.ts`
- Modify: `dashboard/src/pages/Coach.tsx`
- Test: `server/src/__tests__/insights-routes.test.ts`

- [ ] **Step 1: Write failing test — feedback endpoint accepts JSON with reason**

Add to `server/src/__tests__/insights-routes.test.ts`:

```typescript
test("PATCH /api/insights/recommendations/:id/feedback accepts JSON with reason", async () => {
  // Seed data via the ingest API and trigger AI run to create recommendations
  // Use the test db instance from the test setup (see existing insights-routes.test.ts pattern)
  // The db is passed to buildApp and available via the test's module-level variable
  db.prepare("INSERT INTO ai_runs (triggered_by, status, post_count) VALUES ('test', 'completed', 15)").run();
  const runId = (db.prepare("SELECT MAX(id) as id FROM ai_runs").get() as { id: number }).id;
  db.prepare(
    "INSERT INTO recommendations (run_id, type, priority, confidence, headline, detail, action, evidence_json) VALUES (?, 'quick_win', 1, 0.9, 'Test', 'Detail', 'Action', '[]')"
  ).run(runId);
  const recId = (db.prepare("SELECT MAX(id) as id FROM recommendations").get() as { id: number }).id;

  const response = await app.inject({
    method: "PATCH",
    url: `/api/insights/recommendations/${recId}/feedback`,
    payload: {
      feedback: { rating: "useful", reason: "Very specific and actionable" },
    },
  });
  expect(response.statusCode).toBe(200);

  // Verify stored as JSON
  const rec = db.prepare("SELECT feedback FROM recommendations WHERE id = ?").get(recId) as { feedback: string };
  const feedback = JSON.parse(rec.feedback);
  expect(feedback.rating).toBe("useful");
  expect(feedback.reason).toBe("Very specific and actionable");
});
```

**Note:** This test should be placed in `server/src/__tests__/insights-routes.test.ts` which already has a module-level `db` variable from the test setup (same `db` instance passed to `buildApp`). Follow the existing test patterns in that file for seeding data.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- --run -t "accepts JSON with reason"`
Expected: FAIL — current handler stores raw string, not JSON

- [ ] **Step 3: Update feedback endpoint**

In `server/src/routes/insights.ts`, update the feedback handler:

```typescript
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
    // Accept both plain string and JSON object
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- --run -t "accepts JSON with reason"`
Expected: PASS

- [ ] **Step 5: Update dashboard API client**

In `dashboard/src/api/client.ts`, update the feedback method:

```typescript
recommendationFeedback: (id: number, rating: string, reason?: string) =>
  fetch(`${BASE_URL}/insights/recommendations/${id}/feedback`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ feedback: { rating, reason: reason || null } }),
  }).then((r) => r.json()),
```

- [ ] **Step 6: Update Coach.tsx with feedback "why" field**

In `dashboard/src/pages/Coach.tsx`:

Add state for feedback reasons:

```typescript
const [reasonMap, setReasonMap] = useState<Record<number, string>>({});
const [showReasonFor, setShowReasonFor] = useState<number | null>(null);
```

Update `handleFeedback`:

```typescript
const handleFeedback = (id: number, feedback: string) => {
  setFeedbackMap((prev) => ({ ...prev, [id]: feedback }));
  setShowReasonFor(id);
  api.recommendationFeedback(id, feedback).catch(() => {});
};

const handleReasonSubmit = (id: number) => {
  const reason = reasonMap[id];
  if (reason?.trim()) {
    api.recommendationFeedback(id, feedbackMap[id], reason).catch(() => {});
  }
  setShowReasonFor(null);
};
```

Update the feedback buttons section to add a reason input that slides open:

```tsx
{/* Feedback buttons */}
<div className="space-y-2 pt-1">
  <div className="flex items-center gap-2">
    <button
      onClick={() => handleFeedback(rec.id, "useful")}
      className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
        feedbackMap[rec.id] === "useful"
          ? "bg-positive/15 text-positive"
          : "bg-surface-2 text-text-muted hover:text-text-primary"
      }`}
    >
      Useful
    </button>
    <button
      onClick={() => handleFeedback(rec.id, "not_useful")}
      className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
        feedbackMap[rec.id] === "not_useful"
          ? "bg-negative/15 text-negative"
          : "bg-surface-2 text-text-muted hover:text-text-primary"
      }`}
    >
      Not useful
    </button>
  </div>

  {/* Reason input — slides open after feedback */}
  {showReasonFor === rec.id && (
    <div className="flex gap-2 items-center">
      <input
        type="text"
        placeholder={
          feedbackMap[rec.id] === "useful"
            ? "Why was this helpful?"
            : "What would make this more useful?"
        }
        value={reasonMap[rec.id] || ""}
        onChange={(e) =>
          setReasonMap((prev) => ({ ...prev, [rec.id]: e.target.value }))
        }
        onKeyDown={(e) => {
          if (e.key === "Enter") handleReasonSubmit(rec.id);
        }}
        className="flex-1 bg-surface-2 border border-border rounded px-3 py-1.5 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
        autoFocus
      />
      <button
        onClick={() => handleReasonSubmit(rec.id)}
        className="px-2 py-1.5 rounded text-xs font-medium bg-accent/10 text-accent hover:bg-accent/20"
      >
        Send
      </button>
      <button
        onClick={() => setShowReasonFor(null)}
        className="px-2 py-1.5 rounded text-xs text-text-muted hover:text-text-primary"
      >
        Skip
      </button>
    </div>
  )}
</div>
```

Also update the feedback initialization in `load()` to parse JSON feedback:

```typescript
const fb: Record<number, string> = {};
for (const rec of r.recommendations) {
  if (rec.feedback) {
    try {
      const parsed = JSON.parse(rec.feedback);
      fb[rec.id] = parsed.rating ?? rec.feedback;
    } catch {
      fb[rec.id] = rec.feedback;
    }
  }
}
```

- [ ] **Step 7: Run all tests**

Run: `npm test -w server -- --run`
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add server/src/routes/insights.ts dashboard/src/api/client.ts dashboard/src/pages/Coach.tsx server/src/__tests__/insights-routes.test.ts
git commit -m "feat: add feedback 'why' field — JSON feedback with reason, slide-open input on Coach page"
```

---

## Chunk 8: Backfill + Extension Integration

### Task 19: Backfill Logic in Extension

**Files:**
- Modify: `extension/src/background/service-worker.ts`

- [ ] **Step 1: Add backfill phase to sync flow**

After `scrapeRemainingPages` completes in `finishSync()`, add a backfill check:

```typescript
// In finishSync(), before recording lastSyncAt:
// Check if there are posts needing content backfill
try {
  const needsContentRes = await fetch(`${SERVER_URL}/api/posts/needs-content`);
  if (needsContentRes.ok) {
    const { post_ids } = await needsContentRes.json();
    if (post_ids.length > 0) {
      // Store backfill queue for separate phase
      await chrome.storage.session.set({
        backfillQueue: post_ids,
        backfillCursor: 0,
      });
      // Schedule backfill
      chrome.alarms.create("backfill-continue", { delayInMinutes: 0.1 });
    }
  }
} catch {
  // Non-fatal — backfill will happen next sync
}
```

Add a backfill handler:

```typescript
// In the alarm listener, add:
else if (alarm.name === "backfill-continue") {
  await continueBackfill();
}
```

```typescript
async function continueBackfill() {
  const { backfillQueue, backfillCursor = 0 } = await chrome.storage.session.get([
    "backfillQueue",
    "backfillCursor",
  ]);
  if (!backfillQueue || backfillCursor >= backfillQueue.length) {
    await chrome.storage.session.set({ backfillQueue: null, backfillCursor: null });
    return;
  }

  // Create a background tab for backfill
  const tab = await chrome.tabs.create({ active: false, url: "about:blank" });
  if (!tab.id) return;

  const batchEnd = Math.min(backfillCursor + 5, backfillQueue.length);

  try {
    for (let i = backfillCursor; i < batchEnd; i++) {
      const postId = backfillQueue[i];
      const postUrl = `https://www.linkedin.com/feed/update/urn:li:activity:${postId}/`;

      await chrome.tabs.update(tab.id, { url: postUrl });
      await waitForTabLoad(tab.id);
      await randomDelay(BACKFILL_PACING_MIN_MS, BACKFILL_PACING_MAX_MS);

      // Click "see more" if present
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const btn = document.querySelector(
              '.feed-shared-inline-show-more-text__see-more-less-toggle'
            ) as HTMLElement | null;
            if (btn) btn.click();
          },
        });
        await new Promise((r) => setTimeout(r, 1500));
      } catch {}

      const result = await sendScrapeCommand(tab.id);
      if (result.type === "post-content") {
        await postToServer({
          posts: [{
            id: postId,
            full_text: result.data.full_text,
            hook_text: result.data.hook_text,
            image_urls: result.data.image_urls,
          }],
        });
      }
    }

    await chrome.storage.session.set({ backfillCursor: batchEnd });

    if (batchEnd < backfillQueue.length) {
      chrome.alarms.create("backfill-continue", { delayInMinutes: 0.1 });
    } else {
      await chrome.storage.session.set({ backfillQueue: null, backfillCursor: null });
    }
  } catch (err: any) {
    console.error("[LinkedIn Analytics] Backfill error:", err.message);
    await chrome.storage.session.set({ backfillQueue: null, backfillCursor: null });
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch {}
  }
}
```

- [ ] **Step 2: Update extension manifest**

Ensure `extension/manifest.json` has:
- Content script matches include `*://*.linkedin.com/feed/*`
- `scripting` permission for `chrome.scripting.executeScript`

- [ ] **Step 3: Commit**

```bash
git add extension/src/background/service-worker.ts
git commit -m "feat: add backfill phase to extension sync for posts missing full text and images"
```

---

### Task 20: Final Integration — Verify End-to-End

- [ ] **Step 1: Run ALL tests**

```bash
npm test -w server -- --run
npm test -w extension -- --run
```

Expected: ALL PASS

- [ ] **Step 2: Build dashboard**

```bash
npm run build -w dashboard
```

Expected: Build succeeds

- [ ] **Step 3: Manual end-to-end verification**

1. Start server: `npm run dev -w server`
2. Open dashboard, verify Settings tab exists
3. Upload author photo on Settings page
4. Load extension, trigger sync
5. Verify posts get `full_text`, `hook_text`, `image_urls` populated
6. Verify images are downloaded to `data/images/`
7. Click "Refresh AI" — verify pipeline runs image classification
8. Check Coach page — verify feedback "why" input works
9. Check Overview — verify "vs prior" labels show period
10. Check Posts table — verify hook text and thumbnails display

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: AI Insights UX v2 — full text, image analysis, prompt quality, and feedback loops"
```
