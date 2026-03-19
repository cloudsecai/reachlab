import type {
  ScrapedPost,
  ScrapedPostMetrics,
  ContentMessage,
} from "../shared/types.js";
import { activityIdToDate } from "../shared/utils.js";

const SERVER_URL = "http://localhost:3210";
const ALARM_NAME = "daily-sync";
const ALARM_PERIOD_MINUTES = 30;
const SYNC_HOURS = [9, 21]; // 9 AM and 9 PM local time
const SYNC_WINDOW_MS = 45 * 60 * 1000; // 45-minute window after target hour
const LIGHT_SYNC_RECENT_POSTS = 5; // Evening sync: only scrape metrics for this many recent posts
const BATCH_SIZE = 25;
const PACING_MIN_MS = 1000;
const PACING_MAX_MS = 3000;
const BACKFILL_PACING_MIN_MS = 2000;
const BACKFILL_PACING_MAX_MS = 5000;
const METRIC_DECAY_DAYS = 30;
const OFFLINE_QUEUE_MAX_BYTES = 5 * 1024 * 1024; // 5MB cap

// Re-register alarm on every service worker start
chrome.alarms.get(ALARM_NAME, (alarm) => {
  if (!alarm) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
  }
});

// Passively capture DASH video playlist URLs from LinkedIn video loads.
// Content scripts can't see performance entries (isolated world), so we
// intercept at the network level instead.
chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0) return; // background request, skip
    // Only capture the DASH manifest URL, not individual HLS segments.
    // Manifest: /playlist/vid/dash/<id>/<hash>?...
    // Segments: /playlist/vid/v2/<id>/hls-720p-quality-analysis/.../15/...
    if (!details.url.includes("/playlist/vid/dash/")) return;
    // Get the tab URL to find the post activity ID
    chrome.tabs.get(details.tabId, (tab) => {
      if (chrome.runtime.lastError || !tab?.url) return;
      const match = tab.url.match(/activity[:-](\d+)/);
      if (!match) return;
      const postId = match[1];
      const videoUrl = details.url;
      // Fire-and-forget POST to server
      fetch(`${SERVER_URL}/api/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          posts: [{ id: postId, video_url: videoUrl }],
        }),
      }).catch(() => {});
    });
  },
  { urls: ["*://dms.licdn.com/playlist/vid/*"] }
);

// Also try to drain offline queue on worker start
drainOfflineQueue();

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    await drainOfflineQueue();
    await trySync();
  } else if (alarm.name === "sync-continue") {
    await continueSyncBatch();
  } else if (alarm.name === "backfill-continue") {
    await continueBackfill();
  }
});

// Manual sync from popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "trigger-sync") {
    trySync(true).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === "get-sync-status") {
    getSyncStatus().then((status) => sendResponse(status));
    return true;
  }
});

async function getSyncStatus() {
  const { syncInProgress } = await chrome.storage.session.get("syncInProgress");
  // Read last sync time from server (survives extension reinstalls)
  let lastSyncAt: number | null = null;
  try {
    const res = await fetch(`${SERVER_URL}/api/sync-state`);
    if (res.ok) {
      const data = await res.json();
      lastSyncAt = data.last_sync_at ?? null;
    }
  } catch {}
  return {
    lastSyncAt,
    syncInProgress: syncInProgress ?? false,
  };
}

function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Offline queue ---

async function queueForRetry(payload: Record<string, unknown>) {
  const { offlineQueue = [] } = await chrome.storage.local.get("offlineQueue");
  offlineQueue.push(payload);

  // Enforce 5MB cap — drop oldest entries if over
  let serialized = JSON.stringify(offlineQueue);
  while (serialized.length > OFFLINE_QUEUE_MAX_BYTES && offlineQueue.length > 1) {
    offlineQueue.shift();
    serialized = JSON.stringify(offlineQueue);
  }

  await chrome.storage.local.set({ offlineQueue });
}

async function drainOfflineQueue() {
  const { offlineQueue = [] } = await chrome.storage.local.get("offlineQueue");
  if (offlineQueue.length === 0) return;

  const remaining: Record<string, unknown>[] = [];
  for (const payload of offlineQueue) {
    try {
      await postToServerDirect(payload);
    } catch {
      remaining.push(payload);
      break; // Server still down, stop trying
    }
  }

  // Keep unsent items plus any we didn't attempt
  const idx = offlineQueue.indexOf(remaining[0]);
  const kept = idx >= 0 ? offlineQueue.slice(idx) : [];
  await chrome.storage.local.set({ offlineQueue: kept });
}

// --- Sync orchestration ---

async function trySync(manual = false) {
  // Check if already syncing or backfilling
  const { syncInProgress, backfillQueue } = await chrome.storage.session.get([
    "syncInProgress",
    "backfillQueue",
  ]);
  if (syncInProgress) return;
  if (backfillQueue) return; // Backfill still running, skip sync

  if (!manual) {
    // Only sync during configured time windows (e.g. 9 AM, 9 PM)
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const inSyncWindow = SYNC_HOURS.some((h) => {
      if (currentHour === h) return true;
      // Allow spilling into the next hour if within the window
      if (currentHour === (h + 1) % 24 && currentMinute <= 15) return true;
      return false;
    });
    if (!inSyncWindow) return;

    // Check if we already synced during this window
    try {
      const res = await fetch(`${SERVER_URL}/api/sync-state`);
      if (res.ok) {
        const data = await res.json();
        // Skip if synced within the last 6 hours (prevents double-sync in same window)
        if (data.last_sync_at && Date.now() - data.last_sync_at < 6 * 60 * 60 * 1000) return;
      }
    } catch {}
  }

  // Check server health
  try {
    const res = await fetch(`${SERVER_URL}/api/health`);
    if (!res.ok) return;
  } catch {
    return; // Server not running
  }

  await startSync();
}

async function startSync() {
  // Determine sync type: backfill (first ever), light (evening), or full (morning)
  let isBackfill = true;
  try {
    const res = await fetch(`${SERVER_URL}/api/sync-state`);
    if (res.ok) {
      const data = await res.json();
      isBackfill = !data.last_sync_at;
    }
  } catch {}

  // Evening sync (9 PM window) = light sync — just discover new posts + recent metrics
  const currentHour = new Date().getHours();
  const isLightSync = !isBackfill && (currentHour >= 20 || currentHour <= 1);

  await chrome.storage.session.set({
    syncInProgress: true,
    syncBatchCursor: 0,
    syncPosts: [],
    isBackfill,
    isLightSync,
  });

  try {
    // Create background tab
    const tab = await chrome.tabs.create({
      active: false,
      url: isBackfill
        ? "https://www.linkedin.com/analytics/creator/top-posts?timeRange=past_365_days&metricType=IMPRESSIONS"
        : "https://www.linkedin.com/analytics/creator/top-posts?metricType=IMPRESSIONS&timeRange=past_28_days",
    });

    if (!tab.id) throw new Error("Failed to create background tab");

    await chrome.storage.session.set({
      syncTabId: tab.id,
      isBackfill,
    });

    // Wait for page load then scrape
    await waitForTabLoad(tab.id);
    await randomDelay(PACING_MIN_MS, PACING_MAX_MS);

    const topPostsResult = await sendScrapeCommand(tab.id);

    if (topPostsResult.type === "top-posts") {
      const posts = topPostsResult.data as ScrapedPost[];

      // POST posts to server (with offline queue fallback)
      // Include thumbnail URLs as image_urls so the server can download them
      // The response tells us what still needs scraping (no extra API calls needed)
      const ingestResult = await postToServer({
        posts: posts.map((p) => ({
          id: p.id,
          content_preview: p.content_preview ?? undefined,
          content_type: p.content_type,
          published_at: p.published_at,
          url: p.url,
          image_urls: p.thumbnail_url ? [p.thumbnail_url] : undefined,
        })),
      });

      // Scrape post pages for content + images (merged, using ingest response)
      try {
        const needsContentIds: string[] = ingestResult?.needs_content ?? [];
        const needsImageIds: string[] = ingestResult?.needs_images ?? [];
        const currentPostIds = new Set(posts.map((p: ScrapedPost) => p.id));
        const toScrape = [...new Set([...needsContentIds, ...needsImageIds])].filter(
          (id: string) => currentPostIds.has(id)
        );
        if (toScrape.length > 0) {
          await scrapePostPages(tab.id!, toScrape, isBackfill);
        }
      } catch (err: any) {
        console.error(
          "[ReachLab] Post page scraping failed:",
          err.message
        );
        // Non-fatal — continue with detail metrics
      }

      // Filter posts for detail scraping:
      // - Backfill: scrape all posts
      // - Light sync (evening): only the most recent N posts
      // - Full sync (morning): posts <30 days old, skip those with recent metrics
      const recentMetricsSet = new Set<string>(ingestResult?.has_recent_metrics ?? []);
      let postIdsToScrape: string[];
      if (isBackfill) {
        postIdsToScrape = posts.map((p) => p.id);
      } else if (isLightSync) {
        // Evening: just get updated stats for the most recent posts
        postIdsToScrape = posts
          .slice(0, LIGHT_SYNC_RECENT_POSTS)
          .map((p) => p.id);
      } else {
        postIdsToScrape = posts
            .filter((p) => {
              const publishedDate = activityIdToDate(p.id);
              const ageMs = Date.now() - publishedDate.getTime();
              if (ageMs >= METRIC_DECAY_DAYS * 24 * 60 * 60 * 1000) return false;
              if (recentMetricsSet.has(p.id)) return false;
              return true;
            })
            .map((p) => p.id);
      }

      // Store posts for batch detail scraping
      await chrome.storage.session.set({
        syncPosts: postIdsToScrape,
        syncBatchCursor: 0,
      });

      if (postIdsToScrape.length === 0) {
        // No detail pages to scrape, go straight to remaining pages
        await scrapeRemainingPages(tab.id);
      } else {
        await processBatch(tab.id, postIdsToScrape, 0, isBackfill);
      }
    } else {
      await finishSyncWithError("Failed to scrape top posts page");
    }
  } catch (err: any) {
    await finishSyncWithError(err.message);
  }
}

async function continueSyncBatch() {
  const { syncTabId, syncPosts, syncBatchCursor, isBackfill } =
    await chrome.storage.session.get([
      "syncTabId",
      "syncPosts",
      "syncBatchCursor",
      "isBackfill",
    ]);

  if (!syncTabId || !syncPosts) {
    await finishSyncWithError("Lost sync state");
    return;
  }

  await processBatch(syncTabId, syncPosts, syncBatchCursor, isBackfill);
}

async function processBatch(
  tabId: number,
  postIds: string[],
  cursor: number,
  isBackfill: boolean
) {
  const pacingMin = isBackfill ? BACKFILL_PACING_MIN_MS : PACING_MIN_MS;
  const pacingMax = isBackfill ? BACKFILL_PACING_MAX_MS : PACING_MAX_MS;
  const batchEnd = Math.min(cursor + BATCH_SIZE, postIds.length);
  const metricsToSend: Array<{ post_id: string } & ScrapedPostMetrics> = [];

  try {
    for (let i = cursor; i < batchEnd; i++) {
      const postId = postIds[i];
      const detailUrl = `https://www.linkedin.com/analytics/post-summary/urn:li:activity:${postId}/`;

      await chrome.tabs.update(tabId, { url: detailUrl });
      await waitForTabLoad(tabId);
      await randomDelay(pacingMin, pacingMax);

      const result = await sendScrapeCommand(tabId);

      if (result.type === "post-detail") {
        metricsToSend.push({
          post_id: postId,
          ...result.data,
        });
      }
    }

    // POST batch metrics to server (with offline queue fallback)
    if (metricsToSend.length > 0) {
      await postToServer({ post_metrics: metricsToSend });
    }

    // Update cursor
    await chrome.storage.session.set({ syncBatchCursor: batchEnd });

    if (batchEnd < postIds.length) {
      // More batches — schedule continuation
      chrome.alarms.create("sync-continue", { delayInMinutes: 0.05 }); // ~3 seconds
    } else {
      // All detail pages done — now scrape audience/profile/search pages
      await scrapeRemainingPages(tabId);
    }
  } catch (err: any) {
    // Save partial progress via offline queue
    if (metricsToSend.length > 0) {
      await queueForRetry({ post_metrics: metricsToSend });
    }
    await finishSyncWithError(err.message);
  }
}

