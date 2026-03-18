import type Database from "better-sqlite3";

export function upsertPost(
  db: Database.Database,
  post: {
    id: string;
    content_preview?: string | null;
    content_type?: string | null;
    published_at?: string | null;
    url?: string | null;
    full_text?: string | null;
    hook_text?: string | null;
    image_urls?: string[] | null;
  }
): void {
  const imageUrlsJson = post.image_urls && post.image_urls.length > 0 ? JSON.stringify(post.image_urls) : null;

  // If the post already exists, do a partial UPDATE (avoids NOT NULL constraint
  // issues when content_type/published_at are omitted in a partial update).
  if (postExists(db, post.id)) {
    db.prepare(
      `UPDATE posts SET
         content_preview = COALESCE(@content_preview, content_preview),
         content_type = COALESCE(@content_type, content_type),
         published_at = COALESCE(@published_at, published_at),
         url = COALESCE(@url, url),
         full_text = COALESCE(@full_text, full_text),
         hook_text = COALESCE(@hook_text, hook_text),
         image_urls = COALESCE(@image_urls, image_urls)
       WHERE id = @id`
    ).run({
      id: post.id,
      content_preview: post.content_preview ?? null,
      content_type: post.content_type ?? null,
      published_at: post.published_at ?? null,
      url: post.url ?? null,
      full_text: post.full_text ?? null,
      hook_text: post.hook_text ?? null,
      image_urls: imageUrlsJson,
    });
  } else {
    db.prepare(
      `INSERT INTO posts (id, content_preview, content_type, published_at, url, full_text, hook_text, image_urls)
       VALUES (@id, @content_preview, @content_type, @published_at, @url, @full_text, @hook_text, @image_urls)`
    ).run({
      id: post.id,
      content_preview: post.content_preview ?? null,
      content_type: post.content_type ?? null,
      published_at: post.published_at ?? null,
      url: post.url ?? null,
      full_text: post.full_text ?? null,
      hook_text: post.hook_text ?? null,
      image_urls: imageUrlsJson,
    });
  }
}

export function insertPostMetrics(
  db: Database.Database,
  metrics: {
    post_id: string;
    impressions?: number | null;
    members_reached?: number | null;
    reactions?: number | null;
    comments?: number | null;
    reposts?: number | null;
    saves?: number | null;
    sends?: number | null;
    video_views?: number | null;
    watch_time_seconds?: number | null;
    avg_watch_time_seconds?: number | null;
  }
): void {
  db.prepare(
    `INSERT INTO post_metrics
     (post_id, impressions, members_reached, reactions, comments, reposts, saves, sends,
      video_views, watch_time_seconds, avg_watch_time_seconds)
     VALUES (@post_id, @impressions, @members_reached, @reactions, @comments, @reposts,
             @saves, @sends, @video_views, @watch_time_seconds, @avg_watch_time_seconds)`
  ).run({
    post_id: metrics.post_id,
    impressions: metrics.impressions ?? null,
    members_reached: metrics.members_reached ?? null,
    reactions: metrics.reactions ?? null,
    comments: metrics.comments ?? null,
    reposts: metrics.reposts ?? null,
    saves: metrics.saves ?? null,
    sends: metrics.sends ?? null,
    video_views: metrics.video_views ?? null,
    watch_time_seconds: metrics.watch_time_seconds ?? null,
    avg_watch_time_seconds: metrics.avg_watch_time_seconds ?? null,
  });
}

export function upsertFollowerSnapshot(
  db: Database.Database,
  totalFollowers: number
): void {
  const today = new Date().toISOString().split("T")[0];
  db.prepare(
    `INSERT INTO follower_snapshots (date, total_followers)
     VALUES (?, ?)
     ON CONFLICT(date) DO UPDATE SET total_followers = ?`
  ).run(today, totalFollowers, totalFollowers);
}

export function upsertProfileSnapshot(
  db: Database.Database,
  profile: {
    profile_views?: number | null;
    search_appearances?: number | null;
    all_appearances?: number | null;
  }
): void {
  const today = new Date().toISOString().split("T")[0];
  db.prepare(
    `INSERT INTO profile_snapshots (date, profile_views, search_appearances, all_appearances)
     VALUES (@date, @profile_views, @search_appearances, @all_appearances)
     ON CONFLICT(date) DO UPDATE SET
       profile_views = COALESCE(@profile_views, profile_views),
       search_appearances = COALESCE(@search_appearances, search_appearances),
       all_appearances = COALESCE(@all_appearances, all_appearances)`
  ).run({
    date: today,
    profile_views: profile.profile_views ?? null,
    search_appearances: profile.search_appearances ?? null,
    all_appearances: profile.all_appearances ?? null,
  });
}

