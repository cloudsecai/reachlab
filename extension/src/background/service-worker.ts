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
  // Check if already syncing
  const { syncInProgress } = await chrome.storage.session.get("syncInProgress");
  if (syncInProgress) return;

  if (!manual) {
    // Check if sync needed
    const { lastSyncAt } = await chrome.storage.local.get("lastSyncAt");
    if (lastSyncAt && Date.now() - lastSyncAt < SYNC_INTERVAL_MS) return;

    // Check if user has a linkedin.com tab open
    const tabs = await chrome.tabs.query({ url: "*://*.linkedin.com/*" });
    if (tabs.length === 0) return;
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
      await postToServer({
        posts: posts.map((p) => ({
          id: p.id,
          content_preview: p.content_preview ?? undefined,
          content_type: p.content_type,
          published_at: p.published_at,
          url: p.url,
        })),
      });

      // Filter posts for detail scraping:
      // - Backfill: scrape all posts
      // - Daily sync: only posts <30 days old
      const postIdsToScrape = isBackfill
        ? posts.map((p) => p.id)
        : posts
            .filter((p) => {
              const publishedDate = activityIdToDate(p.id);
              const ageMs = Date.now() - publishedDate.getTime();
              return ageMs < METRIC_DECAY_DAYS * 24 * 60 * 60 * 1000;
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

async function finishSync() {
  const { syncTabId } = await chrome.storage.session.get("syncTabId");
  if (syncTabId) {
    try {
      await chrome.tabs.remove(syncTabId);
    } catch {}
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

function sendScrapeCommand(tabId: number): Promise<ContentMessage> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: "scrape-page" }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response as ContentMessage);
      }
    });
  });
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
