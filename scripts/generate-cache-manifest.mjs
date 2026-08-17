#!/usr/bin/env node
// Postbuild step for the PWA service worker. Writes dist/cache-manifest.json
// listing every hashed build asset (JS/CSS/fonts/images under dist/assets/).
// The service worker fetches this file at install time and precaches the
// listed assets, so the app shell works fully offline after the FIRST load —
// a pure runtime cache can't do that, because on the first visit the SW
// registers after the page's own assets are already fetched and never sees
// them. Wired via "postbuild:web" in package.json.
import { readdirSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = path.join(REPO_ROOT, "dist");
const OUT_PATH = path.join(DIST_DIR, "cache-manifest.json");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

if (!statSync(DIST_DIR).isDirectory()) {
  console.error("dist/ not found — run `npm run build:web` first.");
  process.exit(1);
}

const assets = walk(path.join(DIST_DIR, "assets"))
  .map((file) => "/" + path.relative(DIST_DIR, file).split(path.sep).join("/"))
  .sort();

const manifest = {
  // The SW keys caches by VERSION in sw.js; bump VERSION there on release so
  // activate() cleans out caches from previous builds.
  generatedAt: new Date().toISOString(),
  count: assets.length,
  assets,
};

writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 2) + "\n");
console.log(`cache-manifest.json written: ${assets.length} hashed assets (${OUT_PATH})`);
