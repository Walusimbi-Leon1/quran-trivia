#!/usr/bin/env node
/**
 * Quran Trivia — build script
 * Inlines all client assets (src/* + vendored Discord SDK) into
 * dist/worker.js as a STATIC map, ready for Cloudflare Workers deploy.
 *
 * Usage: node build.js   → writes dist/worker.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const SRC = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist");

const FILES = {
  "index.html": "index.html",
  "style.css": "style.css",
  "discord.js": "discord.js",
  "firebase.js": "firebase.js",
  "app.js": "app.js",
  "support.js": "support.js",
  "vendor/discord-sdk.mjs": "vendor/discord-sdk.mjs",
  "privacy.html": "privacy.html",
  "terms.html": "terms.html",
};

function read(name) {
  return fs.readFileSync(path.join(SRC, name), "utf8");
}

let worker = fs.readFileSync(path.join(ROOT, "worker.js"), "utf8");

for (const [key, file] of Object.entries(FILES)) {
  const placeholder = `__${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}__`;
  const content = read(file);
  if (!worker.includes(placeholder)) {
    console.error(`Missing placeholder ${placeholder} in worker.js`);
    process.exit(1);
  }
  // JSON.stringify gives us a safe JS string literal for every file.
  // (Must use a replacement FUNCTION — a string replacement would interpret
  //  $& / $' sequences inside the bundle as special patterns.)
  worker = worker.replace(placeholder, () => JSON.stringify(content));
}

// Any leftover placeholders?
const leftovers = worker.match(/__[A-Z0-9_]+__/g) || [];
if (leftovers.length) {
  console.error("Unresolved placeholders:", leftovers);
  process.exit(1);
}

fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, "worker.js"), worker);
const kb = (worker.length / 1024).toFixed(1);
console.log(`Built dist/worker.js (${kb} KB)`);
