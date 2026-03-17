# LinkedIn Analytics Chrome Extension — Design Spec

## Overview

A Chrome extension + local Node server that collects LinkedIn post analytics via LinkedIn's internal Voyager API and stores them in a local SQLite database. A dashboard served by the local server provides charts, tables, and insights for optimizing LinkedIn content strategy.

**Goals:**
- Own your LinkedIn analytics data locally — no subscriptions, no third parties
- Automatic daily collection with zero manual effort
- Track post performance over time (not just final numbers)
- Surface actionable insights: best posting times, content type comparison, engagement trends
- Alert when LinkedIn changes break data collection

**Non-goals:**
- Multi-user support
- Cloud hosting (for now — architecture supports it later)
- Scraping other people's data
- Automating posting or engagement
- Passive fetch interception (v2 — see Future Considerations)

## Prerequisites

**Voyager API Discovery Spike (must complete before implementation):**

The Voyager API is undocumented and endpoints change without notice. Before writing code, we must capture the actual API calls LinkedIn's frontend makes. This involves:

1. Open Chrome DevTools Network tab on `linkedin.com`
2. Navigate to your analytics/creator dashboard pages
3. Filter for `/voyager/api/` requests
4. Document exact endpoints, request parameters, and response shapes for:
   - Listing your own posts (paginated)
   - Per-post metrics (impressions, reactions, comments, reposts)
   - Follower count
   - Profile views / search appearances
5. Create Zod schemas from the actual response shapes
6. Record which pages trigger which API calls

**Known endpoints from research (need validation):**
- `feed/updatesV2?q=backendUrnOrNss&urnOrNss=urn:li:activity:{postId}` — individual post data including `numViews`
- `identity/profiles/{publicIdentifier}/networkinfo` — follower count
- `identity/wvmpCards` — profile view analytics ("Who Viewed My Profile")
- Post listing endpoint — **unknown, must discover during spike**

This spike produces a `voyager-endpoints.md` document that the implementation depends on.

