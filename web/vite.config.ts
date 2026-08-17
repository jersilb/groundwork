import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Frontend build for the Groundwork Worker: source lives in web/, built
// output goes to dist/ (gitignored), which wrangler serves via the
// [assets] binding in wrangler.toml. Static files (manifest.json, sw.js,
// icons) stay in public/ and are copied into dist by vite.
export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss()],
  publicDir: path.resolve(__dirname, "../public"),
  build: {
    outDir: path.resolve(__dirname, "../dist"),
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
  },
  server: {
    port: 5173,
    // During frontend dev, proxy API + WebSocket to wrangler dev (8787).
    proxy: {
      "/health": "http://localhost:8787",
      "/org": "http://localhost:8787",
      "/program": "http://localhost:8787",
      "/lab-session": "http://localhost:8787",
      "/initiative": "http://localhost:8787",
      "/review-cycle": "http://localhost:8787",
      "/session": { target: "ws://localhost:8787", ws: true },
      "/webhooks": "http://localhost:8787",
    },
  },
});
