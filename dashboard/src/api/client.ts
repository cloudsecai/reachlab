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
  hook_text: string | null;
  full_text: string | null;
  image_local_paths: string | null;
  content_type: string;
  published_at: string;
  url: string | null;
  impressions: number | null;
  reactions: number | null;
  comments: number | null;
  reposts: number | null;
  engagement_rate: number | null;
  post_category: string | null;
  topics: string | null;
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

export interface AiOverview {
  summary_text: string;
  top_performer_post_id: string | null;
  top_performer_reason: string | null;
  quick_insights: string; // JSON array string
}

export interface Recommendation {
  id: number;
  type: string;
  priority: string;
  confidence: string;
  headline: string;
  detail: string;
  action: string;
  evidence_json: string | null;
  feedback: string | null;
  acted_on: number;
  created_at: string;
  resolved_at: string | null;
  resolved_type: string | null;
  stable_key: string | null;
}

export interface Insight {
  id: number;
  category: string;
  stable_key: string;
  claim: string;
  evidence: string;
  confidence: string;
  direction: string;
  consecutive_appearances: number;
  status: string;
}

export interface Changelog {
  confirmed: Insight[];
  new_signal: Insight[];
  reversed: Insight[];
  retired: Insight[];
}

export interface AnalysisGap {
  id: number;
  gap_type: string;
  stable_key: string;
  description: string;
  impact: string;
  times_flagged: number;
  first_seen_at: string;
  last_seen_at: string;
}

export interface PromptSuggestion {
  current: string;
  suggested: string;
  evidence: string;
}

export interface PromptSuggestions {
  assessment: "working_well" | "suggest_changes";
  reasoning: string;
  suggestions: PromptSuggestion[];
}

export interface WritingPromptHistory {
  id: number;
  prompt_text: string;
  source: string;
  suggestion_evidence: string | null;
  created_at: string;
}

export interface TaxonomyItem {
  id: number;
  name: string;
  description: string;
}

export interface MetricsSummary {
  median_er: number | null;
  median_impressions: number | null;
  total_posts: number;
  avg_comments: number | null;
}

export interface ProgressData {
  current: MetricsSummary;
  previous: MetricsSummary;
}

export interface CategoryPerformance {
  category: string;
  post_count: number;
  median_er: number | null;
  median_impressions: number | null;
  median_interactions: number | null;
  status: "underexplored_high" | "reliable" | "declining" | "normal";
}

export interface SparklinePoint {
  date: string;
  er: number;
  impressions: number;
  comments: number;
  comment_ratio: number;
  save_rate: number;
}

export interface EngagementQuality {
  comment_ratio: number | null;
  save_rate: number | null;
  repost_rate: number | null;
  weighted_er: number | null;
  standard_er: number | null;
  total_posts: number;
}

export interface RecommendationsWithCooldown {
  active: Recommendation[];
  resolved: Recommendation[];
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
  insightsOverview: () => get<{ overview: AiOverview | null }>("/insights/overview"),
  insights: () => get<{ recommendations: Recommendation[]; insights: Insight[] }>("/insights"),
  insightsChangelog: () => get<Changelog>("/insights/changelog"),
  insightsTags: (postIds: string[]) =>
    get<{ tags: Record<string, { hook_type: string; tone: string; format_style: string }> }>(
      `/insights/tags?post_ids=${postIds.join(",")}`
    ),
  insightsTaxonomy: () => get<{ taxonomy: TaxonomyItem[] }>("/insights/taxonomy"),
  insightsRefresh: () =>
    fetch(`${BASE_URL}/insights/refresh`, { method: "POST" }).then((r) => r.json()),
  recommendationFeedback: (id: number, rating: string, reason?: string) =>
    fetch(`${BASE_URL}/insights/recommendations/${id}/feedback`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback: { rating, reason: reason || null } }),
    }).then((r) => r.json()),
  authorPhoto: () =>
    fetch(`${BASE_URL}/settings/author-photo`).then((r) =>
      r.ok ? r.blob().then((b) => URL.createObjectURL(b)) : null
    ),
  uploadAuthorPhoto: (file: File) =>
    fetch(`${BASE_URL}/settings/author-photo`, {
      method: "POST",
      body: file,
      headers: { "Content-Type": file.type },
    }).then((r) => r.json()),
  deleteAuthorPhoto: () =>
    fetch(`${BASE_URL}/settings/author-photo`, { method: "DELETE" }).then((r) => r.json()),

  // Timezone
  setTimezone: (timezone: string) =>
    fetch(`${BASE_URL}/settings/timezone`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timezone }),
    }).then((r) => r.json() as Promise<{ ok: boolean }>),

  // Writing prompt
  getWritingPrompt: () =>
    get<{ text: string | null }>("/settings/writing-prompt"),

  saveWritingPrompt: (text: string, source: "manual_edit" | "ai_suggestion", evidence?: string) =>
    fetch(`${BASE_URL}/settings/writing-prompt`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, source, evidence }),
    }).then((r) => r.json() as Promise<{ ok: boolean }>),

  getWritingPromptHistory: () =>
    get<{ history: WritingPromptHistory[] }>("/settings/writing-prompt/history"),

  // Recommendations with cooldown
  recommendationsWithCooldown: () =>
    get<RecommendationsWithCooldown>("/insights/recommendations"),

  // Resolve a recommendation
  resolveRecommendation: (id: number, type: "accepted" | "dismissed") =>
    fetch(`${BASE_URL}/insights/recommendations/${id}/resolve`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type }),
    }).then((r) => r.json()),

  // Deep Dive endpoints
  deepDiveProgress: (days = 30) =>
    get<ProgressData>(`/insights/deep-dive/progress?days=${days}`),

  deepDiveCategories: () =>
    get<{ categories: CategoryPerformance[] }>("/insights/deep-dive/categories"),

  deepDiveEngagement: () =>
    get<{ engagement: EngagementQuality }>("/insights/deep-dive/engagement"),

  deepDiveSparkline: (days = 90) =>
    get<{ points: SparklinePoint[] }>(`/insights/deep-dive/sparkline?days=${days}`),

  // Analysis gaps
  insightsGaps: () =>
    get<{ gaps: AnalysisGap[] }>("/insights/gaps"),

  // Prompt suggestions
  insightsPromptSuggestions: () =>
    get<{ prompt_suggestions: PromptSuggestions | null }>("/insights/prompt-suggestions"),
};
