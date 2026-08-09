#!/usr/bin/env node
/**
 * Quran Trivia — batch question generator (GitHub Actions)
 *
 * Generates fresh Quran trivia questions with opencode.ai (big-pickle) and
 * writes them straight into the Firebase Realtime Database bank that the
 * game worker reads. Runs on a schedule (every 30 min) so the game never
 * runs out of questions.
 *
 * SOURCING: every question is based on the SGSS Quran — the simplified
 * easy-English presentation of the Sahih International translation at
 * https://github.com/Walusimbi-Leon1/sgss-quran
 * Each batch fetches random surahs straight from that repo (raw HTML),
 * extracts the verse text, and feeds it to the model as the source passage.
 * The model is instructed to answer ONLY from the passage + the surah it
 * came from, and to tag every question with its reference (surah:ayah).
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
 * The bank NEVER resets or shrinks (Leon's rule): every question ever
 * generated stays stored forever. Even if the game is badly behind, we just
 * append a big batch — nothing is ever deleted or rebuilt from scratch.
 *
 * Exit codes: 0 = ok (may be "nothing to do"), 1 = failure (workflow alert).
 */

const SLOT_DURATION = 20000; // 20s per question (matches worker)
const RUNWAY = 350; // target: bankLen − slot after a run
const MIN_ADD = 60; // skip unless we'd add at least this many
const CHUNK = 40; // questions per API call (reliable JSON output)
const MAX_TOKENS = 24000; // big budget: reasoning + passage + 40 questions fits
const USED_MAX = 600; // keep this many past questions (matches worker)
const AVOID_N = 40; // how many past questions to send as "do not repeat"
const MAX_ATTEMPTS = 8; // max API calls per run
const API_TIMEOUT_MS = 240000;

