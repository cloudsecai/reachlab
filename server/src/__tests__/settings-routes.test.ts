import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";
import fs from "fs";
import path from "path";

const TEST_DB_PATH = path.join(import.meta.dirname, "../../data/test-settings-routes.db");

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp(TEST_DB_PATH);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  try {
    fs.unlinkSync(TEST_DB_PATH);
    fs.unlinkSync(TEST_DB_PATH + "-wal");
    fs.unlinkSync(TEST_DB_PATH + "-shm");
  } catch {}
});

describe("PUT /api/settings/timezone", () => {
  it("stores timezone and returns ok", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/timezone",
      payload: { timezone: "America/Chicago" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("rejects invalid timezone", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/timezone",
      payload: { timezone: "Not/ATimezone" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/settings/writing-prompt", () => {
  it("returns null when not set", async () => {
    const res = await app.inject({ method: "GET", url: "/api/settings/writing-prompt" });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toBeNull();
  });
});

describe("PUT /api/settings/writing-prompt", () => {
  it("saves a writing prompt and returns ok", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/writing-prompt",
      payload: { text: "Always start with a hook", source: "manual_edit" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("retrieves the saved prompt", async () => {
    const res = await app.inject({ method: "GET", url: "/api/settings/writing-prompt" });
    expect(res.json().text).toBe("Always start with a hook");
  });
});

describe("GET /api/settings/writing-prompt/history", () => {
  it("returns history entries", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/settings/writing-prompt/history",
    });
    expect(res.statusCode).toBe(200);
    const history = res.json().history;
    expect(Array.isArray(history)).toBe(true);
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].source).toBe("manual_edit");
  });
});