interface ScrapedContent {
  id: string;
  hook_text: string | null;
  full_text: string | null;
  image_urls: string[];
  video_url?: string | null;
}

/**
 * Two-phase scrape: captures hook_text before expansion, full_text after.
 * Returns scraped data without sending to server (caller batches sends).
 */
async function scrapePostContent(
  tabId: number,
  postId: string,
): Promise<ScrapedContent> {
  const postUrl = `https://www.linkedin.com/feed/update/urn:li:activity:${postId}/`;
  await chrome.tabs.update(tabId, { url: postUrl });
  await waitForTabLoad(tabId);
  // Brief delay to ensure content script is injected on the new page
  await new Promise((r) => setTimeout(r, 500));

  // Phase 1: Scrape BEFORE "see more" click — captures hook_text (truncated view)
  let hookResult = await sendScrapeCommand(tabId);

  // Retry once if the scrape missed (e.g. content script saw stale page)
  if (hookResult.type !== "post-content") {
    await new Promise((r) => setTimeout(r, 2000));
    hookResult = await sendScrapeCommand(tabId);
  }

  let hookText: string | null = null;
  let imageUrls: string[] = [];
  let videoUrl: string | null = null;

  if (hookResult.type === "post-content") {
    hookText = hookResult.data.hook_text;
    imageUrls = hookResult.data.image_urls;
    videoUrl = hookResult.data.video_url ?? null;
  } else {
    console.warn(
      `[ReachLab] Post content scrape returned ${hookResult.type} for ${postId}:`,
      "error" in hookResult ? hookResult.error : "unknown"
    );
  }

  // Phase 2: Click "see more" if present, then re-scrape for full_text
  let fullText: string | null = hookText; // default to hook if no expansion
  try {
    const [clickResult] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const seeMore = document.querySelector(
          ".feed-shared-inline-show-more-text__see-more-less-toggle"
        ) as HTMLElement | null;
        if (seeMore) {
          seeMore.click();
          return true;
        }
        return false;
      },
    });

    if (clickResult?.result) {
      // Poll for text expansion (up to 3s) instead of fixed wait
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () =>
          new Promise<void>((resolve) => {
            const start = Date.now();
            const check = () => {
              const btn = document.querySelector(
                ".feed-shared-inline-show-more-text__see-more-less-toggle"
              );
              if (!btn || Date.now() - start > 3000) resolve();
              else setTimeout(check, 200);
            };
            check();
          }),
      });
      const fullResult = await sendScrapeCommand(tabId);
      if (fullResult.type === "post-content") {
        fullText = fullResult.data.full_text;
      }
    }
  } catch {
    // No see more button or script injection failed — continue with hook as full
  }

  return { id: postId, hook_text: hookText, full_text: fullText, image_urls: imageUrls, video_url: videoUrl };
}