const BASE_URL = process.env.OPENCODE_BASE_URL || "https://opencode.ai/zen/v1";
const MODEL = process.env.MODEL || "big-pickle";
const FB_HOST = (process.env.FB_HOST || "bible-game-21-default-rtdb.firebaseio.com").replace(/^https?:\/\//, "");
const P = "quran/global"; // RTDB namespace path

const SGSS_RAW = "https://raw.githubusercontent.com/Walusimbi-Leon1/sgss-quran/main/books";

// The 114 surahs of the SGSS Quran, with their repo filenames.
// Al-Baqara is long (286 ayahs) but every surah is fair game — uniform
// random selection keeps the whole Quran in rotation.
const BOOKS = [
  "01-Al-Faatiha.html",
  "02-Al-Baqara.html",
  "03-Aal-i-Imraan.html",
  "04-An-Nisaa.html",
  "05-Al-Maaida.html",
  "06-Al-Anaam.html",
  "07-Al-Araaf.html",
  "08-Al-Anfaal.html",
  "09-At-Tawba.html",
  "10-Yunus.html",
  "11-Hud.html",
  "12-Yusuf.html",
  "13-Ar-Rad.html",
  "14-Ibrahim.html",
  "15-Al-Hijr.html",
  "16-An-Nahl.html",
  "17-Al-Israa.html",
  "18-Al-Kahf.html",
  "19-Maryam.html",
  "20-Taa-Haa.html",
  "21-Al-Anbiyaa.html",
  "22-Al-Hajj.html",
  "23-Al-Muminoon.html",
  "24-An-Noor.html",
  "25-Al-Furqaan.html",
  "26-Ash-Shuaraa.html",
  "27-An-Naml.html",
  "28-Al-Qasas.html",
  "29-Al-Ankaboot.html",
  "30-Ar-Room.html",
  "31-Luqman.html",
  "32-As-Sajda.html",
  "33-Al-Ahzaab.html",
  "34-Saba.html",
  "35-Faatir.html",
  "36-Yaseen.html",
  "37-As-Saaffaat.html",
  "38-Saad.html",
  "39-Az-Zumar.html",
  "40-Ghafir.html",
  "41-Fussilat.html",
  "42-Ash-Shura.html",
  "43-Az-Zukhruf.html",
  "44-Ad-Dukhaan.html",
  "45-Al-Jaathiya.html",
  "46-Al-Ahqaf.html",
  "47-Muhammad.html",
  "48-Al-Fath.html",
  "49-Al-Hujuraat.html",
  "50-Qaaf.html",
  "51-Adh-Dhaariyat.html",
  "52-At-Tur.html",
  "53-An-Najm.html",
  "54-Al-Qamar.html",
  "55-Ar-Rahmaan.html",
  "56-Al-Waaqia.html",
  "57-Al-Hadid.html",
  "58-Al-Mujaadila.html",
  "59-Al-Hashr.html",
  "60-Al-Mumtahana.html",
  "61-As-Saff.html",
  "62-Al-Jumua.html",
  "63-Al-Munaafiqoon.html",
  "64-At-Taghaabun.html",
  "65-At-Talaaq.html",
  "66-At-Tahrim.html",
  "67-Al-Mulk.html",
  "68-Al-Qalam.html",
  "69-Al-Haaqqa.html",
  "70-Al-Maaarij.html",
  "71-Nooh.html",
  "72-Al-Jinn.html",
  "73-Al-Muzzammil.html",
  "74-Al-Muddaththir.html",
  "75-Al-Qiyaama.html",
  "76-Al-Insaan.html",
  "77-Al-Mursalaat.html",
  "78-An-Naba.html",
  "79-An-Naaziaat.html",
  "80-Abasa.html",
  "81-At-Takwir.html",
  "82-Al-Infitaar.html",
  "83-Al-Mutaffifin.html",
  "84-Al-Inshiqaaq.html",
  "85-Al-Burooj.html",
  "86-At-Taariq.html",
  "87-Al-Alaa.html",
  "88-Al-Ghaashiya.html",
  "89-Al-Fajr.html",
  "90-Al-Balad.html",
  "91-Ash-Shams.html",
  "92-Al-Lail.html",
  "93-Ad-Dhuhaa.html",
  "94-Ash-Sharh.html",
  "95-At-Tin.html",
  "96-Al-Alaq.html",
  "97-Al-Qadr.html",
  "98-Al-Bayyina.html",
  "99-Az-Zalzala.html",
  "100-Al-Aadiyaat.html",
  "101-Al-Qaaria.html",
  "102-At-Takaathur.html",
  "103-Al-Asr.html",
  "104-Al-Humaza.html",
  "105-Al-Fil.html",
  "106-Quraish.html",
  "107-Al-Maaun.html",
  "108-Al-Kawthar.html",
  "109-Al-Kaafiroon.html",
  "110-An-Nasr.html",
  "111-Al-Masad.html",
  "112-Al-Ikhlaas.html",
  "113-Al-Falaq.html",
  "114-An-Naas.html",
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

// ── SGSS Quran sourcing ─────────────────────────────────────────────────────
// Surahs are single HTML files: <div class="chapter"><h2>Surah N</h2>
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
    .replace(/([a-z])([A-Z])/g, "$1 $2") // AlFaatiha → Al Faatiha
    .replace(/(\d)([A-Za-z])/g, "$1 $2"); // 1Samuel → 1 Samuel (no space variant)
  const chapters = [];
  const chapterBlocks = html.split('<div class="chapter">');
  for (const block of chapterBlocks.slice(1)) {
    const chMatch = block.match(/<h2>Surah\s+(\d+)<\/h2>/i);
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
 * Fetch a random surah from the SGSS Quran.
 * Returns { book, chapter, verses: [{v, text}] } or null on failure.
 */
async function fetchRandomChapter() {
  const file = BOOKS[Math.floor(Math.random() * BOOKS.length)];
  const res = await fetch(`${SGSS_RAW}/${file}`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`sgss-quran fetch ${file} → ${res.status}`);
  const html = await res.text();
  const { bookName, chapters } = parseBook(html, file);
  if (!chapters.length) throw new Error(`no chapters parsed from ${file}`);
  const ch = chapters[Math.floor(Math.random() * chapters.length)];
  console.log(`  source: Surah ${bookName} (${ch.verses.length} ayahs)`);
  return { book: bookName, chapter: ch.chapter, verses: ch.verses };
}

function passageToText(passage, maxVerses = 45) {
  const verses = passage.verses.slice(0, maxVerses);
  const lines = verses.map((v) => `${v.v}. ${v.text}`);
  return `Surah ${passage.chapter}: ${passage.book} (SGSS Quran — simple easy-English, Sahih International)\n${lines.join("\n")}`;
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
  const prompt = `You are generating questions for a Quran trivia game. Everything must come from the SGSS Quran (the Sahih International translation in simple, easy English).

SOURCE PASSAGE (from the SGSS Quran):
${passageText}

Generate ${count} unique Quran trivia questions based on this passage and the surah it comes from. Mix:
- Direct questions about what the passage says (Allah, prophets, people, places, events, teachings, numbers)
- Broader questions about this surah of the Quran and its key themes/stories
- Some well-known cross-references when the passage connects to a famous Quranic story or verse

Rules:
- Every question must have a clear, factual answer from the Quran (use the Sahih International text as truth)
- Vary difficulty from easy to hard
- For every question include a "ref" — the Quran reference like "Al-Baqara 2:255" or "Surah 2:255" or "Al-Faatiha 1" — that a player could look up to verify the answer. Prefer references from the source passage or its surah.
- Do NOT invent verses or misquote references. If unsure of an exact verse, use the surah name only (e.g. "Yusuf").
- Respect Islamic content sensitivities: keep questions respectful and accurate.
${avoid}
Return ONLY a JSON array (no markdown, no reasoning text) with exactly this structure:
[{"question":"Question text?","options":["A","B","C","D"],"correctAnswer":0,"ref":"Al-Baqara 2:255"}]
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
            "You are a Quran trivia question generator. Generate accurate, engaging Quran trivia questions with exactly 4 answer options and one correct answer, each tagged with its Quran reference. Always respond with valid JSON only — no markdown, no extra text.",
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

async function generateFresh(want, usedTexts, onChunk) {
  const out = [];
  let attempt = 0;
  while (out.length < want && attempt < MAX_ATTEMPTS) {
    attempt += 1;
    let batch = [];
    // Transient API failures (empty content, 5xx, timeout) → retry with backoff.
    // Without this, one flaky call aborted the whole run and lost every chunk.
    for (let retry = 0; retry < 3 && !batch.length; retry++) {
      try {
        const passage = await fetchRandomChapter();
        const passageText = passageToText(passage);
        const avoid = usedTexts.slice(0, AVOID_N);
        batch = await generateChunk(Math.min(CHUNK, want - out.length), passageText, avoid, attempt);
        console.log(`  chunk ${attempt}: ${batch.length} questions from ${passage.book} (${passage.chapter})`);
      } catch (err) {
        if (retry === 2) throw err;
        console.log(`  chunk ${attempt} failed (${err.message}) — retry ${retry + 1}/2 in ${20 * (retry + 1)}s`);
        await new Promise((r) => setTimeout(r, 20000 * (retry + 1)));
      }
    }
    for (const item of batch) out.push(item);
    // Persist each chunk as it completes — partial progress survives failures.
    if (onChunk) await onChunk(batch);
    if (batch.length === 0) break;
  }
  return out;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const now = Date.now();

  // Game state (bankLen + slot derived from questionStart) — the worker keeps
  // the authoritative `bankLen`; meta has the generating lock + used list.
  const game = (await fbGet(`${P}/game`)) || {};
  const meta = (await fbGet(`${P}/meta`)) || {};
  const bank = (await fbGet(`${P}/bank`)) || {};
  const bankArr = Array.isArray(bank) ? bank : Object.keys(bank).map((k) => bank[k]).filter(Boolean);
  const bankLen = Number(game.bankLen || bankArr.length || 0);
  const slot = game.questionStart ? Math.floor((now - Number(game.questionStart)) / SLOT_DURATION) : 0;
  const margin = bankLen - slot;
  const used = Array.isArray(meta.used) ? meta.used : [];
  console.log(JSON.stringify({ bankLen, slot, margin, used: used.length, questionStart: game.questionStart, mode: "—" }));

  if (meta.generating && now - Number(meta.generating) < 15 * 60 * 1000) {
    console.log("Another generation is in progress (lock fresh) — skipping.");
    return;
  }

  let bankData;
  const want = Math.max(0, Math.min(RUNWAY - margin, 350));

  if (want < MIN_ADD) {
    console.log(`Bank healthy (margin ${margin}); nothing to add.`);
    await fbPatch(`${P}/meta`, { generating: 0 });
    return;
  }

  // ── APPEND ─────────────────────────────────────────────────────────────
  console.log(`Mode: APPEND — generating up to ${want} questions...`);
  const fresh = await generateFresh(want, used);
  if (fresh.length < MIN_ADD) {
    console.log(`Only ${fresh.length} fresh questions; skipping append.`);
    await fbPatch(`${P}/meta`, { generating: 0 });
    return;
  }

  const existing = bankArr;
  bankData = normalizeBank(existing.concat(fresh));

  // Write bank as a JSON object with numeric keys (avoids Firebase array
  // coercion quirks at large sizes; the worker handles both shapes).
  const obj = {};
  for (let i = 0; i < bankData.length; i++) obj[i] = bankData[i];
  await fbPut(`${P}/bank`, obj);

  if (game && game.questionStart) {
    await fbPatch(`${P}/game`, { bankLen: bankData.length });
  } else {
    // First-ever seed: start the question clock too.
    await fbPut(`${P}/game`, {
      bankLen: bankData.length,
      questionStart: now,
      slotDuration: SLOT_DURATION,
      startedAt: now,
    });
  }
  const newUsed = fresh.map((q) => q.question).concat(used).slice(0, USED_MAX);
  await fbPatch(`${P}/meta`, { generating: 0, used: newUsed });
  console.log(`APPEND done: ${fresh.length} added (bank ${bankLen} → ${bankData.length}).`);
}


// ── Answer-letter randomization (matches worker) ────────────────────────────
function reshuffle(q, forbidden) {
  if (!q || !Array.isArray(q.options) || q.options.length < 2) return q;
  const options = q.options.slice();
  const n = options.length;
  const ci = Number.isInteger(q.correctAnswer) && q.correctAnswer >= 0 && q.correctAnswer < n ? q.correctAnswer : 0;
  const correct = options[ci];
  let candidates = [];
  for (let i = 0; i < n; i++) if (!forbidden.has(i)) candidates.push(i);
  if (!candidates.length) candidates = Array.from({ length: n }, (_, i) => i);
  const target = candidates[Math.floor(Math.random() * candidates.length)];
  const others = options.filter((_, i) => i !== ci);
  for (let i = others.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [others[i], others[j]] = [others[j], others[i]];
  }
  const out = new Array(n);
  out[target] = correct;
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (i === target) continue;
    out[i] = others[k++];
  }
  return { question: q.question, options: out, correctAnswer: target };
}

function normalizeBank(arr) {
  if (!Array.isArray(arr) || !arr.length) return arr;
  const out = arr.map((q) => ({ ...q, options: Array.isArray(q.options) ? q.options.slice() : q.options }));
  out[0] = reshuffle(out[0], new Set());
  for (let i = 1; i < out.length; i++) {
    out[i] = reshuffle(out[i], new Set([out[i - 1].correctAnswer]));
  }
  const n = out.length;
  if (n > 1 && out[n - 1].correctAnswer === out[0].correctAnswer) {
    out[n - 1] = reshuffle(out[n - 1], new Set([out[n - 2].correctAnswer, out[0].correctAnswer]));
  }
  return out;
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
