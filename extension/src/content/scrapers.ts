import {
  parseMetricValue,
  parseWatchTime,
  detectContentType,
  extractActivityId,
  activityIdToDate,
} from "../shared/utils.js";
import type {
  ScrapedPost,
  ScrapedPostMetrics,
  ScrapedPostContent,
  ScrapedAudience,
  ScrapedProfileViews,
  ScrapedSearchAppearances,
} from "../shared/types.js";

/**
 * Extract summary KPI values from a page using the shared
 * .member-analytics-addon-summary pattern.
 */
function extractSummaryKPIs(doc: Document): Record<string, number | null> {
  const kpis: Record<string, number | null> = {};
  const items = doc.querySelectorAll(
    ".member-analytics-addon-summary__list-item"
  );
  for (const item of items) {
    const label = item
      .querySelector(".member-analytics-addon-list-item__description")
      ?.textContent?.trim()
      ?.toLowerCase();
    const valueText = item
      .querySelector(".text-heading-large")
      ?.textContent?.trim();
    if (label && valueText) {
      kpis[label] = parseMetricValue(valueText);
    }
  }
  return kpis;
}

/**
 * Scrape the top-posts list page.
 * Returns an array of posts with IDs, content previews, impressions, and content types.
 */
export function scrapeTopPosts(doc: Document): ScrapedPost[] {
  const posts: ScrapedPost[] = [];
  const postItems = doc.querySelectorAll(
    ".member-analytics-addon__mini-update-item"
  );

  for (const item of postItems) {
    const href = item.getAttribute("href") ?? "";
    const activityId = extractActivityId(href);
    if (!activityId) continue;

    // Content preview: try aria-label first, fall back to inline text body
    const ariaEl = item.querySelector("[aria-label]");
    const ariaLabel = ariaEl?.getAttribute("aria-label") ?? null;
    const ariaPreview =
      ariaLabel &&
      ariaLabel !== "Image" &&
      !ariaLabel.includes("posted this")
        ? ariaLabel
        : null;
    // Fallback: the inline text body (works for video/image posts where aria-label is generic)
    const inlineText = item
      .querySelector(".inline-show-more-text span")
      ?.textContent?.trim() ?? null;
    const contentPreview = ariaPreview || inlineText;

    // Content type detection
    const contentType = detectContentType(item);

    // Published date from activity ID
    const publishedAt = activityIdToDate(activityId).toISOString();

    // Find the companion CTA element for impressions
    // The CTA is a sibling to the post item, within the same <li>
    const parentLi = item.closest("li");
    const ctaEl = parentLi?.querySelector(
      ".member-analytics-addon__cta-item-with-secondary-anchor"
    );
    const impressionText = ctaEl
      ?.querySelector(
        ".member-analytics-addon__cta-item-with-secondary-list-item-title"
      )
      ?.textContent?.trim();
    const impressions = impressionText
      ? parseMetricValue(impressionText)
      : null;

    posts.push({
      id: activityId,
      content_preview: contentPreview,
      content_type: contentType,
      published_at: publishedAt,
      url: `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`,
      impressions,
    });
  }

  return posts;
}

/**
 * Scrape a post detail page for all metrics.
 */
export function scrapePostDetail(doc: Document): ScrapedPostMetrics {
  const result: ScrapedPostMetrics = {
    impressions: null,
    members_reached: null,
    reactions: null,
    comments: null,
    reposts: null,
    saves: null,
    sends: null,
    video_views: null,
    watch_time_seconds: null,
    avg_watch_time_seconds: null,
  };

  const cards = doc.querySelectorAll(
    ".member-analytics-addon-card__base-card"
  );

  for (const card of cards) {
    const title = card
      .querySelector(".member-analytics-addon-header__title")
      ?.textContent?.trim();

    if (title === "Discovery" || title === "Social engagement") {
      // CTA list item pattern
      const items = card.querySelectorAll(
        ".member-analytics-addon__cta-list-item"
      );
      for (const item of items) {
        const label = item
          .querySelector(".text-body-small")
          ?.textContent?.trim()
          ?.toLowerCase();
        const valueText = item.querySelector("strong")?.textContent?.trim();
        if (!label || !valueText) continue;

        const value = parseMetricValue(valueText);
        if (label === "impressions") result.impressions = value;
        else if (label === "members reached") result.members_reached = value;
        else if (label === "reactions") result.reactions = value;
        else if (label === "comments") result.comments = value;
        else if (label === "reposts") result.reposts = value;
        else if (label === "saves") result.saves = value;
        else if (label.includes("sends")) result.sends = value;
      }
    } else if (title === "Video performance") {
      // Summary KPI pattern for video metrics
      const items = card.querySelectorAll(
        ".member-analytics-addon-summary__list-item"
      );
      for (const item of items) {
        const label = item
          .querySelector(".member-analytics-addon-list-item__description")
          ?.textContent?.trim()
          ?.toLowerCase();
        const valueText = item
          .querySelector(".text-heading-large")
          ?.textContent?.trim();
        if (!label || !valueText) continue;

        if (label === "video views") {
          result.video_views = parseMetricValue(valueText);
        } else if (label === "watch time") {
          result.watch_time_seconds = parseWatchTime(valueText);
        } else if (label === "average watch time") {
          result.avg_watch_time_seconds = parseWatchTime(valueText);
        }
      }
    }
  }

  return result;
}

/**
 * Scrape a post page for hook text, full text, and image URLs.
 */
export function scrapePostPage(doc: Document): ScrapedPostContent {
  // Extract hook text — the visible text before "see more"
  let hookText: string | null = null;
  let fullText: string | null = null;

  const textContainer = doc.querySelector(".feed-shared-inline-show-more-text");
  if (textContainer) {
    const textSpan = textContainer.querySelector(".break-words");
    if (textSpan) {
      hookText = textSpan.textContent?.trim() || null;
      // Preserve paragraph breaks: replace <br> tags with newlines, then get text
      const clone = textSpan.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
      // Also treat block-level elements as paragraph breaks
      clone.querySelectorAll("p, div").forEach((el) => {
        el.insertAdjacentText("beforebegin", "\n");
      });
      fullText = clone.textContent?.trim().replace(/\n{3,}/g, "\n\n") || null;
    }
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

/**
 * Scrape the audience page for total followers.
 */
export function scrapeAudience(doc: Document): ScrapedAudience {
  const kpis = extractSummaryKPIs(doc);
  return {
    total_followers: kpis["total followers"] ?? null,
  };
}

/**
 * Scrape the profile views page.
 */
export function scrapeProfileViews(doc: Document): ScrapedProfileViews {
  const kpis = extractSummaryKPIs(doc);
  return {
    profile_views: kpis["profile viewers"] ?? null,
  };
}

/**
 * Scrape the search appearances page.
 */
export function scrapeSearchAppearances(
  doc: Document
): ScrapedSearchAppearances {
  const kpis = extractSummaryKPIs(doc);
  return {
    all_appearances: kpis["all appearances"] ?? null,
    search_appearances: kpis["search appearances"] ?? null,
  };
}