/**
 * Scrape and send: single post convenience wrapper (used by backfill).
 */
async function scrapeAndSendPostContent(
  tabId: number,
  postId: string,
): Promise<void> {
  const content = await scrapePostContent(tabId, postId);
  await postToServer({
    posts: [content],
  });
}

const CONTENT_BATCH_SIZE = 10;

async function scrapePostPages(
  tabId: number,
  postIds: string[],
  isBackfill: boolean
): Promise<void> {
  const pacingMin = isBackfill ? BACKFILL_PACING_MIN_MS : PACING_MIN_MS;
  const pacingMax = isBackfill ? BACKFILL_PACING_MAX_MS : PACING_MAX_MS;
  const batch: ScrapedContent[] = [];

  for (const postId of postIds) {
    await randomDelay(pacingMin, pacingMax);
    try {
      const content = await scrapePostContent(tabId, postId);
      batch.push(content);

      // Flush batch when full
      if (batch.length >= CONTENT_BATCH_SIZE) {
        await postToServer({ posts: [...batch] });
        batch.length = 0;
      }
    } catch (err: any) {
      console.error(
        `[ReachLab] Failed to scrape content for ${postId}:`,
        err.message
      );
    }
  }

  // Flush remaining
  if (batch.length > 0) {
    await postToServer({ posts: batch });
  }
}