**Risk:** If the spike reveals that there is no clean paginated "list my posts" endpoint (e.g., LinkedIn's feed mixes your posts with others), the collection strategy may need to pivot to scraping the analytics page DOM instead. The rest of the architecture (server, database, dashboard) remains the same regardless — only the extension's data collection layer would change.

## Architecture

Three components:

```
Chrome Extension (data collector)
    │
    │  HTTP POST to localhost:3210/api/ingest
    ▼
Local Node Server (Fastify + better-sqlite3)
    │
    │  Reads/writes
    ▼
SQLite file on disk (data/linkedin.db)
    │
    │  Served by same server
    ▼
Dashboard (React + Chart.js)
```

### Chrome Extension (Manifest V3, TypeScript)

Two modules inside the extension:

**1. Active Syncer**
- Scheduled via `chrome.alarms` (not `setTimeout` — service workers die after 30s of inactivity)
- On alarm fire, checks last sync time via `GET localhost:3210/api/health`
- If 24+ hours since last sync AND user has a `linkedin.com` tab open, triggers sync
- **All Voyager API calls are made from the content script** on `linkedin.com` (same-origin — cookies sent automatically, no CORS issues). The content script relays collected data to the service worker via `chrome.runtime.sendMessage`, and the service worker POSTs to `localhost:3210/api/ingest`.
- Daily sync fetches last 50 posts + metrics, follower count, profile views
- Uses the user's existing session cookies (`li_at`, `JSESSIONID`) — requests are same-origin and identical to LinkedIn's own frontend
- Human-like request pacing: 1-3 second random delays between API calls
- **Sync chunking:** To stay within the MV3 5-minute service worker hard limit, syncs are chunked into batches of 25 posts. Each batch completes independently (data POSTed to server), and the next batch is triggered via a follow-up alarm. If the worker is killed mid-sync, it resumes from the last completed batch on the next alarm.
- Sync timestamps persisted to `chrome.storage.local` (survives browser restarts). Transient state (in-progress flag, current batch cursor) stored in `chrome.storage.session`.

**User Identity Resolution:**
- On first sync, the content script fetches the current user's profile via Voyager API (e.g., `/voyager/api/me`) to resolve the user's profile URN and public identifier
- Stored in `chrome.storage.local` for use in subsequent API calls that require a profile identifier
- If the identity changes (different LinkedIn account), the extension detects the mismatch and prompts the user

**2. Health Monitor**
- Validates every Voyager API response against expected Zod schemas
- Tracks each data source independently: posts, post_metrics, followers, profile_views
- If a response shape changes (field missing, renamed, different structure), logs the error with full response details
- Surfaces health status in the extension popup

**Extension Popup (minimal):**
- Last sync time ("Synced 2 hours ago" / "Never synced")
- Per-source health indicators (posts: OK, followers: OK, profile: BROKEN since 3/12)
- "Sync Now" button for manual trigger
- "Open Dashboard" button → opens `localhost:3210` in a new tab
- Auth status — "Please log in to LinkedIn" if session expired

**Voyager API Details:**

Base URL: `https://www.linkedin.com/voyager/api/`

Authentication:
```
Cookie: JSESSIONID={jsessionid}; li_at={li_at}
csrf-token: {jsessionid}   // JSESSIONID value with quotes stripped
```

Required manifest permissions:
```json
{
  "permissions": ["alarms", "cookies", "storage", "webNavigation"],
  "host_permissions": ["*://*.linkedin.com/*", "http://localhost:3210/*"]
}
```

**Data flow:** Content script (on linkedin.com) makes Voyager API calls (same-origin) → relays data via `chrome.runtime.sendMessage` → service worker POSTs to `localhost:3210/api/ingest`. The service worker needs `host_permissions` for localhost.

Post ID extraction from LinkedIn URLs: `link.match(/activity-(?<postId>\d+)/)?.groups?.postId`

**SPA Navigation Handling:**
- LinkedIn is a single-page app — content scripts don't re-fire on client-side route changes
- Listen for URL changes via `chrome.webNavigation.onHistoryStateUpdated` to detect navigation
- Service worker re-evaluates sync trigger on each navigation event

**Service Worker Lifecycle (MV3):**
- Service worker can be killed after 30s of inactivity, hard limit of 5 minutes even with keepalive
- All alarms re-registered at top level on every worker start:
  ```js
  chrome.alarms.get("daily-sync", (alarm) => {
    if (!alarm) chrome.alarms.create("daily-sync", { periodInMinutes: 30 });
  });
  ```
- Sync timestamps in `chrome.storage.local` (persists across browser restarts); transient state in `chrome.storage.session`
- Sync is chunked into batches (see Active Syncer) so each batch completes well within the 5-minute limit

### Local Node Server

**Tech:** Fastify + better-sqlite3 + TypeScript

Runs on `localhost:3210`. Started via `npm start`.

**CORS Configuration:**
- Must allow requests from the Chrome extension origin (`chrome-extension://{extension-id}`)
- Configure via `@fastify/cors` with a dynamic origin check that accepts `chrome-extension://` origins

**API Endpoints:**

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/ingest` | Receive scraped data from extension |
| GET | `/api/posts` | Query posts with filters, sorting, offset pagination |
| GET | `/api/metrics/:postId` | Metric history for a single post (time series) |
| GET | `/api/overview` | KPI aggregates for dashboard cards |
| GET | `/api/timing` | Day/hour heatmap data for posting time analysis |
| GET | `/api/followers` | Follower count time series |
| GET | `/api/profile` | Profile views and search appearances time series |
| GET | `/api/health` | Sync status per data source, last sync time, errors |

**Ingest Endpoint Schema (`POST /api/ingest`):**

```typescript
// Request body
interface IngestPayload {
  posts?: Array<{
    id: string;              // LinkedIn activity ID
    content_preview?: string; // First ~300 chars
    content_type: "text" | "image" | "carousel" | "video" | "article";
    published_at: string;    // ISO 8601
    url?: string;
  }>;
  post_metrics?: Array<{
    post_id: string;         // References posts.id
    impressions?: number;
    reactions?: number;
    comments?: number;
    reposts?: number;
  }>;
  followers?: {
    total_followers: number;
  };
  profile?: {
    profile_views?: number;
    search_appearances?: number;
  };
}

// Response
interface IngestResponse {
  ok: boolean;
  posts_upserted: number;
  metrics_inserted: number;
  errors?: string[];        // Per-source error messages if partial failure
}
```

**Health Endpoint Schema (`GET /api/health`):**

```typescript
interface HealthResponse {
  last_sync_at: string | null;    // ISO 8601 or null if never synced
  sources: {
    posts: { status: "ok" | "error"; last_success: string | null; error?: string };
    followers: { status: "ok" | "error"; last_success: string | null; error?: string };
    profile: { status: "ok" | "error"; last_success: string | null; error?: string };
  };
}
```

**Posts Endpoint Schema (`GET /api/posts`):**

```typescript
// Query params
interface PostsQuery {
  content_type?: "text" | "image" | "carousel" | "video" | "article";
  since?: string;           // ISO 8601 — only posts published after this date
  until?: string;           // ISO 8601 — only posts published before this date
  min_impressions?: number;
  sort_by?: "published_at" | "impressions" | "engagement_rate" | "reactions" | "comments";
  sort_order?: "asc" | "desc";  // default: desc
  offset?: number;          // default: 0
  limit?: number;           // default: 20, max: 100
}

// Response
interface PostsResponse {
  posts: Array<{
    id: string;
    content_preview: string | null;
    content_type: string;
    published_at: string;
    url: string | null;
    impressions: number | null;
    reactions: number | null;
    comments: number | null;
    reposts: number | null;
    engagement_rate: number | null;
  }>;
  total: number;            // Total matching posts (for pagination)
  offset: number;
  limit: number;
}
```

**Ingest flow:**
1. Validate request body against Zod schema
2. Upsert posts by LinkedIn post ID (update content_preview, content_type if changed)
3. Append new `post_metrics` snapshot rows (never overwrite — track over time)
4. Upsert daily `follower_snapshots` and `profile_snapshots`
5. Log the sync run to `scrape_log` with per-source success/failure status
6. Return counts and any per-source errors

**Static file serving:**
- Serves the React dashboard build from `/` on the same port
- Single command (`npm start`) runs both API and dashboard

### SQLite Database

File location: `data/linkedin.db` in the project directory.

**Initialize with WAL mode** for concurrent reads during writes: `PRAGMA journal_mode=WAL;`

**Schema:**

```sql
PRAGMA journal_mode=WAL;

CREATE TABLE posts (
  id TEXT PRIMARY KEY,          -- LinkedIn post URN / activity ID
  content_preview TEXT,         -- First ~300 chars of post text
  content_type TEXT NOT NULL,   -- text | image | carousel | video | article
  published_at DATETIME,       -- When the post was published
  url TEXT,                     -- Direct link to the post
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP  -- When we first scraped it
);

CREATE TABLE post_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL REFERENCES posts(id),
  scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  impressions INTEGER,
  reactions INTEGER,
  comments INTEGER,
  reposts INTEGER
  -- engagement_rate computed at query time: (reactions + comments + reposts) / NULLIF(impressions, 0)
);
CREATE INDEX idx_post_metrics_post_id ON post_metrics(post_id);
CREATE INDEX idx_post_metrics_scraped_at ON post_metrics(scraped_at);

