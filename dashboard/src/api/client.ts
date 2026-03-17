const BASE_URL = "/api";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export interface OverviewData {
  total_impressions: number;
  avg_engagement_rate: number | null;
  total_followers: number | null;
  profile_views: number | null;
  posts_count: number;
}

export interface Post {
  id: string;
  content_preview: string | null;
  content_type: string;
  published_at: string;
  url: string | null;
  impressions: number | null;
  reactions: number | null;
  comments: number | null;
  reposts: number | null;
  engagement_rate: number | null;
}

export interface PostsResponse {
  posts: Post[];
  total: number;
  offset: number;
  limit: number;
}

export interface MetricSnapshot {
  id: number;
  post_id: string;
  scraped_at: string;
  impressions: number | null;
  members_reached: number | null;
  reactions: number | null;
  comments: number | null;
  reposts: number | null;
  saves: number | null;
  sends: number | null;
  video_views: number | null;
  watch_time_seconds: number | null;
  avg_watch_time_seconds: number | null;
}

export interface TimingSlot {
  day: number;
  hour: number;
  avg_engagement_rate: number | null;
  post_count: number;
}

export interface FollowerSnapshot {
  date: string;
  total_followers: number;
  new_followers: number | null;
}

export interface ProfileSnapshot {
  date: string;
  profile_views: number | null;
  search_appearances: number | null;
  all_appearances: number | null;
}

export interface HealthData {
  last_sync_at: string | null;
  sources: {
    posts: { status: "ok" | "error"; last_success: string | null; error?: string };
    followers: { status: "ok" | "error"; last_success: string | null; error?: string };
    profile: { status: "ok" | "error"; last_success: string | null; error?: string };
  };
}

export const api = {
  overview: (params?: { since?: string; until?: string }) => {
    const q = new URLSearchParams();
    if (params?.since) q.set("since", params.since);
    if (params?.until) q.set("until", params.until);
    const qs = q.toString();
    return get<OverviewData>(`/overview${qs ? `?${qs}` : ""}`);
  },
  posts: (params?: Record<string, string | number | undefined>) => {
    const q = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v != null) q.set(k, String(v));
      }
    }
    const qs = q.toString();
    return get<PostsResponse>(`/posts${qs ? `?${qs}` : ""}`);
  },
  metrics: (postId: string) =>
    get<{ post_id: string; metrics: MetricSnapshot[] }>(`/metrics/${postId}`),
  timing: () => get<{ slots: TimingSlot[] }>("/timing"),
  followers: () => get<{ snapshots: FollowerSnapshot[] }>("/followers"),
  profile: () => get<{ snapshots: ProfileSnapshot[] }>("/profile"),
  health: () => get<HealthData>("/health"),
};
