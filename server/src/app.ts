import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { initDatabase } from "./db/index.js";
import {
  upsertPost,
  insertPostMetrics,
  upsertFollowerSnapshot,
  upsertProfileSnapshot,
  logScrape,
  postExists,
  queryPosts,
  queryMetrics,
  queryOverview,
  queryTiming,
  queryFollowers,
  queryProfile,
  queryHealth,
} from "./db/queries.js";
import { ingestPayloadSchema } from "./schemas.js";
import multipart from "@fastify/multipart";
import { registerInsightsRoutes } from "./routes/insights.js";
import { registerSettingsRoutes } from "./routes/settings.js";

export function buildApp(dbPath: string) {
  const app = Fastify({ logger: false });
  const db = initDatabase(dbPath);

  app.register(cors, {
    origin: (origin, cb) => {
      if (
        !origin ||
        origin.startsWith("chrome-extension://") ||
        origin.startsWith("http://localhost")
      ) {
        cb(null, true);
      } else {
        cb(null, false);
      }
    },
  });

  app.addHook("onClose", () => {
    db.close();
  });

  // Health
  app.get("/api/health", async () => {
    return queryHealth(db);
  });

  // Sync state — stored server-side so extension reinstalls don't trigger full re-scrape
  app.get("/api/sync-state", async () => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'last_sync_at'").get() as { value: string } | undefined;
    return { last_sync_at: row?.value ? Number(row.value) : null };
  });

  app.put("/api/sync-state", async (request) => {
    const body = request.body as { last_sync_at: number };
    db.prepare("INSERT INTO settings (key, value) VALUES ('last_sync_at', ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP")
      .run(String(body.last_sync_at), String(body.last_sync_at));
    return { ok: true };
  });

  // Ingest
  app.post("/api/ingest", async (request, reply) => {
    const parseResult = ingestPayloadSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        ok: false,
        error: parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "),
      });
    }

    const payload = parseResult.data;
    let postsUpserted = 0;
    let metricsInserted = 0;
    const errors: string[] = [];

    let postsStatus = "pending";
    let followersStatus = "pending";
    let profileStatus = "pending";

    // Upsert posts
    if (payload.posts) {
      try {
        for (const post of payload.posts) {
          upsertPost(db, post);
          postsUpserted++;
        }
        postsStatus = "success";
      } catch (e: any) {
        postsStatus = "error";
        errors.push(`Posts upsert failed: ${e.message}`);
      }
    }

    // Insert metrics
    if (payload.post_metrics) {
      if (postsStatus === "pending") postsStatus = "success";
      for (const m of payload.post_metrics) {
        if (!postExists(db, m.post_id)) {
          errors.push(`Post ${m.post_id} does not exist, skipping metrics`);
          continue;
        }
        try {
          insertPostMetrics(db, m);
          metricsInserted++;
        } catch (e: any) {
          errors.push(`Metrics insert failed for ${m.post_id}: ${e.message}`);
        }
      }
      if (metricsInserted === 0 && payload.post_metrics.length > 0) {
        postsStatus = "error";
      }
    }

    // Followers
    if (payload.followers) {
      try {
        upsertFollowerSnapshot(db, payload.followers.total_followers);
        followersStatus = "success";
      } catch (e: any) {
        followersStatus = "error";
        errors.push(`Followers failed: ${e.message}`);
      }
    }

    // Profile
    if (payload.profile) {
      try {
        upsertProfileSnapshot(db, payload.profile);
        profileStatus = "success";
      } catch (e: any) {
        profileStatus = "error";
        errors.push(`Profile failed: ${e.message}`);
      }
    }

    // Log the scrape
    const errorDetails: Record<string, string> = {};
    if (errors.length > 0) {
      errorDetails.details = errors.join("; ");
    }

    logScrape(db, {
      posts_status: postsStatus,
      followers_status: followersStatus,
      profile_status: profileStatus,
      posts_count: postsUpserted,
      error_details: errors.length > 0 ? JSON.stringify(errorDetails) : null,
    });

    // Sync health check: detect post count anomalies
    if (payload.posts && payload.posts.length > 0) {
      const avgRow = db
        .prepare(
          `SELECT AVG(posts_count) as avg_count FROM (
             SELECT posts_count FROM scrape_log
             WHERE posts_count > 0
             ORDER BY id DESC LIMIT 10
           )`
        )
        .get() as { avg_count: number | null };

      if (avgRow.avg_count && payload.posts.length < avgRow.avg_count * 0.3) {
        const warning = `Post count anomaly: got ${payload.posts.length}, expected ~${Math.round(avgRow.avg_count)}. LinkedIn may have changed their page structure.`;
        console.warn(`[Sync Health] ${warning}`);
        // Use inline db.prepare since getSetting/upsertSetting are in ai-queries (dynamic import)
        db.prepare(
          `INSERT INTO settings (key, value) VALUES ('sync_warning', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
        ).run(JSON.stringify({
          message: warning,
          detected_at: new Date().toISOString(),
          expected: Math.round(avgRow.avg_count),
          actual: payload.posts.length,
        }));
      } else {
        // Clear warning if count looks normal
        db.prepare("DELETE FROM settings WHERE key = 'sync_warning'").run();
      }
    }

    // Staleness detection: newest scraped post shouldn't be much older than expected
    if (payload.posts && payload.posts.length > 0) {
      const postsWithDate = payload.posts.filter((p): p is typeof p & { published_at: string } => !!p.published_at);
      if (postsWithDate.length === 0) {
        db.prepare("DELETE FROM settings WHERE key = 'sync_stale_warning'").run();
      } else {
      const newestPost = postsWithDate.reduce((a, b) =>
        new Date(a.published_at) > new Date(b.published_at) ? a : b
      );
      const newestAge = Date.now() - new Date(newestPost.published_at).getTime();
      const twoDaysMs = 48 * 60 * 60 * 1000;

      // Check average posting frequency from DB
      const freqRow = db
        .prepare(
          `SELECT COUNT(*) as count FROM posts
           WHERE published_at > datetime('now', '-30 days')`
        )
        .get() as { count: number };

      // If user posts frequently (>2/week) but newest scraped post is >48h old, warn
      if (freqRow.count >= 8 && newestAge > twoDaysMs) {
        const warning = `Stale sync: newest scraped post is ${Math.round(newestAge / 3600000)}h old, but you typically post ${freqRow.count} times/month. A recent post may be missing.`;
        console.warn(`[Sync Health] ${warning}`);
        db.prepare(
          `INSERT INTO settings (key, value) VALUES ('sync_stale_warning', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
        ).run(JSON.stringify({
          message: warning,
          detected_at: new Date().toISOString(),
          newest_post_age_hours: Math.round(newestAge / 3600000),
        }));
      } else {
        db.prepare("DELETE FROM settings WHERE key = 'sync_stale_warning'").run();
      }
      } // end else (postsWithDate.length > 0)
    }

    // Auto-download author profile photo if provided
    if (payload.author_photo_url) {
      const photoDir = path.dirname(dbPath);
      const photoPath = path.join(photoDir, "author-reference.jpg");
      // Only download if we don't already have one
      if (!fs.existsSync(photoPath)) {
        fetch(payload.author_photo_url)
          .then(async (res) => {
            if (!res.ok) return;
            const buffer = Buffer.from(await res.arrayBuffer());
            if (buffer.length > 0) {
              fs.mkdirSync(photoDir, { recursive: true });
              fs.writeFileSync(photoPath, buffer);
              console.log("[Author Photo] Downloaded profile photo from LinkedIn");
            }
          })
          .catch((err: any) => {
            console.error("[Author Photo] Download failed:", err.message);
          });
      }
    }

    // Auto-trigger image downloads for posts with image_urls
    if (payload.posts) {
      const postsWithImages = payload.posts.filter(
        (p) => p.image_urls && p.image_urls.length > 0
      );
      if (postsWithImages.length > 0) {
        // Fire and forget — don't block the response
        import("./ai/image-downloader.js").then(({ downloadPostImages }) => {
          const dataDir = path.join(path.dirname(dbPath), "images");
          for (const post of postsWithImages) {
            // Check if already downloaded
            const existing = db
              .prepare("SELECT image_local_paths FROM posts WHERE id = ?")
              .get(post.id) as { image_local_paths: string | null } | undefined;
            if (existing?.image_local_paths) continue;

            downloadPostImages(post.id, post.image_urls!, dataDir).then((paths) => {
              if (paths.length > 0) {
                db.prepare("UPDATE posts SET image_local_paths = ? WHERE id = ?").run(
                  JSON.stringify(paths),
                  post.id
                );
              }
            }).catch((err: any) => {
              console.error(`[Image Download] Failed for ${post.id}:`, err.message);
            });
          }
        }).catch(() => {});
      }
    }

    // Auto-trigger video transcription for video posts with URLs
    if (payload.posts?.some((p) => p.video_url)) {
      import("./ai/video-transcriber.js").then(({ transcribeAllPending }) => {
        const dataDir = path.dirname(dbPath);
        transcribeAllPending(db, dataDir).catch((err: any) => {
          console.error("[Transcribe] Auto-transcription failed:", err.message);
        });
      }).catch(() => {});
    }

    // Auto-trigger AI pipeline (two-tier)
    const aiApiKey = process.env.TRUSTMIND_LLM_API_KEY;
    if (aiApiKey && postsUpserted > 0) {
      Promise.all([
        import("./ai/orchestrator.js"),
        import("./db/ai-queries.js"),
        import("./ai/client.js"),
      ]).then(([{ runTaggingPipeline, runFullPipeline }, { getPostCountWithMetrics, getLatestCompletedRun, getRunningRun, getSetting }, { createClient }]) => {
        if (getRunningRun(db)) return;
        const postCount = getPostCountWithMetrics(db);
        if (postCount < 10) return;

        const client = createClient(aiApiKey);

        // Always run cheap tagging pipeline on sync
        runTaggingPipeline(client, db, "sync_tagging").then(() => {
          // After tagging, check if full interpretation should run
          const schedule = getSetting(db, "auto_interpret_schedule") ?? "weekly";
          if (schedule === "off") return;

          // Only consider full pipeline runs (not tagging-only)
          const lastFullRun = db.prepare(
            "SELECT id, post_count, completed_at FROM ai_runs WHERE status = 'completed' AND triggered_by NOT LIKE '%tagging%' ORDER BY id DESC LIMIT 1"
          ).get() as { id: number; post_count: number; completed_at: string } | undefined;

          const newPosts = lastFullRun ? postCount - lastFullRun.post_count : postCount;
          if (newPosts < 1) return; // No new posts, skip

          // Check post threshold
          const postThreshold = parseInt(getSetting(db, "auto_interpret_post_threshold") ?? "5", 10);
          const postThresholdMet = newPosts >= postThreshold;

          // Check time threshold
          let timeThresholdMet = !lastFullRun; // Always run if never run before
          if (lastFullRun && schedule !== "off") {
            const lastRunTime = new Date(lastFullRun.completed_at + "Z").getTime();
            const now = Date.now();
            const msPerDay = 86400000;
            const interval = schedule === "daily" ? msPerDay : 7 * msPerDay;
            timeThresholdMet = (now - lastRunTime) >= interval;
          }

          if (postThresholdMet || timeThresholdMet) {
            runFullPipeline(client, db, "auto").catch((err: any) => {
              console.error("[AI Pipeline] Auto-trigger failed:", err.message);
            });
          }
        }).catch((err: any) => {
          console.error("[AI Pipeline] Auto-trigger failed:", err.message);
        });
      }).catch(() => {});
    }

    // Include posts needing scraping so the extension doesn't need separate API calls
    const needsContent = payload.posts
      ? (db.prepare("SELECT id FROM posts WHERE full_text IS NULL ORDER BY published_at DESC").all() as { id: string }[]).map(r => r.id)
      : undefined;
    const needsImages = payload.posts
      ? (db.prepare(
          `SELECT id FROM posts
           WHERE content_type IN ('image', 'carousel')
             AND (image_local_paths IS NULL OR image_local_paths = '[]')
             AND (image_urls IS NULL OR image_urls = '[]')
           ORDER BY published_at DESC`
        ).all() as { id: string }[]).map(r => r.id)
      : undefined;
    const needsVideoUrl = payload.posts
      ? (db.prepare(
          `SELECT id FROM posts
           WHERE content_type = 'video' AND video_url IS NULL
           ORDER BY published_at DESC`
        ).all() as { id: string }[]).map(r => r.id)
      : undefined;
    // Posts that have recent metrics (scraped within last 12 hours)
    const hasRecentMetrics = payload.posts
      ? (db.prepare(
          `SELECT DISTINCT post_id FROM post_metrics
           WHERE scraped_at > datetime('now', '-12 hours')`
        ).all() as { post_id: string }[]).map(r => r.post_id)
      : undefined;

    return {
      ok: true,
      posts_upserted: postsUpserted,
      metrics_inserted: metricsInserted,
      ...(errors.length > 0 ? { errors } : {}),
      ...(needsContent ? { needs_content: needsContent } : {}),
      ...(needsImages ? { needs_images: needsImages } : {}),
      ...(needsVideoUrl ? { needs_video_url: needsVideoUrl } : {}),
      ...(hasRecentMetrics ? { has_recent_metrics: hasRecentMetrics } : {}),
    };
  });

  // Serve post images
  app.get("/api/images/:postId/:index", async (request, reply) => {
    const { postId, index } = request.params as { postId: string; index: string };

    // Validate params to prevent path traversal
    if (!/^[\w:.-]+$/.test(postId) || !/^\d+$/.test(index)) {
      return reply.status(400).send({ error: "Invalid path" });
    }

    const dataDir = path.resolve(path.dirname(dbPath), "images");
    const imagePath = path.resolve(dataDir, postId, `${index}.jpg`);

    // Containment check
    if (!imagePath.startsWith(dataDir + path.sep)) {
      return reply.status(400).send({ error: "Invalid path" });
    }

    if (!fs.existsSync(imagePath)) {
      return reply.status(404).send({ error: "Image not found" });
    }

    return reply.type("image/jpeg").send(fs.readFileSync(imagePath));
  });

  // Posts needing content scraping
  app.get("/api/posts/needs-content", async () => {
    const rows = db
      .prepare("SELECT id FROM posts WHERE full_text IS NULL ORDER BY published_at DESC")
      .all() as { id: string }[];
    return { post_ids: rows.map((r) => r.id) };
  });

  // Posts needing image scraping (visual content types with no downloaded images AND no URLs yet)
  app.get("/api/posts/needs-images", async () => {
    const rows = db
      .prepare(
        `SELECT id FROM posts
         WHERE content_type IN ('image', 'carousel')
           AND (image_local_paths IS NULL OR image_local_paths = '[]')
           AND (image_urls IS NULL OR image_urls = '[]')
         ORDER BY published_at DESC`
      )
      .all() as { id: string }[];
    return { post_ids: rows.map((r) => r.id) };
  });

  // Video posts needing video URL scraping
  app.get("/api/posts/needs-video-url", async () => {
    const rows = db
      .prepare(
        `SELECT id FROM posts
         WHERE content_type = 'video'
           AND video_url IS NULL
         ORDER BY published_at DESC`
      )
      .all() as { id: string }[];
    return { post_ids: rows.map((r) => r.id) };
  });

  // Top-performing posts (excluding announcements)
  app.get("/api/posts/top-examples", async (request) => {
    const q = request.query as any;
    const limit = q.limit ? Number(q.limit) : 10;

    const rows = db
      .prepare(
        `SELECT p.id, p.full_text, p.published_at, p.content_type,
          m.impressions, m.reactions, m.comments, m.reposts,
          CASE WHEN m.impressions > 0
            THEN CAST(COALESCE(m.reactions, 0) + COALESCE(m.comments, 0) + COALESCE(m.reposts, 0) AS REAL) / m.impressions
            ELSE NULL
          END AS engagement_rate
        FROM posts p
        LEFT JOIN post_metrics m ON m.post_id = p.id
          AND m.id = (SELECT MAX(id) FROM post_metrics WHERE post_id = p.id)
        LEFT JOIN ai_tags t ON t.post_id = p.id
        WHERE p.full_text IS NOT NULL
          AND LENGTH(p.full_text) >= 200
          AND m.impressions IS NOT NULL
          AND (t.post_category IS NULL OR t.post_category != 'announcement')
        ORDER BY m.impressions DESC
        LIMIT ?`
      )
      .all(limit) as any[];

    return { posts: rows };
  });

  // Posts
  app.get("/api/posts", async (request) => {
    const q = request.query as any;
    return queryPosts(db, {
      content_type: q.content_type,
      since: q.since,
      until: q.until,
      min_impressions: q.min_impressions != null ? Number(q.min_impressions) : undefined,
      sort_by: q.sort_by,
      sort_order: q.sort_order,
      offset: q.offset ? Number(q.offset) : undefined,
      limit: q.limit ? Number(q.limit) : undefined,
    });
  });

  // Metrics for a single post
  app.get("/api/metrics/:postId", async (request, reply) => {
    const { postId } = request.params as { postId: string };
    if (!postExists(db, postId)) {
      return reply.status(404).send({ error: "Post not found" });
    }
    const metrics = queryMetrics(db, postId);
    return { post_id: postId, metrics };
  });

  // Overview KPIs
  app.get("/api/overview", async (request) => {
    const q = request.query as any;
    return queryOverview(db, {
      since: q.since,
      until: q.until,
    });
  });

  // Timing heatmap
  app.get("/api/timing", async () => {
    const slots = queryTiming(db);
    return { slots };
  });

  // Followers
  app.get("/api/followers", async () => {
    const snapshots = queryFollowers(db);
    return { snapshots };
  });

  // Profile
  app.get("/api/profile", async () => {
    const snapshots = queryProfile(db);
    return { snapshots };
  });

  // AI Insights routes
  registerInsightsRoutes(app, db);

  // Settings routes (author photo upload/serve/delete)
  app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } });
  app.addContentTypeParser(
    ["image/jpeg", "image/png"],
    { parseAs: "buffer" },
    (_req: any, body: Buffer, done: (err: null, body: Buffer) => void) => {
      done(null, body);
    }
  );
  const dataDir = path.dirname(dbPath);
  registerSettingsRoutes(app, dataDir, db);

  // On startup, retry image downloads for posts that have URLs but no local files
  app.addHook("onReady", async () => {
    const postsNeedingDownload = db
      .prepare(
        `SELECT id, image_urls FROM posts
         WHERE image_urls IS NOT NULL AND image_urls != '[]'
           AND (image_local_paths IS NULL OR image_local_paths = '[]')`
      )
      .all() as { id: string; image_urls: string }[];

    if (postsNeedingDownload.length > 0) {
      console.log(`[Image Download] Retrying downloads for ${postsNeedingDownload.length} posts...`);
      import("./ai/image-downloader.js").then(({ downloadPostImages }) => {
        const imagesDir = path.join(path.dirname(dbPath), "images");
        for (const post of postsNeedingDownload) {
          const urls = JSON.parse(post.image_urls) as string[];
          downloadPostImages(post.id, urls, imagesDir).then((paths) => {
            if (paths.length > 0) {
              db.prepare("UPDATE posts SET image_local_paths = ? WHERE id = ?").run(
                JSON.stringify(paths),
                post.id
              );
            }
          }).catch((err: any) => {
            console.error(`[Image Download] Retry failed for ${post.id}:`, err.message);
          });
        }
      }).catch(() => {});
    }

    // Also auto-transcribe any video posts that need it
    import("./ai/video-transcriber.js").then(({ transcribeAllPending }) => {
      transcribeAllPending(db, dataDir).catch((err: any) => {
        console.error("[Transcribe] Startup transcription failed:", err.message);
      });
    }).catch(() => {});
  });

  // Serve dashboard static files
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const dashboardDir = path.join(__dirname, "../../dashboard/dist");
  if (fs.existsSync(dashboardDir)) {
    app.register(fastifyStatic, {
      root: dashboardDir,
      prefix: "/",
    });
    // SPA fallback — serve index.html for non-API routes
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.status(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
