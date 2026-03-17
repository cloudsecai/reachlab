# LinkedIn Analytics — Implementation Plan

Repo: https://github.com/cloudsecai/linkedin-analytics (private)

## Phase 0: Voyager API Discovery Spike (MANUAL — do before giving to agent)

This must be done by a human in a real browser:

1. Open Chrome DevTools Network tab, navigate to your LinkedIn analytics pages
2. Filter for `/voyager/api/` requests
3. Document endpoints, params, and response shapes for: post listing, post metrics, follower count, profile views
4. Save findings to `docs/voyager-endpoints.md` in the repo
5. Create initial Zod schemas from actual response shapes

**This blocks everything else.** The agent cannot discover these endpoints — they require a real authenticated LinkedIn session.

## Phase 1: Project Scaffolding

1. Clone repo, init npm workspace with three packages: `extension/`, `server/`, `dashboard/`
2. Set up TypeScript config (root `tsconfig.json` + per-package)
3. Set up Vite configs (separate for extension and dashboard)
4. Create `extension/manifest.json` with required permissions
5. Create `data/.gitkeep`, add `data/*.db` to `.gitignore`
6. Add `.superpowers/` to `.gitignore`
7. Create `start.sh` convenience script

## Phase 2: Local Server + Database

1. Set up Fastify server in `server/src/index.ts`
2. Implement SQLite schema initialization with WAL mode (`server/src/db/schema.sql`)
3. Implement migration runner (`schema_version` table + sequential `.sql` files)
4. Implement `POST /api/ingest` with Zod validation
5. Implement `GET /api/health`
6. Implement `GET /api/posts` with filtering, sorting, pagination
7. Implement `GET /api/metrics/:postId`
8. Implement `GET /api/overview` (KPI aggregates)
9. Implement `GET /api/timing` (day/hour heatmap data)
10. Implement `GET /api/followers`
11. Implement `GET /api/profile`
12. Configure CORS for `chrome-extension://` origins
13. Write tests for ingest deduplication logic and query endpoints

## Phase 3: Chrome Extension — Core

1. Create manifest.json with all permissions
2. Build service worker (`background/`):
   - `chrome.alarms` registration (re-register on every worker start)
   - Alarm handler: check health endpoint, determine if sync needed
   - Message listener for content script relay
   - POST to localhost `/api/ingest`
   - Sync state management (`chrome.storage.local` for timestamps, `chrome.storage.session` for transient state)
3. Build content script (`content/`):
   - Voyager API client (fetch calls using discovered endpoints from Phase 0)
   - User identity resolution (`/voyager/api/me`)
   - Post list fetcher (batched, 25 at a time)
   - Metrics fetcher per post
   - Follower count fetcher
   - Profile views fetcher
   - Zod schema validation on every response
   - Relay collected data to service worker via `chrome.runtime.sendMessage`
4. Handle SPA navigation via `chrome.webNavigation.onHistoryStateUpdated`
5. Implement sync chunking (batches of 25, follow-up alarms)
6. Implement offline queue in `chrome.storage.local` with 5MB cap

## Phase 4: Extension Popup

1. Simple HTML/CSS popup (no framework needed — it's tiny)
2. Display last sync time
3. Display per-source health status
4. "Sync Now" button
5. "Open Dashboard" button
6. Auth status indicator

## Phase 5: Dashboard

1. Set up React + TailwindCSS + Chart.js in `dashboard/`
2. Build layout: dark theme, top nav with tab switching, date range selector
3. **Overview tab:**
   - KPI cards with period comparison
   - Impressions over time bar chart
   - Engagement by content type horizontal bars
   - Recent posts sortable table
4. **Posts tab:**
   - Full sortable/filterable post table
   - Post detail view with metric history chart (impression velocity)
5. **Timing tab:**
   - Day-of-week × hour-of-day heatmap
6. **Followers tab:**
   - Follower growth line chart
   - Net new followers per period
   - Profile views + search appearances trends
   - Post publish date markers overlaid
7. Alert banner for sync errors
8. Configure Fastify to serve dashboard build as static files

## Phase 6: Integration Testing + Polish

1. End-to-end test: extension → server → database → dashboard
2. Verify sync chunking and worker restart recovery
3. Test offline queue behavior (server down → server back up)
4. Test error scenarios (bad API responses, expired session)
5. Write README with setup instructions
