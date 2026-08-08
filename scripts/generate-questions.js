#!/usr/bin/env node
/**
 * Bible Trivia — batch question generator (GitHub Actions)
 *
 * Generates fresh Bible trivia questions with opencode.ai (big-pickle) and
 * writes them straight into the Firebase Realtime Database bank that the
 * game worker reads. Runs on a schedule (every 30 min) so the game never
 * runs out of questions.
 *
 * SOURCING: every question is based on the SGSS Bible — the simplified
 * easy-English KJV adaptation at https://github.com/Walusimbi-Leon1/sgss-bible
 * Each batch fetches random chapters straight from that repo (raw HTML),
 * extracts the verse text, and feeds it to the model as the source passage.
 * The model is instructed to answer ONLY from the passage + the Bible book
 * it came from, and to tag every question with its reference (book c:v).
 *
 * Why not generate in the worker? The worker's per-request generation gets
 * throttled/truncated (big-pickle is a reasoning model — it spends thousands
 * of tokens on hidden reasoning, so a 20-question JSON with max_tokens 4096
 * gets cut off). Batch generation here:
 *   - uses a big token budget and small chunks → valid JSON every time
 *   - runs from GitHub runners (fresh IPs, no rate-limit history)
 *   - top-ups the shared Firebase bank directly (public-writable RTDB)
 *
 * Bank math: the game clock runs 24/7 at 20s/question → drains ~180
 * questions/hour. This script keeps bankLen − currentSlot ≈ RUNWAY (350),
 * i.e. ~2 hours of runway. Scheduled every 30 min that's plenty of margin.
 *
 * Modes:
 *   - APPEND: bank is healthy-ish → generate `want` fresh questions, append
 *     at the end of the bank, bump game.bankLen.
 *   - RESET : game is badly behind (slot − bankLen > RESET_BEHIND) or has no
 *     clock → fresh bank + new questionStart (instant recovery from the
 *     "Preparing new questions…" stuck state). Player scores persist; only
 *     per-question answers are cleared.
 *
 * Exit codes: 0 = ok (may be "nothing to do"), 1 = failure (workflow alert).
 */

const SLOT_DURATION = 20000; // 20s per question (matches worker)
const RUNWAY = 350; // target: bankLen − slot after a run
const MIN_ADD = 60; // skip unless we'd add at least this many
const RESET_BEHIND = 150; // slot − bankLen above this → reset the clock
const CHUNK = 40; // questions per API call (reliable JSON output)
const MAX_TOKENS = 24000; // big budget: reasoning + passage + 40 questions fits
const USED_MAX = 600; // keep this many past questions (matches worker)
const AVOID_N = 40; // how many past questions to send as "do not repeat"
const MAX_ATTEMPTS = 8; // max API calls per run
const API_TIMEOUT_MS = 240000;

