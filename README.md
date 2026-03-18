# LinkedIn Analytics

A local-first LinkedIn analytics platform. A Chrome extension collects your post performance data via DOM scraping, stores it in a local SQLite database, and serves a dashboard with charts, insights, and AI-powered coaching.

No subscriptions. No third-party data sharing. Your data stays on your machine.

## Architecture

```
Chrome Extension (Manifest V3)
    ↓ POST to localhost:3210/api/ingest
Local Node Server (Fastify + better-sqlite3)
    ↓ reads/writes
SQLite Database (data/linkedin.db)
    ↓ serves
React Dashboard (Tailwind CSS + Chart.js)
```

## Prerequisites

- **Node.js** >= 20
- **npm** (comes with Node)
- **Chrome** or Chromium-based browser
- **OpenRouter API key** (optional, for AI Coach features)

## Quick Start

### 1. Install dependencies

```bash
npm install
```

This installs all three workspaces (server, dashboard, extension).

### 2. Build the dashboard

```bash
npm run build:dashboard
```

The server serves the built dashboard as static files.

### 3. Start the server

```bash
npm start
```

The server starts on **http://localhost:3210**. On first run, it creates the SQLite database at `data/linkedin.db` and runs all migrations automatically.

### 4. Install the Chrome extension

1. Build the extension:
   ```bash
   npm run build:extension
   ```
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked**
5. Select the `extension/dist/` directory
6. Pin the extension to your toolbar

### 5. Run the initial data collection

1. Make sure the server is running (`npm start`)
2. Open LinkedIn in Chrome and navigate to your analytics page:
   - Go to **linkedin.com** → Click your profile → **Analytics & tools** → **Post impressions**
3. The extension will automatically detect the analytics pages and begin scraping
4. You can also click the extension icon and hit **Sync Now** to trigger a manual collection
5. The extension collects: post metrics, follower counts, profile views, and search appearances

The first sync may take a minute as it walks through your posts. Subsequent syncs run automatically every 24 hours when Chrome is open with the extension active.

### 6. Open the dashboard

Go to **http://localhost:3210** in your browser. You should see your posts and metrics populating.

## AI Coach (Optional)

The AI Coach analyzes your posting patterns and generates actionable recommendations. To enable it:

1. Get an API key from [OpenRouter](https://openrouter.ai/keys)
2. Create a `.env` file in the project root:
   ```
   TRUSTMIND_LLM_API_KEY=sk-or-...
   ```
3. Restart the server
4. Go to the **Coach** tab in the dashboard and click **Refresh AI**

The AI pipeline classifies your posts by content type, identifies patterns in your engagement data, and generates recommendations with specific next actions.

## Development

```bash
# Run server in watch mode (auto-restarts on changes)
npm run dev

# Run dashboard dev server (hot reload on port 5173, proxies API to 3210)
cd dashboard && npm run dev

# Run tests
npm test
```

## Project Structure

```
├── server/           # Fastify API server
│   ├── src/
│   │   ├── ai/       # AI analysis pipeline (Anthropic Claude)
│   │   ├── db/       # SQLite schema, migrations, queries
│   │   ├── routes/   # API endpoints
│   │   └── index.ts  # Server entrypoint
│   └── package.json
├── dashboard/        # React frontend (Vite + Tailwind)
│   ├── src/
│   │   ├── pages/    # Overview, Posts, Coach, Timing, Followers, Settings
│   │   ├── api/      # API client with TypeScript types
│   │   └── index.css # Design tokens and theme
│   └── package.json
├── extension/        # Chrome extension (Manifest V3)
│   ├── src/
│   │   ├── background/  # Service worker with alarm scheduling
│   │   ├── content/     # DOM scraper for LinkedIn analytics
│   │   └── popup/       # Extension popup UI
│   └── manifest.json
├── data/             # SQLite database (gitignored)
└── docs/             # Design specs and research
```

## Backfilling Post Content

After the initial sync, some posts may show "Content pending" — this means the extension has captured their metrics but hasn't scraped the full text and images yet. To backfill:

1. Keep the server running
2. Browse LinkedIn normally with the extension active
3. The extension will automatically backfill post content as you visit LinkedIn

You can check the backfill status on the **Posts** page — a banner will show how many posts still need content.