CREATE TABLE follower_snapshots (
  date DATE PRIMARY KEY,        -- One row per day
  total_followers INTEGER
  -- new_followers computed at query time via LAG() window function
);

CREATE TABLE profile_snapshots (
  date DATE PRIMARY KEY,        -- One row per day
  profile_views INTEGER,
  search_appearances INTEGER
);

CREATE TABLE scrape_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  posts_status TEXT DEFAULT 'pending',      -- pending | success | error
  followers_status TEXT DEFAULT 'pending',
  profile_status TEXT DEFAULT 'pending',
  posts_count INTEGER DEFAULT 0,
  error_details TEXT                         -- JSON with per-source error messages
);
```

**Computed fields rationale:** `engagement_rate` and `new_followers` are computed at query time rather than stored. This avoids drift if the formula changes and handles edge cases (NULL impressions, skipped days) correctly without special write-time logic.

**Useful query patterns:**

```sql
-- Engagement rate for latest metrics per post
SELECT p.*, m.impressions, m.reactions, m.comments, m.reposts,
  CAST(m.reactions + m.comments + m.reposts AS REAL) / NULLIF(m.impressions, 0) AS engagement_rate
FROM posts p
JOIN post_metrics m ON m.post_id = p.id
WHERE m.id = (SELECT MAX(id) FROM post_metrics WHERE post_id = p.id);

-- New followers per day
SELECT date, total_followers,
  total_followers - LAG(total_followers) OVER (ORDER BY date) AS new_followers