const BASE_URL = process.env.OPENCODE_BASE_URL || "https://opencode.ai/zen/v1";
const MODEL = process.env.MODEL || "big-pickle";
const FB_HOST = (process.env.FB_HOST || "bible-game-21-default-rtdb.firebaseio.com").replace(/^https?:\/\//, "");
const P = "bible/global"; // RTDB namespace path

const SGSS_RAW = "https://raw.githubusercontent.com/Walusimbi-Leon1/sgss-bible/main/books";

// The 66 books of the SGSS Bible, with their repo filenames.
// Psalms is long (150 chapters) and Revelation is poetic, but every book is
// fair game — uniform random selection keeps the whole Bible in rotation.
const BOOKS = [
  "01-Genesis.html", "02-Exodus.html", "03-Leviticus.html", "04-Numbers.html",
  "05-Deuteronomy.html", "06-Joshua.html", "07-Judges.html", "08-Ruth.html",
  "09-1Samuel.html", "10-2Samuel.html", "11-1Kings.html", "12-2Kings.html",
  "13-1Chronicles.html", "14-2Chronicles.html", "15-Ezra.html", "16-Nehemiah.html",
  "17-Esther.html", "18-Job.html", "19-Psalms.html", "20-Proverbs.html",
  "21-Ecclesiastes.html", "22-SongOfSolomon.html", "23-Isaiah.html", "24-Jeremiah.html",
  "25-Lamentations.html", "26-Ezekiel.html", "27-Daniel.html", "28-Hosea.html",
  "29-Joel.html", "30-Amos.html", "31-Obadiah.html", "32-Jonah.html",
  "33-Micah.html", "34-Nahum.html", "35-Habakkuk.html", "36-Zephaniah.html",
  "37-Haggai.html", "38-Zechariah.html", "39-Malachi.html", "40-Matthew.html",
  "41-Mark.html", "42-Luke.html", "43-John.html", "44-Acts.html",
  "45-Romans.html", "46-1Corinthians.html", "47-2Corinthians.html", "48-Galatians.html",
  "49-Ephesians.html", "50-Philippians.html", "51-Colossians.html", "52-1Thessalonians.html",
  "53-2Thessalonians.html", "54-1Timothy.html", "55-2Timothy.html", "56-Titus.html",
  "57-Philemon.html", "58-Hebrews.html", "59-James.html", "60-1Peter.html",
  "61-2Peter.html", "62-1John.html", "63-2John.html", "64-3John.html",
  "65-Jude.html", "66-Revelation.html",
];

const API_KEY = process.env.OPENCODE_API_KEY;
if (!API_KEY) {
  console.error("OPENCODE_API_KEY not set");
  process.exit(1);
}

// ── Firebase helpers ────────────────────────────────────────────────────────
const fbUrl = (path) => `https://${FB_HOST}/${path}.json`;

async function fbGet(path) {
  const res = await fetch(fbUrl(path), { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`fbGet ${path} → ${res.status}`);
  return res.json();
}
async function fbPut(path, data) {
  const res = await fetch(fbUrl(path), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`fbPut ${path} → ${res.status}`);
  return res.json();
}
async function fbPatch(path, data) {
  const res = await fetch(fbUrl(path), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`fbPatch ${path} → ${res.status}`);
  return res.json();
}
async function fbDelete(path) {
  const res = await fetch(fbUrl(path), {
    method: "DELETE",
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`fbDelete ${path} → ${res.status}`);
}

// ── SGSS Bible sourcing ─────────────────────────────────────────────────────
// Books are single HTML files: <div class="chapter"><h2>Chapter N</h2>
// <p class="verse"><span class="vnum">V</span> verse text</p>…
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function parseBook(html, fileName) {
  const titleMatch = fileName.match(/^\d+-([^.]+)\.html$/);
  const bookName = (titleMatch ? titleMatch[1] : fileName)
    .replace(/([a-z])([A-Z])/g, "$1 $2") // 1Samuel → 1 Samuel, SongOfSolomon → Song Of Solomon
    .replace(/(\d)([A-Za-z])/g, "$1 $2"); // 1Samuel → 1 Samuel (no space variant)
  const chapters = [];
  const chapterBlocks = html.split('<div class="chapter">');
  for (const block of chapterBlocks.slice(1)) {
    const chMatch = block.match(/<h2>Chapter\s+(\d+)<\/h2>/i);
    if (!chMatch) continue;
    const verses = [];
    const verseRe = /<p class="verse"><span class="vnum">(\d+)<\/span>([\s\S]*?)<\/p>/g;
    let m;
    while ((m = verseRe.exec(block)) !== null) {
      const text = decodeEntities(m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
      if (text) verses.push({ v: Number(m[1]), text });
    }
    if (verses.length) chapters.push({ chapter: Number(chMatch[1]), verses });
  }
  return { bookName, chapters };
}

/**
 * Fetch a random chapter from a random book of the SGSS Bible.
 * Returns { book, chapter, verses: [{v, text}] } or null on failure.
 */
async function fetchRandomChapter() {
  const file = BOOKS[Math.floor(Math.random() * BOOKS.length)];
  const res = await fetch(`${SGSS_RAW}/${file}`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`sgss-bible fetch ${file} → ${res.status}`);
  const html = await res.text();
  const { bookName, chapters } = parseBook(html, file);
  if (!chapters.length) throw new Error(`no chapters parsed from ${file}`);
  const ch = chapters[Math.floor(Math.random() * chapters.length)];
  console.log(`  source: ${bookName} chapter ${ch.chapter} (${ch.verses.length} verses)`);
  return { book: bookName, chapter: ch.chapter, verses: ch.verses };
}

function passageToText(passage, maxVerses = 45) {
  const verses = passage.verses.slice(0, maxVerses);
  const lines = verses.map((v) => `${v.v}. ${v.text}`);
  return `${passage.book} ${passage.chapter} (SGSS Bible — simplified easy-English KJV)\n${lines.join("\n")}`;
}

// ── Question generation ─────────────────────────────────────────────────────
function norm(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function generateChunk(count, passageText, avoidTexts, attempt) {
  const avoid =
    avoidTexts && avoidTexts.length
      ? "\n\nHere are recently used questions. Do NOT repeat these or closely paraphrase them — make every question fresh and distinct:\n" +
        avoidTexts.map((t) => `- ${t}`).join("\n")
      : "";
  const prompt = `You are generating questions for a Bible trivia game. Everything must come from the SGSS Bible (a simplified, easy-English adaptation of the King James Version).

SOURCE PASSAGE (from the SGSS Bible):
${passageText}

Generate ${count} unique Bible trivia questions based on this passage and the Bible book it comes from. Mix:
- Direct questions about what the passage says (people, places, events, numbers, teachings)
- Broader questions about this book of the Bible and its key characters/stories
- Some well-known cross-references when the passage connects to a famous Bible story or verse

Rules:
- Every question must have a clear, factual answer from the Bible (use the KJV/SGSS text as truth)
- Vary difficulty from easy to hard
- For every question include a "ref" — the Bible reference like "John 3:16" or "Genesis 1" or "Psalm 23" — that a player could look up to verify the answer. Prefer references from the source passage or its book.
- Do NOT invent verses or misquote references. If unsure of an exact verse, use the book name only (e.g. "Proverbs").
${avoid}
Return ONLY a JSON array (no markdown, no reasoning text) with exactly this structure:
[{"question":"Question text?","options":["A","B","C","D"],"correctAnswer":0,"ref":"Book 3:16"}]
"correctAnswer" must be the index (0-3) of the correct option. "ref" is a short string.`;

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a Bible trivia question generator. Generate accurate, engaging Bible trivia questions with exactly 4 answer options and one correct answer, each tagged with its Bible reference. Always respond with valid JSON only — no markdown, no extra text.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.9,
      max_tokens: MAX_TOKENS,
    }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });

  if (res.status === 429) throw new Error(`rate limited (attempt ${attempt})`);
  if (!res.ok) throw new Error(`opencode.ai ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  let content = data?.choices?.[0]?.message?.content || "";
  if (!content.trim()) throw new Error("empty content from model");

  // Strip markdown fences if the model was stubborn
  const cleaned = content.replace(/```json\n?/gi, "").replace(/```\n?/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("no JSON array in response");

  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("response is not an array");

  const out = [];
  for (const q of parsed) {
    if (typeof q?.question !== "string" || !Array.isArray(q?.options) || q.options.length !== 4) continue;
    let a = q.correctAnswer;
    if (typeof a === "string") a = parseInt(a, 10);
    if (typeof a !== "number" || a < 0 || a > 3) continue;
    const item = { question: q.question, options: q.options.map(String), correctAnswer: a };
    if (typeof q.ref === "string" && q.ref.trim() && q.ref.length <= 80) item.ref = q.ref.trim();
    out.push(item);
  }
  return out;
}

async function generateFresh(want, usedTexts) {
  const avoidTexts = usedTexts.slice(-AVOID_N);
  const usedSet = new Set(usedTexts.map(norm));
  const accepted = [];
  const seen = new Set();
  let attempts = 0;

  while (accepted.length < want && attempts < MAX_ATTEMPTS) {
    attempts++;
    const n = Math.min(CHUNK, want - accepted.length);
    let batch;
    try {
      // Fresh random chapter per API call → wide Bible coverage across batches
      const passage = await fetchRandomChapter();
      const passageText = passageToText(passage);
      batch = await generateChunk(n, passageText, avoidTexts, attempts);
    } catch (err) {
      console.warn(`  chunk ${attempts}: ${err.message}`);
      if (attempts >= 3) await new Promise((r) => setTimeout(r, 5000 * attempts)); // back off on repeated failures
      continue;
    }
    const fresh = batch.filter((q) => {
      const key = norm(q.question);
      if (usedSet.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    accepted.push(...fresh);
    console.log(`  chunk ${attempts}: got ${batch.length} raw, ${fresh.length} fresh (total ${accepted.length}/${want})`);
  }
  return accepted;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const meta = (await fbGet(`${P}/meta`).catch(() => null)) || {};
  const game = (await fbGet(`${P}/game`).catch(() => null)) || {};
  const bank = (await fbGet(`${P}/bank`).catch(() => null)) || {};
  const usedRaw = Array.isArray(meta.used) ? meta.used : [];

  const len = Object.keys(bank).length;
  const now = Date.now();
  const slot = game.questionStart ? Math.floor((now - game.questionStart) / SLOT_DURATION) : 0;
  const margin = len - slot;

  console.log(
    JSON.stringify({ bankLen: len, slot, margin, used: usedRaw.length, questionStart: game.questionStart || null, mode: "—" })
  );

  const behind = slot - len;
  const mode = !game.questionStart || behind > RESET_BEHIND ? "RESET" : "APPEND";
  const want = mode === "RESET" ? Math.min(RUNWAY, 400) : Math.max(MIN_ADD, RUNWAY - margin);

  if (mode === "APPEND" && want < MIN_ADD) {
    console.log(`Bank healthy (margin ${margin} ≥ ${RUNWAY - MIN_ADD}) — nothing to do.`);
    return;
  }

  console.log(`Mode: ${mode} — generating up to ${want} questions...`);
  const fresh = await generateFresh(want, usedRaw);
  if (!fresh.length) throw new Error("generated 0 fresh questions after retries");

  // Lock the bank (worker honors meta.generating and won't top-up concurrently)
  await fbPut(`${P}/meta`, { generating: Date.now(), used: usedRaw });

  if (mode === "RESET") {
    const patch = {};
    fresh.forEach((q, i) => (patch[i] = q));
    await fbPut(`${P}/bank`, patch);
    await fbPut(`${P}/game`, {
      questionStart: Date.now(),
      slotDuration: SLOT_DURATION,
      bankLen: fresh.length,
      startedAt: now,
    });
    await fbDelete(`${P}/answers`).catch(() => {});
    console.log(`RESET done: fresh bank of ${fresh.length}, clock restarted.`);
  } else {
    const patch = {};
    fresh.forEach((q, i) => (patch[len + i] = q));
    await fbPatch(`${P}/bank`, patch);
    await fbPatch(`${P}/game`, { bankLen: len + fresh.length });
    console.log(`APPEND done: ${fresh.length} added (bank ${len} → ${len + fresh.length}).`);
  }

  // Record used (FIFO, capped)
  const newUsed = [...usedRaw, ...fresh.map((q) => q.question)].slice(-USED_MAX);
  await fbPut(`${P}/meta`, { generating: 0, used: newUsed });

  console.log("Done. New margin ≈", len + fresh.length - (mode === "RESET" ? 0 : slot));
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
