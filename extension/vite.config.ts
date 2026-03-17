import { defineConfig } from "vite";
import { resolve } from "path";
import { copyFileSync } from "fs";

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
        "content/index": resolve(__dirname, "src/content/index.ts"),
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
      name: "copy-manifest",
      closeBundle() {
        copyFileSync(
          resolve(__dirname, "manifest.json"),
          resolve(__dirname, "dist/manifest.json")
        );
      },
    },
  ],
});
