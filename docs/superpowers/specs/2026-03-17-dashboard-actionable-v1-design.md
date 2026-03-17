# Dashboard Actionable V1 — Design Spec

## Goal

Make the LinkedIn analytics dashboard more actionable by fixing broken features, enriching post detail views, and making the writing prompt a one-click tool with auto-injected top-performing examples.

## Problems Identified

1. **Photo upload broken** — Settings page has two independent upload flows (`handleUpload` via `api.uploadAuthorPhoto` blob + `handlePhotoUpload` via direct fetch). Photo renders twice (blob URL + server URL). Neither feedback path is reliable — user can't tell if upload succeeded.

2. **Writing prompt lacks copy-with-context** — User's prompt says "Here's my top 10 biggest posts" but there's no mechanism to auto-inject actual post content. User must manually copy posts. Also, announcement posts (product launches, personal milestones) inflate engagement artificially and shouldn't be included as style examples.

3. **Post detail is minimal** — Clicking a post shows only an impression velocity chart with the raw activity ID as a title. No full text, no images, no engagement breakdown.

4. **Impression velocity label shows raw ID** — `Impression velocity — 7363913952889589764` is meaningless. Should show date + content preview.

## Design

### 1. Fix Photo Upload (Settings Page)

**Problem:** Two competing upload mechanisms create duplicate displays and unreliable feedback.

**Solution:** Consolidate to a single upload path using the direct binary POST to `/api/settings/author-photo`. Remove the old `api.uploadAuthorPhoto` blob-based flow entirely. Display a single photo preview sourced from the server endpoint with cache-busting. Show clear success/error states.

**Changes:**
- `Settings.tsx`: Remove all of: `photoUrl` state, `uploading` state, `handleUpload`, `handleDelete`, blob URL management (`prevUrlRef`, `URL.revokeObjectURL`), and the old `api.uploadAuthorPhoto`/`api.authorPhoto` calls.
- Keep only `photoPreviewUrl` + `handlePhotoUpload`. Add loading state to `handlePhotoUpload`.
- Wire the file input `onChange` to call `handlePhotoUpload(file)` directly.
- Delete button: `DELETE /api/settings/author-photo` then clear `photoPreviewUrl`.
- Show single photo from `photoPreviewUrl` (server endpoint with cache-bust). No blob URLs.
- Show success/error states inline (not alert()).

### 2. Writing Prompt Copy Button with Top Posts

**Problem:** User wants to copy their writing prompt into an LLM with their top 10 best-performing posts as tone examples, but announcement posts inflate numbers artificially.

**Approach:**
- **Server endpoint** `GET /api/posts/top-examples?limit=10` — Returns top posts by impressions, filtered to exclude announcement-type posts. Announcement detection uses keyword heuristics on `full_text`:
  - "excited to announce", "thrilled to announce", "proud to announce", "happy to share that", "excited to share", "I'm joining", "we're launching", "pleased to announce", "grateful this", "had a great time at", "had a great time yesterday"
  - Also exclude posts with `full_text` shorter than 200 chars or NULL — these are usually reshares or trivial updates
  - If fewer than `limit` posts remain after filtering, return what's available (don't backfill with excluded posts)
- **Dashboard UI** — Add a "Copy Prompt" button next to the Save button on the Settings page. When clicked:
  1. Use `promptText` from component state (not a server fetch — avoids round-trip and stale-data race if user has unsaved edits)
  2. Fetch `/api/posts/top-examples?limit=10`
  3. Assemble: `{prompt_text}\n\n---\n\nHere are my top 10 best performing LinkedIn posts for tone and style reference:\n\n{numbered post texts}`
  4. Copy to clipboard via `navigator.clipboard.writeText()`
  5. Show "Copied!" confirmation (2s timeout, same pattern as Save button)

**Post format in assembled prompt:**
```
1. [Date] (Impressions: X, Engagement: Y%)
{full_text}

2. [Date] ...
```

### 3. Post Detail Expansion

**Problem:** Clicking a post only shows an impression chart with a raw ID title.

**Solution:** Replace the current floating detail panel with an inline expansion below the clicked table row (using `<tr><td colSpan={7}>` to span all columns). The expansion shows:

- **Header**: Post date + content type badge + "View on LinkedIn" link (right-aligned, hidden if `url` is null)
- **Content section**: Full text (with paragraph breaks restored via splitting on double-newline or sentence boundaries) + post images (if any, from `/api/images/{id}/{index}`)
- **Metrics grid**: Impressions, Reactions, Comments, Reposts, Saves, Engagement Rate — displayed as a compact 3x2 grid of stat cards
- **Impression velocity chart**: Same chart as today but properly labeled "Impressions over time"

The expansion replaces the current floating panel above the table. Clicking the same post collapses it (toggle). Clicking a different post switches the expansion. Selected post row gets a highlighted left border accent.

### 4. Fix Impression Velocity Label

Subsumed by #3 — the chart now appears inside the expanded detail with a proper label.

### 5. Commit the Existing app.ts Fix

The Zod error path improvement in `server/src/app.ts` line 61 (adding field paths to validation error messages) is uncommitted from the debugging session. Include it in the first commit.

**Route registration:** The new `GET /api/posts/top-examples` endpoint goes inline in `app.ts` alongside the existing `/api/posts` and `/api/posts/needs-content` routes — no new routes file needed.

## Out of Scope

- Sparklines on overview KPI cards (separate effort, needs time-series data aggregation)
- Daily performance views
- Top performer card redesign
- AI pipeline regeneration

## Technical Notes

- Announcement detection is heuristic-based, not ML. This is intentional — it's cheap, fast, transparent, and good enough for filtering 3-5 posts out of 52. Can be refined later.
- The copy button assembles the prompt client-side using data from two API calls. No new server-side prompt assembly needed.
- Post images are already served via `/api/images/:postId/:index`. The Posts page already renders thumbnails.

## Testing

- Photo upload: Upload, verify display. Replace, verify update. Delete, verify removal.
- Copy button: Verify announcement posts are excluded. Verify assembled prompt format. Verify clipboard write.
- Post expansion: Click post, verify full text and images render. Click another post, verify swap. Click same post, verify collapse.
- Top examples endpoint: Verify announcement filtering. Verify limit. Verify sort order.
