import { waitForSelector } from "../shared/utils.js";
import {
  scrapeTopPosts,
  scrapePostDetail,
  scrapeAudience,
  scrapeProfileViews,
  scrapeSearchAppearances,
} from "./scrapers.js";
import {
  scrapedPostSchema,
  scrapedPostMetricsSchema,
  scrapedAudienceSchema,
  scrapedProfileViewsSchema,
  scrapedSearchAppearancesSchema,
} from "../shared/types.js";
import type { ContentMessage } from "../shared/types.js";
import { z } from "zod";

/**
 * Content script entry point.
 * Runs on linkedin.com/analytics/* pages. When the service worker sends a
 * "scrape-page" command, this script detects the current URL, waits for
 * key selectors to render, scrapes the data, validates with Zod, and relays it back.
 */

// Listen for scrape commands from the service worker
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "scrape-page") {
    scrapeCurrent()
      .then((result) => sendResponse(result))
      .catch((err) =>
        sendResponse({
          type: "scrape-error",
          page: location.pathname,
          error: err.message,
        } as ContentMessage)
      );
    return true; // keep message channel open for async response
  }
});

async function requireSelector(
  selector: string,
  pageName: string
): Promise<void> {
  const el = await waitForSelector(selector);
  if (!el) {
    throw new Error(
      `[${pageName}] Expected selector "${selector}" not found within timeout. ` +
        `LinkedIn may have changed their page structure.`
    );
  }
}

function validate<T>(schema: z.ZodType<T>, data: unknown, pageName: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join(", ");
    throw new Error(`[${pageName}] Validation failed: ${issues}`);
  }
  return result.data;
}

async function scrapeCurrent(): Promise<ContentMessage> {
  const url = location.href;

  if (url.includes("/analytics/creator/top-posts")) {
    await requireSelector(
      ".member-analytics-addon__mini-update-item",
      "top-posts"
    );
    const raw = scrapeTopPosts(document);
    const data = validate(z.array(scrapedPostSchema), raw, "top-posts");
    return { type: "top-posts", data };
  }

  if (url.includes("/analytics/post-summary/")) {
    await requireSelector(
      ".member-analytics-addon-card__base-card",
      "post-detail"
    );
    const postIdMatch = url.match(/activity[:-](\d+)/);
    const postId = postIdMatch?.[1] ?? "unknown";
    const raw = scrapePostDetail(document);
    const data = validate(scrapedPostMetricsSchema, raw, "post-detail");
    return { type: "post-detail", postId, data };
  }

  if (url.includes("/analytics/creator/audience")) {
    await requireSelector(
      ".member-analytics-addon-summary__list-item",
      "audience"
    );
    const raw = scrapeAudience(document);
    const data = validate(scrapedAudienceSchema, raw, "audience");
    return { type: "audience", data };
  }

  if (url.includes("/analytics/profile-views")) {
    await requireSelector(
      ".member-analytics-addon-summary__list-item",
      "profile-views"
    );
    const raw = scrapeProfileViews(document);
    const data = validate(scrapedProfileViewsSchema, raw, "profile-views");
    return { type: "profile-views", data };
  }

  if (url.includes("/analytics/search-appearances")) {
    await requireSelector(
      ".member-analytics-addon-summary__list-item",
      "search-appearances"
    );
    const raw = scrapeSearchAppearances(document);
    const data = validate(
      scrapedSearchAppearancesSchema,
      raw,
      "search-appearances"
    );
    return { type: "search-appearances", data };
  }

  return {
    type: "scrape-error",
    page: location.pathname,
    error: "Unknown analytics page",
  };
}