async function scrapeRemainingPages(tabId: number) {
  const { isBackfill, isLightSync } = await chrome.storage.session.get(["isBackfill", "isLightSync"]);

  // Light sync skips audience/profile/search — just finish
  if (isLightSync) {
    await finishSync();
    return;
  }

  const pacingMin = isBackfill ? BACKFILL_PACING_MIN_MS : PACING_MIN_MS;
  const pacingMax = isBackfill ? BACKFILL_PACING_MAX_MS : PACING_MAX_MS;

  try {
    // Audience page (followers)
    await chrome.tabs.update(tabId, {
      url: "https://www.linkedin.com/analytics/creator/audience",
    });
    await waitForTabLoad(tabId);
    await randomDelay(pacingMin, pacingMax);
    const audienceResult = await sendScrapeCommand(tabId);
    if (
      audienceResult.type === "audience" &&
      audienceResult.data.total_followers != null
    ) {
      await postToServer({
        followers: { total_followers: audienceResult.data.total_followers },
      });
    }

    // Try to scrape profile photo from this page
    await scrapeAndSendProfilePhoto(tabId);

    // Profile views page
    await chrome.tabs.update(tabId, {
      url: "https://www.linkedin.com/analytics/profile-views/",
    });
    await waitForTabLoad(tabId);
    await randomDelay(pacingMin, pacingMax);
    const profileResult = await sendScrapeCommand(tabId);

    // Search appearances page
    await chrome.tabs.update(tabId, {
      url: "https://www.linkedin.com/analytics/search-appearances/",
    });
    await waitForTabLoad(tabId);
    await randomDelay(pacingMin, pacingMax);
    const searchResult = await sendScrapeCommand(tabId);

    // Combine profile data
    const profileData: Record<string, number | undefined> = {};
    if (profileResult.type === "profile-views") {
      profileData.profile_views =
        profileResult.data.profile_views ?? undefined;
    }
    if (searchResult.type === "search-appearances") {
      profileData.all_appearances =
        searchResult.data.all_appearances ?? undefined;
      profileData.search_appearances =
        searchResult.data.search_appearances ?? undefined;
    }
    if (Object.keys(profileData).length > 0) {
      await postToServer({ profile: profileData });
    }

    await finishSync();
  } catch (err: any) {
    await finishSyncWithError(err.message);
  }
}

