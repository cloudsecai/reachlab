import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { downloadPostImages } from "../ai/image-downloader.js";

const TEST_DIR = path.join(import.meta.dirname, "../../test-data-images");

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

test("downloadPostImages saves images and returns local paths", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
  });

  try {
    const paths = await downloadPostImages(
      "test-post-1",
      [
        "https://media.licdn.com/dms/image/test1.jpg",
        "https://media.licdn.com/dms/image/test2.jpg",
      ],
      TEST_DIR
    );

    expect(paths).toHaveLength(2);
    expect(paths[0]).toContain("test-post-1/0.jpg");
    expect(paths[1]).toContain("test-post-1/1.jpg");
    expect(
      fs.existsSync(path.join(TEST_DIR, "test-post-1", "0.jpg"))
    ).toBe(true);
    expect(
      fs.existsSync(path.join(TEST_DIR, "test-post-1", "1.jpg"))
    ).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("downloadPostImages retries on failure", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = vi.fn().mockImplementation(() => {
    attempts++;
    if (attempts < 3) return Promise.reject(new Error("Network error"));
    return Promise.resolve({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    });
  });

  try {
    const paths = await downloadPostImages(
      "retry-test",
      ["https://media.licdn.com/dms/image/retry.jpg"],
      TEST_DIR,
      [0, 0, 0]
    );
    expect(paths).toHaveLength(1);
    expect(attempts).toBe(3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("downloadPostImages returns empty array on total failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

  try {
    const paths = await downloadPostImages(
      "fail-test",
      ["https://media.licdn.com/dms/image/fail.jpg"],
      TEST_DIR,
      [0, 0, 0]
    );
    expect(paths).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
