import { z } from "zod";

// --- Content type union ---

export type ContentType = "text" | "image" | "carousel" | "video" | "article";

// --- Zod schemas for scraped data validation ---

export const scrapedPostSchema = z.object({
  id: z.string().min(1),
  content_preview: z.string().nullable(),
  content_type: z.enum(["text", "image", "carousel", "video", "article"]),
  published_at: z.string().min(1),
  url: z.string().min(1),
  impressions: z.number().int().nullable(),
});

export const scrapedPostMetricsSchema = z.object({
  impressions: z.number().int().nullable(),
  members_reached: z.number().int().nullable(),
  reactions: z.number().int().nullable(),
  comments: z.number().int().nullable(),
  reposts: z.number().int().nullable(),
  saves: z.number().int().nullable(),
  sends: z.number().int().nullable(),
  video_views: z.number().int().nullable(),
  watch_time_seconds: z.number().int().nullable(),
  avg_watch_time_seconds: z.number().int().nullable(),
});

export const scrapedAudienceSchema = z.object({
  total_followers: z.number().int().nullable(),
});

export const scrapedProfileViewsSchema = z.object({
  profile_views: z.number().int().nullable(),
});

export const scrapedSearchAppearancesSchema = z.object({
  all_appearances: z.number().int().nullable(),
  search_appearances: z.number().int().nullable(),
});

// --- TypeScript interfaces (inferred from schemas) ---

export type ScrapedPost = z.infer<typeof scrapedPostSchema>;
export type ScrapedPostMetrics = z.infer<typeof scrapedPostMetricsSchema>;
export type ScrapedAudience = z.infer<typeof scrapedAudienceSchema>;
export type ScrapedProfileViews = z.infer<typeof scrapedProfileViewsSchema>;
export type ScrapedSearchAppearances = z.infer<typeof scrapedSearchAppearancesSchema>;

// --- Messages from content script to service worker ---

export type ContentMessage =
  | { type: "top-posts"; data: ScrapedPost[] }
  | { type: "post-detail"; postId: string; data: ScrapedPostMetrics }
  | { type: "audience"; data: ScrapedAudience }
  | { type: "profile-views"; data: ScrapedProfileViews }
  | { type: "search-appearances"; data: ScrapedSearchAppearances }
  | { type: "scrape-error"; page: string; error: string };

// --- Commands from service worker to content script ---

export type BackgroundCommand = { type: "scrape-page" };
