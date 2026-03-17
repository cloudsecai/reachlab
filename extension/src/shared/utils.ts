/**
 * Decode a LinkedIn activity ID (snowflake) to the creation date.
 * LinkedIn uses Unix epoch with no offset: timestamp = id >> 22.
 */
export function activityIdToDate(activityId: string): Date {
  return new Date(Number(BigInt(activityId) >> BigInt(22)));
}

/**
 * Parse a comma-formatted metric value (e.g., "2,003") to a number.
 * Returns null for non-numeric or empty text.
 */
export function parseMetricValue(text: string): number | null {
  const cleaned = text?.replace(/,/g, "").trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Parse LinkedIn watch time strings like "3h 14m 9s" to total seconds.
 * Returns null for unparseable text.
 */
export function parseWatchTime(text: string): number | null {
  const hours = text.match(/(\d+)h/)?.[1];
  const minutes = text.match(/(\d+)m/)?.[1];
  const seconds = text.match(/(\d+)s/)?.[1];

  if (!hours && !minutes && !seconds) return null;

  return (
    (hours ? parseInt(hours) * 3600 : 0) +
    (minutes ? parseInt(minutes) * 60 : 0) +
    (seconds ? parseInt(seconds) : 0)
  );
}

/**
 * Detect content type from a post item element on the top-posts list.
 * - Video: img src contains "videocover"
 * - Image: has .ivm-image-view-model
 * - Text: no media elements
 */
export function detectContentType(postItem: Element): "text" | "image" | "video" {
  const imgs = postItem.querySelectorAll("img");
  for (const img of imgs) {
    if (img.getAttribute("src")?.includes("videocover")) return "video";
  }
  if (postItem.querySelector(".ivm-image-view-model")) return "image";
  return "text";
}

/**
 * Extract activity ID from a LinkedIn URL or href.
 */
export function extractActivityId(href: string): string | null {
  return href.match(/activity[:-](\d+)/)?.[1] ?? null;
}

/**
 * Wait for a selector to appear in the document, with a timeout.
 */
export function waitForSelector(
  selector: string,
  timeoutMs: number = 10000
): Promise<Element | null> {
  return new Promise((resolve) => {
    const existing = document.querySelector(selector);
    if (existing) {
      resolve(existing);
      return;
    }

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);
  });
}