FROM follower_snapshots;
```

**Migration strategy:** Use a `schema_version` table and sequential migration scripts in `server/src/db/migrations/`. Each migration is a `.sql` file applied in order on server start. This is simple enough for a local tool — no need for a migration framework.

### Dashboard

**Tech:** React + Chart.js + TailwindCSS, built with Vite, served as static files by the Fastify server.

**Dark theme** with four tabs:

**1. Overview (default)**
- KPI cards: total impressions (period), avg engagement rate, follower count, profile views — each with % change vs previous period
- Impressions over time bar chart
- Engagement by content type breakdown (horizontal bars)
- Recent posts table (sortable by any column)
- Date range selector: 7d / 30d / 90d / All

**2. Posts**
- Full sortable, filterable post table
- Filter by content type, date range, minimum impressions
- Click a post → detail view with metric history chart (impression velocity curve)

**3. Timing**
- Day-of-week × hour-of-day heatmap
- Color intensity = average engagement rate for posts published in that slot
- Helps identify optimal posting windows
- Based on `published_at` from posts table correlated with engagement metrics

**4. Followers**
- Follower growth line chart over time
- Net new followers per day/week (computed via window function)
- Profile views trend
- Search appearances trend
- Post publish dates overlaid as markers on the chart so you can visually correlate growth spikes

**Alert Banner:**
- Displayed at top of dashboard when any data source has recent sync errors
- Shows which sources are broken and since when
- Links to scrape_log details

## Data Collection Strategy

**On first install (backfill):**
1. User installs extension, starts local server (`npm start`)
2. Extension detects first visit to LinkedIn, resolves user identity, triggers backfill
3. Fetches post history via Voyager API in batches of 25, up to 50 posts for v1
4. Records initial metrics snapshot for each post
5. Grabs current follower count and profile views
6. Backfill progress (last cursor/offset) stored in `chrome.storage.local` — if interrupted, resumes from last completed batch on next alarm

**Server startup:** The user must manually start the server with `npm start`. For convenience, provide a `start.sh` script. Auto-start on login (via launchd on macOS) is a future consideration, not v1.

**Ongoing daily sync:**
1. `chrome.alarms` fires every 30 minutes
2. Service worker checks `localhost:3210/api/health` for last sync time
3. If 24+ hours since last sync AND user has a linkedin.com tab open, triggers active sync
4. Active syncer fetches recent posts (last 50), per-post metrics, followers, profile views
5. POSTs everything to local server via `/api/ingest`
6. Server deduplicates and appends snapshots
7. If user skips days, next visit catches up automatically

**Anti-detection measures:**
- All requests use the user's real browser session, cookies, and IP — indistinguishable from normal browsing
- Human-like pacing: 1-3 second random delays between API calls during active sync
- No headless browsers, no proxy rotation, no fingerprint spoofing needed
- Daily frequency is low enough to stay well under any rate limits

## Error Handling and Resilience

**Schema validation (Zod):**
- Every Voyager API response validated against expected schema before processing
- If validation fails, response logged with full details and that data source marked as broken
- Other data sources continue working independently

**Per-source health tracking:**
- `scrape_log` tracks success/failure independently for: posts, followers, profile_views
- Extension popup shows per-source status
- Dashboard alert banner shows broken sources with timestamps

**Graceful degradation:**
- If the local server is unreachable, extension queues data in `chrome.storage.local` (10MB total quota shared with other extension data — cap queue at 5MB, drop oldest if full) and retries next sync
- If a Voyager endpoint changes, only that data source breaks — everything else keeps working
- If the user's LinkedIn session expires, extension detects auth errors and shows "Please log in to LinkedIn" in the popup

## Tech Stack Summary

| Component | Technology |
|-----------|-----------|
| Extension | Chrome Manifest V3, TypeScript |
| Server | Node.js, Fastify, better-sqlite3 |
| Dashboard | React, Chart.js, TailwindCSS |
| Build | Vite (separate configs for extension and dashboard) |
| Validation | Zod (Voyager API response schemas + ingest request schema) |
| Database | SQLite (file on disk, WAL mode) |

## Project Structure

```
linkedin-analytics/
├── extension/              # Chrome extension source
│   ├── manifest.json
│   ├── src/
│   │   ├── content/        # Content script (Voyager API calls, relays data to service worker)
│   │   ├── background/     # Service worker (alarms, sync orchestration, localhost POST)
│   │   ├── popup/          # Extension popup UI
│   │   └── shared/         # Types, Voyager API client, Zod schemas
│   └── vite.config.ts
├── server/                 # Local Node server
│   ├── src/
│   │   ├── routes/         # Fastify route handlers
│   │   ├── db/
│   │   │   ├── schema.sql  # Initial schema
│   │   │   ├── migrations/ # Sequential .sql migration files
│   │   │   └── queries.ts  # Prepared query functions
│   │   └── index.ts        # Server entry point (CORS, static files, DB init)
│   └── package.json
├── dashboard/              # React dashboard
│   ├── src/
│   │   ├── components/     # Charts, tables, layout
│   │   ├── pages/          # Overview, Posts, Timing, Followers
│   │   └── api/            # Client-side API calls to local server
│   └── vite.config.ts
├── data/                   # SQLite database lives here (gitignored)
│   └── .gitkeep
├── docs/
│   └── voyager-endpoints.md  # Discovered API endpoints from spike
├── package.json            # Root workspace
└── README.md
```

## Future Considerations (not in scope now)

- **Passive fetch interception** — monkey-patch `window.fetch` via MAIN world content script to capture Voyager API responses as user browses LinkedIn. Requires two-script relay architecture (MAIN world → ISOLATED world → service worker). Adds fresher data between daily syncs.
- Deploy server to Railway/Fly.io for remote access
- Swap SQLite for Postgres if data volume warrants it
- LinkedIn official API integration (OAuth) as a more stable alternative to Voyager
- Comment text scraping for sentiment/quality analysis
- Export to CSV/Google Sheets
- Email/Slack digest notifications
- Post comparison side-by-side view
- Automated follower spike → post correlation