/**
 * Scrape the user's profile photo from the current LinkedIn page and send to server.
 */
async function scrapeAndSendProfilePhoto(tabId: number): Promise<void> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // Look for the profile photo in the global nav or page elements
        const selectors = [
          ".global-nav__me-photo",
          "img.feed-identity-module__member-photo",
          "img.member-analytics-addon__member-photo",
          ".global-nav__primary-link-me-menu-trigger img",
          "img.nav-item__profile-member-photo",
        ];
        for (const sel of selectors) {
          const img = document.querySelector(sel) as HTMLImageElement | null;
          if (img?.src && img.src.includes("media.licdn.com")) {
            return img.src;
          }
        }
        return null;
      },
    });

    if (result?.result) {
      await postToServer({ author_photo_url: result.result });
    }
  } catch {
    // Non-fatal — profile photo scraping is best-effort
  }
}

async function continueBackfill() {
  const { backfillQueue, backfillCursor = 0 } = await chrome.storage.session.get([
    "backfillQueue",
    "backfillCursor",
  ]);
  if (!backfillQueue || backfillCursor >= backfillQueue.length) {
    await chrome.storage.session.set({ backfillQueue: null, backfillCursor: null });
    return;
  }

  const tab = await chrome.tabs.create({ active: false, url: "about:blank" });
  if (!tab.id) return;

  const batchEnd = Math.min(backfillCursor + 5, backfillQueue.length);

  try {
    for (let i = backfillCursor; i < batchEnd; i++) {
      const postId = backfillQueue[i];
      await randomDelay(BACKFILL_PACING_MIN_MS, BACKFILL_PACING_MAX_MS);
      try {
        await scrapeAndSendPostContent(tab.id, postId);
      } catch (err: any) {
        console.error(`[ReachLab] Backfill failed for ${postId}:`, err.message);
      }
    }

    await chrome.storage.session.set({ backfillCursor: batchEnd });

    if (batchEnd < backfillQueue.length) {
      chrome.alarms.create("backfill-continue", { delayInMinutes: 0.1 });
    } else {
      await chrome.storage.session.set({ backfillQueue: null, backfillCursor: null });
    }
  } catch (err: any) {
    console.error("[ReachLab] Backfill error:", err.message);
    await chrome.storage.session.set({ backfillQueue: null, backfillCursor: null });
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch {}
  }
}

