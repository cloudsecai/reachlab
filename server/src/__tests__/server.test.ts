import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";
import BetterSqlite3 from "better-sqlite3";
import fs from "fs";
import path from "path";

const TEST_DB_PATH = path.join(import.meta.dirname, "../../data/test-server.db");

let app: FastifyInstance;
let db: BetterSqlite3.Database;

beforeAll(async () => {
  app = buildApp(TEST_DB_PATH);
  await app.ready();
  db = new BetterSqlite3(TEST_DB_PATH, { readonly: true });
});

afterAll(async () => {
  db?.close();
  await app.close();
  try {
    fs.unlinkSync(TEST_DB_PATH);
    fs.unlinkSync(TEST_DB_PATH + "-wal");
    fs.unlinkSync(TEST_DB_PATH + "-shm");
  } catch {}
});

describe("GET /api/health", () => {
  it("returns health status with null last_sync when never synced", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.last_sync_at).toBeNull();
    expect(body.sources).toHaveProperty("posts");
    expect(body.sources).toHaveProperty("followers");
    expect(body.sources).toHaveProperty("profile");
    expect(body.sources.posts.status).toBe("ok");
  });
});

describe("POST /api/ingest", () => {
  it("accepts empty payload", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ingest",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.posts_upserted).toBe(0);
    expect(body.metrics_inserted).toBe(0);
  });

  it("ingests posts and returns count", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ingest",
      payload: {
        posts: [
          {
            id: "1001",
            content_preview: "Hello world",
            content_type: "text",
            published_at: "2026-03-10T12:00:00Z",
            url: "https://linkedin.com/feed/update/urn:li:activity:1001/",
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().posts_upserted).toBe(1);
  });

  it("upserts posts — second ingest updates content_preview", async () => {
    await app.inject({
      method: "POST",
      url: "/api/ingest",
      payload: {
        posts: [
          {
            id: "2001",
            content_preview: "Original text",
            content_type: "text",
            published_at: "2026-03-10T12:00:00Z",
          },
        ],
      },
    });

    await app.inject({
      method: "POST",
      url: "/api/ingest",
      payload: {
        posts: [
          {
            id: "2001",
            content_preview: "Updated text",
            content_type: "image",
            published_at: "2026-03-10T12:00:00Z",
          },
        ],
      },
    });

    const postsRes = await app.inject({
      method: "GET",
      url: "/api/posts",
    });
    const posts = postsRes.json().posts;
    const post = posts.find((p: any) => p.id === "2001");
    expect(post.content_preview).toBe("Updated text");
    expect(post.content_type).toBe("image");
  });

  it("ingests post_metrics and appends snapshots (never overwrites)", async () => {
    // Ensure post exists
    await app.inject({
      method: "POST",
      url: "/api/ingest",
      payload: {
        posts: [
          {
            id: "3001",
            content_type: "text",
            published_at: "2026-03-10T12:00:00Z",
          },
        ],
      },
    });

    // First metrics snapshot
    const res1 = await app.inject({
      method: "POST",
      url: "/api/ingest",
      payload: {
        post_metrics: [
          {
            post_id: "3001",
            impressions: 100,
            reactions: 5,
            comments: 2,
            reposts: 1,
          },
        ],
      },
    });
    expect(res1.json().metrics_inserted).toBe(1);

    // Second metrics snapshot — should append, not overwrite
    const res2 = await app.inject({
      method: "POST",
      url: "/api/ingest",
      payload: {
        post_metrics: [
          {
            post_id: "3001",
            impressions: 200,
            reactions: 10,
            comments: 4,
            reposts: 2,
          },
        ],
      },
    });
    expect(res2.json().metrics_inserted).toBe(1);

    // Verify both snapshots exist
    const metricsRes = await app.inject({
      method: "GET",
      url: "/api/metrics/3001",
    });
    const metrics = metricsRes.json().metrics;
    expect(metrics).toHaveLength(2);
    expect(metrics[0].impressions).toBe(100);
    expect(metrics[1].impressions).toBe(200);
  });

  it("ingests video metrics", async () => {
    await app.inject({
      method: "POST",
      url: "/api/ingest",
      payload: {
        posts: [
          {
            id: "4001",
            content_type: "video",
            published_at: "2026-03-10T12:00:00Z",
          },
        ],
        post_metrics: [
          {
            post_id: "4001",
            impressions: 500,
            reactions: 20,
            video_views: 300,
            watch_time_seconds: 12000,
            avg_watch_time_seconds: 40,
          },
        ],
      },
    });

    const metricsRes = await app.inject({
      method: "GET",
      url: "/api/metrics/4001",
    });
    const m = metricsRes.json().metrics[0];
    expect(m.video_views).toBe(300);
    expect(m.watch_time_seconds).toBe(12000);
    expect(m.avg_watch_time_seconds).toBe(40);
  });

  it("ingests follower snapshot", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ingest",
      payload: {
        followers: { total_followers: 4848 },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("ingests profile snapshot with all_appearances", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ingest",
      payload: {
        profile: {
          profile_views: 1023,
          search_appearances: 300,
          all_appearances: 8042,
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("accepts full_text, hook_text, image_urls on posts", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/ingest",
      payload: {
        posts: [
          {
            id: "content-fields-test",
            content_type: "image",
            published_at: "2025-01-15T10:00:00+00:00",
            full_text: "This is the full post text with lots of details.",
            hook_text: "This is the hook text...",
            image_urls: ["https://media.licdn.com/dms/image/test1.jpg"],
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.posts_upserted).toBe(1);
  });

  it("accepts partial post without content_type and published_at", async () => {
    // First create the post with required fields
    await app.inject({
      method: "POST",
      url: "/api/ingest",
      payload: {
        posts: [
          {
            id: "partial-update-test",
            content_type: "text",
            published_at: "2025-01-15T10:00:00+00:00",
          },
        ],
      },
    });

    // Then update with just content fields
    const response = await app.inject({
      method: "POST",
      url: "/api/ingest",
      payload: {
        posts: [
          {
            id: "partial-update-test",
            full_text: "Full text added later",
            hook_text: "Hook text added later",
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().posts_upserted).toBe(1);

    // Verify DB state: content_type preserved, new fields populated
    const row = db
      .prepare("SELECT content_type, full_text, hook_text FROM posts WHERE id = ?")
      .get("partial-update-test") as any;
    expect(row.content_type).toBe("text"); // preserved from first insert
    expect(row.full_text).toBe("Full text added later");
    expect(row.hook_text).toBe("Hook text added later");
  });

  it("rejects invalid content_type", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ingest",
      payload: {
        posts: [
          {
            id: "bad1",
            content_type: "podcast",
            published_at: "2026-03-10T12:00:00Z",
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects post_metrics for non-existent post", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ingest",
      payload: {
        post_metrics: [
          {
            post_id: "nonexistent",
            impressions: 100,
          },
        ],
      },
    });
    // Should still return 200 but with errors
    const body = res.json();
    expect(body.errors).toBeDefined();
    expect(body.errors.length).toBeGreaterThan(0);
  });
});

describe("GET /api/health after ingest", () => {
  it("returns last_sync_at after successful ingest", async () => {
    // Ingest some data to create a scrape_log entry
    await app.inject({
      method: "POST",
      url: "/api/ingest",
      payload: {
        posts: [
          {
            id: "health-test-1",
            content_type: "text",
            published_at: "2026-03-10T12:00:00Z",
          },
        ],
        followers: { total_followers: 100 },
        profile: { profile_views: 50, search_appearances: 10 },
      },
    });

    const res = await app.inject({ method: "GET", url: "/api/health" });
    const body = res.json();
    expect(body.last_sync_at).not.toBeNull();
    expect(body.sources.posts.status).toBe("ok");
    expect(body.sources.posts.last_success).not.toBeNull();
    expect(body.sources.followers.status).toBe("ok");
    expect(body.sources.profile.status).toBe("ok");
  });
});

describe("GET /api/posts", () => {
  it("returns posts with latest metrics and engagement_rate", async () => {
    const res = await app.inject({ method: "GET", url: "/api/posts" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("posts");
    expect(body).toHaveProperty("total");
    expect(body).toHaveProperty("offset");
    expect(body).toHaveProperty("limit");
    expect(Array.isArray(body.posts)).toBe(true);
  });

  it("computes engagement_rate at query time", async () => {
    // post 3001 has latest metrics: impressions=200, reactions=10, comments=4, reposts=2
    const res = await app.inject({ method: "GET", url: "/api/posts" });
    const post = res.json().posts.find((p: any) => p.id === "3001");
    expect(post).toBeDefined();
    // engagement_rate = (10 + 4 + 2) / 200 = 0.08
    expect(post.engagement_rate).toBeCloseTo(0.08);
  });

  it("filters by content_type", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/posts?content_type=video",
    });
    const posts = res.json().posts;
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every((p: any) => p.content_type === "video")).toBe(true);
  });

  it("filters by date range", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/posts?since=2026-03-09T00:00:00Z&until=2026-03-11T00:00:00Z",
    });
    expect(res.statusCode).toBe(200);
    const posts = res.json().posts;
    for (const p of posts) {
      const d = new Date(p.published_at);
      expect(d >= new Date("2026-03-09T00:00:00Z")).toBe(true);
      expect(d <= new Date("2026-03-11T00:00:00Z")).toBe(true);
    }
  });

  it("sorts by impressions desc", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/posts?sort_by=impressions&sort_order=desc",
    });
    const posts = res.json().posts;
    for (let i = 1; i < posts.length; i++) {
      expect(posts[i - 1].impressions >= posts[i].impressions).toBe(true);
    }
  });

  it("paginates with offset and limit", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/posts?limit=2&offset=0",
    });
    const body = res.json();
    expect(body.posts.length).toBeLessThanOrEqual(2);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(0);
  });

  it("caps limit at 100", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/posts?limit=999",
    });
    const body = res.json();
    expect(body.limit).toBe(100);
  });
});