export function logScrape(
  db: Database.Database,
  log: {
    posts_status: string;
    followers_status: string;
    profile_status: string;
    posts_count: number;
    error_details?: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO scrape_log (completed_at, posts_status, followers_status, profile_status, posts_count, error_details)
     VALUES (CURRENT_TIMESTAMP, @posts_status, @followers_status, @profile_status, @posts_count, @error_details)`
  ).run({
    posts_status: log.posts_status,
    followers_status: log.followers_status,
    profile_status: log.profile_status,
    posts_count: log.posts_count,
    error_details: log.error_details ?? null,
  });
}

export function postExists(db: Database.Database, postId: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM posts WHERE id = ?")
    .get(postId);
  return !!row;
}

export interface PostsQueryParams {
  content_type?: string;
  since?: string;
  until?: string;
  min_impressions?: number;
  sort_by?: string;
  sort_order?: string;
  offset?: number;
  limit?: number;
}

export function queryPosts(db: Database.Database, params: PostsQueryParams) {
  const conditions: string[] = [];
  const values: any[] = [];

  if (params.content_type) {
    conditions.push("p.content_type = ?");
    values.push(params.content_type);
  }
  if (params.since) {
    conditions.push("p.published_at >= ?");
    values.push(params.since);
  }
  if (params.until) {
    conditions.push("p.published_at <= ?");
    values.push(params.until);
  }
  if (params.min_impressions != null) {
    conditions.push("m.impressions >= ?");
    values.push(params.min_impressions);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const allowedSortColumns: Record<string, string> = {
    published_at: "p.published_at",
    impressions: "m.impressions",
    engagement_rate: "engagement_rate",
    reactions: "m.reactions",
    comments: "m.comments",
  };

  const sortCol = allowedSortColumns[params.sort_by || "published_at"] || "p.published_at";
  const sortOrder = params.sort_order === "asc" ? "ASC" : "DESC";
  const limit = Math.min(params.limit || 20, 100);
  const offset = params.offset || 0;

  const countSql = `
    SELECT COUNT(*) as total
    FROM posts p
    LEFT JOIN post_metrics m ON m.post_id = p.id
      AND m.id = (SELECT MAX(id) FROM post_metrics WHERE post_id = p.id)
    ${where}
  `;

  const querySql = `
    SELECT p.id, p.content_preview, p.hook_text, p.full_text, p.image_local_paths,
      p.content_type, p.published_at, p.url,
      m.impressions, m.reactions, m.comments, m.reposts,
      CASE WHEN m.impressions > 0
        THEN CAST(COALESCE(m.reactions, 0) + COALESCE(m.comments, 0) + COALESCE(m.reposts, 0) AS REAL) / m.impressions
        ELSE NULL
      END AS engagement_rate,
      t.post_category
    FROM posts p
    LEFT JOIN post_metrics m ON m.post_id = p.id
      AND m.id = (SELECT MAX(id) FROM post_metrics WHERE post_id = p.id)
    LEFT JOIN ai_tags t ON t.post_id = p.id
    ${where}
    ORDER BY ${sortCol} ${sortOrder}
    LIMIT ? OFFSET ?
  `;

  const total = (db.prepare(countSql).get(...values) as any).total;
  const posts = db.prepare(querySql).all(...values, limit, offset);

  return { posts, total, offset, limit };
}

export function queryMetrics(db: Database.Database, postId: string) {
  return db
    .prepare(
      `SELECT id, post_id, scraped_at, impressions, members_reached,
              reactions, comments, reposts, saves, sends,
              video_views, watch_time_seconds, avg_watch_time_seconds
       FROM post_metrics
       WHERE post_id = ?
       ORDER BY scraped_at ASC`
    )
    .all(postId);
}

export function queryOverview(
  db: Database.Database,
  params?: { since?: string; until?: string }
) {
  const conditions: string[] = [];
  const values: any[] = [];

  if (params?.since) {
    conditions.push("p.published_at >= ?");
    values.push(params.since);
  }
  if (params?.until) {
    conditions.push("p.published_at <= ?");
    values.push(params.until);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const metrics = db
    .prepare(
      `SELECT
        SUM(m.impressions) as total_impressions,
        AVG(
          CASE WHEN m.impressions > 0
            THEN CAST(COALESCE(m.reactions,0) + COALESCE(m.comments,0) + COALESCE(m.reposts,0) AS REAL) / m.impressions
            ELSE NULL
          END
        ) as avg_engagement_rate,
        COUNT(DISTINCT p.id) as posts_count
      FROM posts p
      LEFT JOIN post_metrics m ON m.post_id = p.id
        AND m.id = (SELECT MAX(id) FROM post_metrics WHERE post_id = p.id)
      ${where}`
    )
    .get(...values) as any;

  const followers = db
    .prepare(
      "SELECT total_followers FROM follower_snapshots ORDER BY date DESC LIMIT 1"
    )
    .get() as any;

  const profile = db
    .prepare(
      "SELECT profile_views FROM profile_snapshots ORDER BY date DESC LIMIT 1"
    )
    .get() as any;

  return {
    total_impressions: metrics?.total_impressions ?? 0,
    avg_engagement_rate: metrics?.avg_engagement_rate ?? null,
    total_followers: followers?.total_followers ?? null,
    profile_views: profile?.profile_views ?? null,
    posts_count: metrics?.posts_count ?? 0,
  };
}

export function queryTiming(db: Database.Database) {
  return db
    .prepare(
      `SELECT
        CAST(strftime('%w', p.published_at) AS INTEGER) as day,
        CAST(strftime('%H', p.published_at) AS INTEGER) as hour,
        AVG(
          CASE WHEN m.impressions > 0
            THEN CAST(COALESCE(m.reactions,0) + COALESCE(m.comments,0) + COALESCE(m.reposts,0) AS REAL) / m.impressions
            ELSE NULL
          END
        ) as avg_engagement_rate,
        COUNT(*) as post_count
      FROM posts p
      LEFT JOIN post_metrics m ON m.post_id = p.id
        AND m.id = (SELECT MAX(id) FROM post_metrics WHERE post_id = p.id)
      WHERE p.published_at IS NOT NULL
      GROUP BY day, hour
      ORDER BY day, hour`
    )
    .all();
}

export function queryFollowers(db: Database.Database) {
  return db
    .prepare(
      `SELECT date, total_followers,
        total_followers - LAG(total_followers) OVER (ORDER BY date) AS new_followers
      FROM follower_snapshots
      ORDER BY date ASC`
    )
    .all();
}

export function queryProfile(db: Database.Database) {
  return db
    .prepare(
      `SELECT date, profile_views, search_appearances, all_appearances
      FROM profile_snapshots
      ORDER BY date ASC`
    )
    .all();
}

export function queryHealth(db: Database.Database) {
  const lastLog = db
    .prepare(
      "SELECT * FROM scrape_log ORDER BY id DESC LIMIT 1"
    )
    .get() as any;

  if (!lastLog) {
    return {
      last_sync_at: null,
      sources: {
        posts: { status: "ok" as const, last_success: null },
        followers: { status: "ok" as const, last_success: null },
        profile: { status: "ok" as const, last_success: null },
      },
    };
  }

  const getLastSuccess = (field: string) => {
    const row = db
      .prepare(
        `SELECT completed_at FROM scrape_log WHERE ${field} = 'success' ORDER BY id DESC LIMIT 1`
      )
      .get() as any;
    return row?.completed_at ?? null;
  };

  const mapStatus = (s: string) => (s === "error" ? "error" : "ok") as "ok" | "error";

  return {
    last_sync_at: lastLog.completed_at,
    sources: {
      posts: {
        status: mapStatus(lastLog.posts_status),
        last_success: getLastSuccess("posts_status"),
        ...(lastLog.posts_status === "error" && lastLog.error_details
          ? { error: JSON.parse(lastLog.error_details)?.posts }
          : {}),
      },
      followers: {
        status: mapStatus(lastLog.followers_status),
        last_success: getLastSuccess("followers_status"),
        ...(lastLog.followers_status === "error" && lastLog.error_details
          ? { error: JSON.parse(lastLog.error_details)?.followers }
          : {}),
      },
      profile: {
        status: mapStatus(lastLog.profile_status),
        last_success: getLastSuccess("profile_status"),
        ...(lastLog.profile_status === "error" && lastLog.error_details
          ? { error: JSON.parse(lastLog.error_details)?.profile }
          : {}),
      },
    },
  };
}
