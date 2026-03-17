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

  // Ingest
  app.post("/api/ingest", async (request, reply) => {
    const parseResult = ingestPayloadSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        ok: false,
        error: parseResult.error.issues.map((i) => i.message).join(", "),
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

    return {
      ok: true,
      posts_upserted: postsUpserted,
      metrics_inserted: metricsInserted,
      ...(errors.length > 0 ? { errors } : {}),
    };
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

  // Serve dashboard static files
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const dashboardDir = path.join(__dirname, "../../dashboard/dist");
  if (fs.existsSync(dashboardDir)) {
    app.register(fastifyStatic, {
      root: dashboardDir,
      prefix: "/",
      wildcard: false,
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
