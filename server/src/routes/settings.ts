import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import {
  getSetting,
  upsertSetting,
  saveWritingPromptHistory,
  getWritingPromptHistory,
} from "../db/ai-queries.js";

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png"]);

// Validate that a timezone string is recognized by Intl
function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function registerSettingsRoutes(
  app: FastifyInstance,
  dataDir: string,
  db: Database.Database
): void {
  const photoPath = path.join(dataDir, "author-reference.jpg");

  // ── Author photo (unchanged) ───────────────────────────────

  app.get("/api/settings/author-photo", async (_request, reply) => {
    if (!fs.existsSync(photoPath)) {
      return reply.status(404).send({ error: "No author photo uploaded" });
    }
    return reply.type("image/jpeg").send(fs.readFileSync(photoPath));
  });

  app.post("/api/settings/author-photo", async (request, reply) => {
    const contentType = request.headers["content-type"] || "";
    if (contentType.includes("multipart/form-data")) {
      const data = await request.file();
      if (!data) return reply.status(400).send({ error: "No file provided" });
      if (!ALLOWED_TYPES.has(data.mimetype))
        return reply.status(400).send({ error: "Only JPEG and PNG files are allowed" });
      const chunks: Buffer[] = [];
      for await (const chunk of data.file) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      if (buffer.length > MAX_FILE_SIZE)
        return reply.status(400).send({ error: "File too large. Max 5MB." });
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(photoPath, buffer);
      return { ok: true };
    }
    if (!ALLOWED_TYPES.has(contentType.split(";")[0].trim()))
      return reply.status(400).send({ error: "Only JPEG and PNG files are allowed" });
    const body = request.body as Buffer;
    if (!body || body.length === 0)
      return reply.status(400).send({ error: "No file provided" });
    if (body.length > MAX_FILE_SIZE)
      return reply.status(400).send({ error: "File too large. Max 5MB." });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(photoPath, body);
    return { ok: true };
  });

  app.delete("/api/settings/author-photo", async () => {
    if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath);
    return { ok: true };
  });

  // ── Timezone ───────────────────────────────────────────────

  app.put("/api/settings/timezone", async (request, reply) => {
    const body = request.body as { timezone?: string };
    if (!body.timezone || typeof body.timezone !== "string") {
      return reply.status(400).send({ error: "timezone is required" });
    }
    if (!isValidTimezone(body.timezone)) {
      return reply.status(400).send({ error: "Invalid timezone" });
    }
    upsertSetting(db, "timezone", body.timezone);
    return { ok: true };
  });

  // ── Writing prompt ─────────────────────────────────────────

  app.get("/api/settings/writing-prompt", async () => {
    const text = getSetting(db, "writing_prompt");
    return { text: text ?? null };
  });

  app.put("/api/settings/writing-prompt", async (request, reply) => {
    const body = request.body as { text?: string; source?: string; evidence?: string };
    if (!body.text || typeof body.text !== "string") {
      return reply.status(400).send({ error: "text is required" });
    }
    const source = body.source ?? "manual_edit";
    upsertSetting(db, "writing_prompt", body.text);
    saveWritingPromptHistory(db, {
      prompt_text: body.text,
      source,
      evidence: body.evidence ?? null,
    });
    return { ok: true };
  });

  app.get("/api/settings/writing-prompt/history", async () => {
    return { history: getWritingPromptHistory(db) };
  });
}
