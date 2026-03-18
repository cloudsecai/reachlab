import { z } from "zod";

const contentTypeSchema = z.enum(["text", "image", "carousel", "video", "article"]);

const postSchema = z.object({
  id: z.string().min(1),
  content_preview: z.string().optional(),
  content_type: contentTypeSchema.optional(),
  published_at: z.string().datetime({ offset: true }).optional(),
  url: z.string().optional(),
  full_text: z.string().optional(),
  hook_text: z.string().optional(),
  image_urls: z.array(z.string()).optional(),
  video_url: z.string().url().optional(),
});

const postMetricsSchema = z.object({
  post_id: z.string().min(1),
  impressions: z.number().int().nullable().optional(),
  members_reached: z.number().int().nullable().optional(),
  reactions: z.number().int().nullable().optional(),
  comments: z.number().int().nullable().optional(),
  reposts: z.number().int().nullable().optional(),
  saves: z.number().int().nullable().optional(),
  sends: z.number().int().nullable().optional(),
  video_views: z.number().int().nullable().optional(),
  watch_time_seconds: z.number().int().nullable().optional(),
  avg_watch_time_seconds: z.number().int().nullable().optional(),
});

const followersSchema = z.object({
  total_followers: z.number().int(),
});

const profileSchema = z.object({
  profile_views: z.number().int().nullable().optional(),
  search_appearances: z.number().int().nullable().optional(),
  all_appearances: z.number().int().nullable().optional(),
});

export const ingestPayloadSchema = z.object({
  posts: z.array(postSchema).optional(),
  post_metrics: z.array(postMetricsSchema).optional(),
  followers: followersSchema.optional(),
  profile: profileSchema.optional(),
  author_photo_url: z.string().url().optional(),
});

export type IngestPayload = z.infer<typeof ingestPayloadSchema>;
