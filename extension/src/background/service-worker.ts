import type {
  ScrapedPost,
  ScrapedPostMetrics,
  ContentMessage,
} from "../shared/types.js";
import { activityIdToDate } from "../shared/utils.js";

const SERVER_URL = "http://localhost:3210";
const ALARM_NAME = "daily-sync";
const ALARM_PERIOD_MINUTES = 30;
const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
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
  const { lastSyncAt } = await chrome.storage.local.get("lastSyncAt");
  const { syncInProgress } = await chrome.storage.session.get("syncInProgress");
  return {
    lastSyncAt: lastSyncAt ?? null,
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
    // Check if sync needed
    const { lastSyncAt } = await chrome.storage.local.get("lastSyncAt");
    if (lastSyncAt && Date.now() - lastSyncAt < SYNC_INTERVAL_MS) return;

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
  await chrome.storage.session.set({
    syncInProgress: true,
    syncBatchCursor: 0,
    syncPosts: [],
    isBackfill: false,
  });

  // Check if this is the first sync (backfill)
  const { lastSyncAt } = await chrome.storage.local.get("lastSyncAt");
  const isBackfill = !lastSyncAt;

  try {
    // Create background tab
    const tab = await chrome.tabs.create({
      active: false,
      url: isBackfill
        ? "https://www.linkedin.com/analytics/creator/top-posts?timeRange=past_365_days&metricType=IMPRESSIONS"
        : "https://www.linkedin.com/analytics/creator/top-posts?timeRange=past_30_days&metricType=IMPRESSIONS",
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
          "[LinkedIn Analytics] Post page scraping failed:",
          err.message
        );
        // Non-fatal — continue with detail metrics
      }

      // Filter posts for detail scraping:
      // - Backfill: scrape all posts
      // - Daily sync: only posts <30 days old, skip those with recent metrics
      const recentMetricsSet = new Set<string>(ingestResult?.has_recent_metrics ?? []);
      const postIdsToScrape = isBackfill
        ? posts.map((p) => p.id)
        : posts
            .filter((p) => {
              const publishedDate = activityIdToDate(p.id);
              const ageMs = Date.now() - publishedDate.getTime();
              if (ageMs >= METRIC_DECAY_DAYS * 24 * 60 * 60 * 1000) return false;
              // Skip posts that already have recent metrics
              if (recentMetricsSet.has(p.id)) return false;
              return true;
            })
            .map((p) => p.id);

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

  // Phase 1: Scrape BEFORE "see more" click — captures hook_text (truncated view)
  const hookResult = await sendScrapeCommand(tabId);
  let hookText: string | null = null;
  let imageUrls: string[] = [];
  let videoUrl: string | null = null;

  if (hookResult.type === "post-content") {
    hookText = hookResult.data.hook_text;
    imageUrls = hookResult.data.image_urls;
    videoUrl = hookResult.data.video_url ?? null;
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
        `[LinkedIn Analytics] Failed to scrape content for ${postId}:`,
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
  const { isBackfill } = await chrome.storage.session.get("isBackfill");
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
        console.error(`[LinkedIn Analytics] Backfill failed for ${postId}:`, err.message);
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

async function finishSync() {
  const { syncTabId } = await chrome.storage.session.get("syncTabId");
  if (syncTabId) {
    try {
      await chrome.tabs.remove(syncTabId);
    } catch {}
  }

  // Check for posts needing content or image backfill
  try {
    const [contentRes, imagesRes] = await Promise.all([
      fetch(`${SERVER_URL}/api/posts/needs-content`),
      fetch(`${SERVER_URL}/api/posts/needs-images`),
    ]);
    const contentIds = contentRes.ok ? (await contentRes.json()).post_ids : [];
    const imageIds = imagesRes.ok ? (await imagesRes.json()).post_ids : [];
    // Deduplicate
    const allIds = [...new Set([...contentIds, ...imageIds])];
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

  await chrome.storage.local.set({ lastSyncAt: Date.now() });
  await chrome.storage.session.set({
    syncInProgress: false,
    syncTabId: null,
    syncPosts: null,
    syncBatchCursor: null,
  });
}

async function finishSyncWithError(error: string) {
  console.error("[LinkedIn Analytics] Sync error:", error);
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

    function listener(
      updatedTabId: number,
      changeInfo: chrome.tabs.TabChangeInfo
    ) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
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
