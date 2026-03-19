import { defineConfig } from "vite";
import { resolve } from "path";
import { copyFileSync, mkdirSync, readdirSync } from "fs";
import { build } from "vite";

// We need separate builds because:
// - Service worker: ES module format (declared "type": "module" in manifest)
// - Content script: Must be self-contained (no imports — Chrome injects it directly)
// - Popup: Must be self-contained (loaded via script tag, not as module)
//
// Using a single build with multiple inputs causes Rollup to extract shared code
// into separate chunks with import statements, which Chrome content scripts can't use.

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        "background/service-worker": resolve(
          __dirname,
          "src/background/service-worker.ts"
        ),
      },
      output: {
        entryFileNames: "[name].js",
        format: "es",
      },
    },
    target: "esnext",
    minify: false,
    sourcemap: true,
  },
  plugins: [
    {
      name: "build-content-and-popup",
      async closeBundle() {
        // Build content script as IIFE (self-contained, no imports)
        await build({
          configFile: false,
          build: {
            outDir: resolve(__dirname, "dist"),
            emptyOutDir: false,
            rollupOptions: {
              input: { "content/index": resolve(__dirname, "src/content/index.ts") },
              output: { entryFileNames: "[name].js", format: "iife" },
            },
            target: "esnext",
            minify: false,
            sourcemap: true,
            lib: undefined,
          },
        });

        // Build popup as IIFE
        await build({
          configFile: false,
          build: {
            outDir: resolve(__dirname, "dist"),
            emptyOutDir: false,
            rollupOptions: {
              input: { "popup/popup": resolve(__dirname, "src/popup/popup.ts") },
              output: { entryFileNames: "[name].js", format: "iife" },
            },
            target: "esnext",
            minify: false,
            sourcemap: true,
          },
        });

        // Copy static files
        copyFileSync(
          resolve(__dirname, "manifest.json"),
          resolve(__dirname, "dist/manifest.json")
        );
        mkdirSync(resolve(__dirname, "dist/popup"), { recursive: true });
        copyFileSync(
          resolve(__dirname, "src/popup/popup.html"),
          resolve(__dirname, "dist/popup/popup.html")
        );

        // Copy icons
        const iconsDir = resolve(__dirname, "icons");
        const distIconsDir = resolve(__dirname, "dist/icons");
        mkdirSync(distIconsDir, { recursive: true });
        for (const file of readdirSync(iconsDir)) {
          if (file.endsWith(".png")) {
            copyFileSync(resolve(iconsDir, file), resolve(distIconsDir, file));
          }
        }
      },
    },
  ],
});
