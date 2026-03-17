import fs from "fs";
import path from "path";

const MAX_RETRIES = 3;
export const RETRY_DELAYS_MS = [1000, 3000, 10000];

async function fetchWithRetry(
  url: string,
  retryDelays: number[] = RETRY_DELAYS_MS
): Promise<ArrayBuffer> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.arrayBuffer();
    } catch (err) {
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, retryDelays[attempt]));
        continue;
      }
      throw err;
    }
  }
  throw new Error("unreachable");
}

/**
 * Downloads images for a post and saves them to disk.
 * Returns array of local paths (relative to dataDir), or empty array on failure.
 */
export async function downloadPostImages(
  postId: string,
  imageUrls: string[],
  dataDir: string,
  retryDelays: number[] = RETRY_DELAYS_MS
): Promise<string[]> {
  const postDir = path.join(dataDir, postId);
  fs.mkdirSync(postDir, { recursive: true });

  const localPaths: string[] = [];

  for (let i = 0; i < imageUrls.length; i++) {
    const filename = `${i}.jpg`;
    const filePath = path.join(postDir, filename);
    const relativePath = path.join(postId, filename);

    try {
      const data = await fetchWithRetry(imageUrls[i], retryDelays);
      fs.writeFileSync(filePath, Buffer.from(data));
      localPaths.push(relativePath);
    } catch (err) {
      console.error(
        `[Image Download] Failed for post ${postId}, image ${i}: ${err instanceof Error ? err.message : err}`
      );
      // Skip this image, continue with others
    }
  }

  return localPaths;
}