async function finishSync() {
  const { syncTabId } = await chrome.storage.session.get("syncTabId");
  if (syncTabId) {
    try {
      await chrome.tabs.remove(syncTabId);
    } catch {}
  }

  // Check for posts needing content or image backfill
  try {
    const [contentRes, imagesRes, videoRes] = await Promise.all([
      fetch(`${SERVER_URL}/api/posts/needs-content`),
      fetch(`${SERVER_URL}/api/posts/needs-images`),
      fetch(`${SERVER_URL}/api/posts/needs-video-url`),
    ]);
    const contentIds = contentRes.ok ? (await contentRes.json()).post_ids : [];
    const imageIds = imagesRes.ok ? (await imagesRes.json()).post_ids : [];
    const videoIds = videoRes.ok ? (await videoRes.json()).post_ids : [];
    // Deduplicate
    const allIds = [...new Set([...contentIds, ...imageIds, ...videoIds])];
    if (allIds.length > 0) {
      await chrome.storage.session.set({
        backfillQueue: allIds,
        backfillCursor: 0,
      });
      chrome.alarms.create("backfill-continue", { delayInMinutes: 0.1 });
    }
  } catch {
    // Non-fatal — backfill will happen next sync
  }

  // Persist sync timestamp server-side (survives extension reinstalls)
  try {
    await fetch(`${SERVER_URL}/api/sync-state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ last_sync_at: Date.now() }),
    });
  } catch {}
  await chrome.storage.session.set({
    syncInProgress: false,
    syncTabId: null,
    syncPosts: null,
    syncBatchCursor: null,
  });
}

async function finishSyncWithError(error: string) {
  console.error("[ReachLab] Sync error:", error);
  const { syncTabId } = await chrome.storage.session.get("syncTabId");
  if (syncTabId) {
    try {
      await chrome.tabs.remove(syncTabId);
    } catch {}
  }

  await chrome.storage.session.set({
    syncInProgress: false,
    syncTabId: null,
    syncError: error,
  });
}

function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Tab load timeout"));
    }, 30000);

    // Track whether we've seen a loading state first to avoid resolving
    // on a stale "complete" from the previous page.
    let sawLoading = false;

    function listener(
      updatedTabId: number,
      changeInfo: chrome.tabs.TabChangeInfo
    ) {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === "loading") sawLoading = true;
      if (changeInfo.status === "complete" && sawLoading) {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function sendScrapeCommand(tabId: number): Promise<ContentMessage> {
  // Content script may not be ready immediately after tab load.
  // Retry a few times with short delays.
  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 1000;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await new Promise<ContentMessage>((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, { type: "scrape-page" }, (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(res as ContentMessage);
          }
        });
      });
      return response;
    } catch (err: any) {
      if (
        attempt < MAX_RETRIES - 1 &&
        err.message?.includes("Receiving end does not exist")
      ) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      throw err;
    }
  }

  throw new Error("Content script not responding after retries");
}

/** POST to server directly — throws on failure */
async function postToServerDirect(payload: Record<string, unknown>) {
  const response = await fetch(`${SERVER_URL}/api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Server ingest failed (${response.status}): ${text}`);
  }

  return response.json();
}

/** POST to server with offline queue fallback */
async function postToServer(payload: Record<string, unknown>) {
  try {
    return await postToServerDirect(payload);
  } catch (err) {
    await queueForRetry(payload);
    throw err;
  }
}