describe("GET /api/metrics/:postId", () => {
  it("returns time series of metrics for a post", async () => {
    const res = await app.inject({ method: "GET", url: "/api/metrics/3001" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.post_id).toBe("3001");
    expect(Array.isArray(body.metrics)).toBe(true);
    expect(body.metrics.length).toBe(2);
    // Should be ordered by scraped_at ascending
    const t0 = new Date(body.metrics[0].scraped_at).getTime();
    const t1 = new Date(body.metrics[1].scraped_at).getTime();
    expect(t1).toBeGreaterThanOrEqual(t0);
  });

  it("returns 404 for non-existent post", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/metrics/doesnotexist",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/overview", () => {
  it("returns KPI aggregates", async () => {
    const res = await app.inject({ method: "GET", url: "/api/overview" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("total_impressions");
    expect(body).toHaveProperty("avg_engagement_rate");
    expect(body).toHaveProperty("total_followers");
    expect(body).toHaveProperty("profile_views");
    expect(body).toHaveProperty("posts_count");
  });
});

describe("GET /api/timing", () => {
  it("returns day/hour heatmap data", async () => {
    const res = await app.inject({ method: "GET", url: "/api/timing" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.slots)).toBe(true);
    // Each slot should have day, hour, avg_engagement_rate, post_count
    if (body.slots.length > 0) {
      expect(body.slots[0]).toHaveProperty("day");
      expect(body.slots[0]).toHaveProperty("hour");
      expect(body.slots[0]).toHaveProperty("avg_engagement_rate");
      expect(body.slots[0]).toHaveProperty("post_count");
    }
  });
});

describe("GET /api/followers", () => {
  it("returns follower time series with new_followers computed", async () => {
    // Ingest a second day of followers
    await app.inject({
      method: "POST",
      url: "/api/ingest",
      payload: { followers: { total_followers: 4860 } },
    });

    const res = await app.inject({ method: "GET", url: "/api/followers" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.snapshots)).toBe(true);
  });
});

describe("GET /api/profile", () => {
  it("returns profile views and search appearances time series", async () => {
    const res = await app.inject({ method: "GET", url: "/api/profile" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.snapshots)).toBe(true);
    if (body.snapshots.length > 0) {
      expect(body.snapshots[0]).toHaveProperty("profile_views");
      expect(body.snapshots[0]).toHaveProperty("search_appearances");
      expect(body.snapshots[0]).toHaveProperty("all_appearances");
    }
  });
});

describe("GET /api/posts/needs-content", () => {
  it("returns post IDs missing full_text", async () => {
    // Insert a post without full_text
    await app.inject({
      method: "POST",
      url: "/api/ingest",
      payload: {
        posts: [
          {
            id: "needs-content-1",
            content_type: "text",
            published_at: "2025-01-15T10:00:00+00:00",
          },
        ],
      },
    });
    // Insert a post WITH full_text
    await app.inject({
      method: "POST",
      url: "/api/ingest",
      payload: {
        posts: [
          {
            id: "needs-content-2",
            content_type: "text",
            published_at: "2025-01-15T10:00:00+00:00",
            full_text: "Already has content",
          },
        ],
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/posts/needs-content",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.post_ids).toContain("needs-content-1");
    expect(body.post_ids).not.toContain("needs-content-2");
  });
});

describe("GET /api/images/:postId/:index", () => {
  it("returns 404 when image doesn't exist", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/images/nonexistent/0",
    });
    expect(response.statusCode).toBe(404);
  });

  it("rejects path traversal attempts", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/images/..%2F..%2Fetc/0",
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects non-numeric index", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/images/some-post/abc",
    });
    expect(response.statusCode).toBe(400);
  });

  it("serves image when it exists", async () => {
    // Create a test image file in the expected location
    const dataDir = path.join(path.dirname(TEST_DB_PATH), "images");
    const postDir = path.join(dataDir, "serve-test");
    fs.mkdirSync(postDir, { recursive: true });
    fs.writeFileSync(path.join(postDir, "0.jpg"), Buffer.from([0xFF, 0xD8, 0xFF])); // JPEG magic bytes

    const response = await app.inject({
      method: "GET",
      url: "/api/images/serve-test/0",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/jpeg");

    // Cleanup
    fs.rmSync(postDir, { recursive: true, force: true });
  });
});

describe("CORS", () => {
  it("allows chrome-extension:// origins", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/health",
      headers: {
        origin: "chrome-extension://abcdef1234567890",
        "access-control-request-method": "GET",
      },
    });
    expect(
      res.headers["access-control-allow-origin"]
    ).toBe("chrome-extension://abcdef1234567890");
  });
});
