/**
 * Bible Trivia — Cloudflare Worker
 *
 * Serves the whole game: static assets, Discord OAuth exchange,
 * question generation (opencode.ai / big-pickle), Firebase proxies.
 *
 * Game model (single GLOBAL room, time-sliced — see README):
 *  - bible/global/game    = { questionStart, slotDuration, bankLen, startedAt }
 *  - bible/global/bank/<i> = { question, options, correctAnswer, ref? }
 *  - bible/global/players/<uid> = { id, username, avatarUrl, score, lastSeen, online }  (persistent)
 *  - bible/global/answers/<slot>/<uid> = { answer, at }   (per-question answers)
 *  - bible/global/meta    = { generating: <ts>, used: [...] }  (bank lock + no-repeat list)
 *
 * All clients compute the current question deterministically:
 *   slot = floor((now - questionStart) / slotDuration)
 *   question = bank[slot % bank.length]
 *
 * Question sourcing: the GitHub Actions pipeline (scripts/generate-questions.js)
 * generates fresh Bible questions from the SGSS Bible repo every 30 minutes.
 * The worker's own AI generation is a fallback for when the bank is empty
 * (note: opencode.ai blocks Cloudflare Workers egress — error 1042 — so the
 * worker usually falls back to the built-in Bible bank below, which also
 * serves as the instant seed).
 */

const FB_DEFAULT_HOST = "bible-game-21-default-rtdb.firebaseio.com";
const SLOT_DURATION = 20000;   // 20 seconds per question
const BANK_BATCH = 20;         // questions generated per top-up
const BANK_MAX = 1000;         // reset bank above this size (raised: batch top-ups from GitHub Actions)
const TOP_UP_THRESHOLD = 20;   // top up when fewer than this many questions remain
const GEN_LOCK_MS = 45000;     // lock window for concurrent top-ups
const USED_MAX = 600;          // keep this many past questions in meta.used (FIFO)
const AVOID_PROMPT_N = 60;     // how many past questions to send to the AI as "do not repeat"

const P = "bible/global";      // RTDB namespace path

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

function notFound() {
  return new Response("Not found", { status: 404 });
}

// ── Firebase direct helpers (server side) ───────────────────────────────────
function fbUrl(env, path) {
  const host = (env.FB_HOST || FB_DEFAULT_HOST).replace(/^https?:\/\//, "");
  return `https://${host}/${path}.json`;
}

async function fbGet(env, path) {
  const res = await fetch(fbUrl(env, path));
  if (!res.ok) throw new Error(`fbGet ${path} → ${res.status}`);
  return res.json();
}

async function fbPut(env, path, data) {
  const res = await fetch(fbUrl(env, path), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`fbPut ${path} → ${res.status}`);
  return res.json();
}

async function fbPatch(env, path, data) {
  const res = await fetch(fbUrl(env, path), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`fbPatch ${path} → ${res.status}`);
  return res.json();
}

async function fbDelete(env, path) {
  const res = await fetch(fbUrl(env, path), { method: "DELETE" });
  if (!res.ok) throw new Error(`fbDelete ${path} → ${res.status}`);
  return res.json();
}

function bankCount(bank) {
  return bank && typeof bank === "object" ? Object.keys(bank).length : 0;
}

// Normalize a question for duplicate comparison (case/space/punct-insensitive).
function norm(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── "No repeats" bookkeeping ────────────────────────────────────────────────
async function readUsed(env) {
  const meta = (await fbGet(env, `${P}/meta`).catch(() => null)) || {};
  return Array.isArray(meta.used) ? meta.used : [];
}

async function markUsed(env, questions) {
  if (!questions || !questions.length) return;
  const meta = (await fbGet(env, `${P}/meta`).catch(() => null)) || {};
  const used = Array.isArray(meta.used) ? meta.used : [];
  for (const q of questions) {
    if (q?.question) used.push(q.question);
  }
  const trimmed = used.slice(-USED_MAX);
  await fbPatch(env, `${P}/meta`, { used: trimmed }).catch(() => {});
}

function filterFresh(questions, usedSet, bankSet) {
  const out = [];
  const seen = new Set();
  for (const q of questions) {
    if (!q?.question) continue;
    const n = norm(q.question);
    if (!n) continue;
    if (usedSet.has(n) || bankSet.has(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(q);
  }
  return out;
}

// ── Discord OAuth exchange (Arrow Blast pattern) ────────────────────────────
async function handleExchange(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let code;
  try {
    const body = await request.json();
    code = body && body.code;
  } catch {
    return json({ error: "Bad request — code required" }, 400);
  }
  if (!code || typeof code !== "string") return json({ error: "Bad request — code required" }, 400);

  const clientId = env.DISCORD_CLIENT_ID;
  const clientSecret = env.DISCORD_CLIENT_SECRET;
  const redirectUri = env.REDIRECT_URI;

  if (!clientId || !clientSecret) {
    return json({ error: "Server configuration error — DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET not set" }, 500);
  }

  try {
    const resp = await fetch("https://discord.com/api/v10/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      return json({ error: data.error, description: data.error_description }, resp.status);
    }
    return json({ access_token: data.access_token });
  } catch (err) {
    console.error("[Exchange] Internal error:", err.message);
    return json({ error: "Internal server error" }, 500);
  }
}

// ── Question generation via opencode.ai (big-pickle) ────────────────────────
async function generateWithOpenCode(prompt, env) {
  const apiKey = env.OPENCODE_API_KEY;
  if (!apiKey) throw new Error("OPENCODE_API_KEY not set");
  const model = env.MODEL || "big-pickle";
  const response = await fetch("https://opencode.ai/zen/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are a Bible trivia question generator. Generate accurate, engaging Bible trivia questions with exactly 4 answer options and one correct answer, each tagged with its Bible reference. Always respond with valid JSON only — no markdown, no extra text.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.9,
      max_tokens: 16384, // big-pickle is a reasoning model — 4096 was too small, JSON got truncated
    }),
  });
  if (!response.ok) throw new Error(`opencode.ai ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("opencode.ai empty response");
  return content;
}

function parseQuestions(raw, count) {
  const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("No JSON array in response");
  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("Response is not an array");
  const out = [];
  for (const q of parsed) {
    if (typeof q?.question !== "string" || !Array.isArray(q?.options) || q.options.length !== 4) continue;
    let a = q.correctAnswer;
    if (typeof a === "string") a = parseInt(a, 10);
    if (typeof a !== "number" || a < 0 || a > 3) continue;
    const item = { question: q.question, options: q.options.map(String), correctAnswer: a };
    if (typeof q.ref === "string" && q.ref.trim() && q.ref.length <= 80) item.ref = q.ref.trim();
    out.push(item);
    if (out.length >= count) break;
  }
  if (!out.length) throw new Error("No valid questions parsed");
  return out;
}

async function generateQuestions(count, env, avoidTexts) {
  const avoid =
    avoidTexts && avoidTexts.length
      ? "\n\nHere are recently used questions. Do NOT repeat these or closely paraphrase them — make every question fresh and distinct:\n" +
        avoidTexts
          .slice(-AVOID_PROMPT_N)
          .map((t) => `- ${t}`)
          .join("\n")
      : "";
  const prompt = `Generate ${count} unique Bible trivia questions. All questions must be based on the Bible (SGSS Bible — a simplified easy-English adaptation of the King James Version). Mix Old Testament and New Testament, covering people, places, events, teachings, parables, miracles, and well-known verses. Vary the difficulty.${avoid}
For every question include a "ref" — the Bible reference like "John 3:16" or "Genesis 1" or "Psalm 23" — that a player could look up to verify the answer. Do NOT invent verses or misquote references; if unsure of an exact verse, use the book name only (e.g. "Proverbs").
Return ONLY a JSON array (no markdown) with exactly this structure:
[{"question":"Question text?","options":["A","B","C","D"],"correctAnswer":0,"ref":"Book 3:16"}]
"correctAnswer" must be the index (0-3) of the correct option.`;
  const raw = await generateWithOpenCode(prompt, env);
  return parseQuestions(raw, count);
}

// ── Built-in Bible question bank (instant seed + fallback) ──────────────────
const CATEGORIES = ["old-testament", "new-testament", "life-of-jesus", "people", "places", "miracles", "teachings-parables", "psalms-prophets"];

const QUESTION_BANK = {
  "old-testament": [
    { q: "What is the first book of the Bible?", o: ["Genesis", "Exodus", "Leviticus", "Numbers"], a: 0, ref: "Genesis 1" },
    { q: "How many days did God use to create the world?", o: ["5", "6", "7", "10"], a: 1, ref: "Genesis 1" },
    { q: "Who built the ark to escape the flood?", o: ["Abraham", "Moses", "Noah", "David"], a: 2, ref: "Genesis 6" },
    { q: "Who was the first man created by God?", o: ["Adam", "Cain", "Enoch", "Seth"], a: 0, ref: "Genesis 2" },
    { q: "Who was Adam's wife?", o: ["Sarah", "Eve", "Rebekah", "Rachel"], a: 1, ref: "Genesis 3" },
    { q: "Who was the father of Isaac?", o: ["Jacob", "Abraham", "Lot", "Terah"], a: 1, ref: "Genesis 21" },
    { q: "Who was sold into slavery by his own brothers?", o: ["Joseph", "Benjamin", "Levi", "Simeon"], a: 0, ref: "Genesis 37" },
    { q: "In which land did Joseph become a ruler?", o: ["Canaan", "Babylon", "Egypt", "Assyria"], a: 2, ref: "Genesis 41" },
    { q: "Who was found as a baby in a basket on the Nile?", o: ["Aaron", "Moses", "Joshua", "Samuel"], a: 1, ref: "Exodus 2" },
    { q: "Through whom did God give the Ten Commandments?", o: ["Aaron", "Joshua", "Moses", "Elijah"], a: 2, ref: "Exodus 20" },
    { q: "How many commandments are there in the Ten Commandments?", o: ["7", "10", "12", "20"], a: 1, ref: "Exodus 20" },
    { q: "What was the first plague God sent on Egypt?", o: ["Frogs", "Darkness", "Water turned to blood", "Locusts"], a: 2, ref: "Exodus 7" },
    { q: "Which sea did Moses part so Israel could cross?", o: ["Red Sea", "Dead Sea", "Sea of Galilee", "Mediterranean"], a: 0, ref: "Exodus 14" },
    { q: "Who was the first king of Israel?", o: ["David", "Saul", "Solomon", "Jeroboam"], a: 1, ref: "1 Samuel 10" },
    { q: "Who defeated the giant Goliath?", o: ["Saul", "David", "Jonathan", "Abner"], a: 1, ref: "1 Samuel 17" },
    { q: "Who built the Temple in Jerusalem?", o: ["David", "Solomon", "Hezekiah", "Zerubbabel"], a: 1, ref: "1 Kings 6" },
    { q: "How many years did Israel wander in the wilderness?", o: ["10", "20", "40", "70"], a: 2, ref: "Numbers 14" },
    { q: "What food did God send from heaven in the wilderness?", o: ["Bread only", "Manna", "Quail only", "Honey"], a: 1, ref: "Exodus 16" },
    { q: "Who was swallowed by a great fish?", o: ["Peter", "Jonah", "Daniel", "Job"], a: 1, ref: "Jonah 1" },
    { q: "Whose walls fell down after the Israelites marched around them?", o: ["Jericho", "Ai", "Jerusalem", "Hebron"], a: 0, ref: "Joshua 6" },
    { q: "Who was the strongest man recorded in the Bible?", o: ["Gideon", "Samson", "Saul", "Abimelech"], a: 1, ref: "Judges 16" },
    { q: "Who was Ruth's mother-in-law?", o: ["Naomi", "Orpah", "Hannah", "Deborah"], a: 0, ref: "Ruth 1" },
    { q: "Who was the queen who saved the Jews from Haman's plot?", o: ["Jezebel", "Esther", "Vashti", "Bathsheba"], a: 1, ref: "Esther 4" },
    { q: "Which prophet was thrown into a den of lions?", o: ["Daniel", "Ezekiel", "Jeremiah", "Amos"], a: 0, ref: "Daniel 6" },
    { q: "Who interpreted Pharaoh's dreams about the seven years?", o: ["Daniel", "Joseph", "Moses", "Samuel"], a: 1, ref: "Genesis 41" },
    { q: "Which three friends survived the fiery furnace?", o: ["Shadrach, Meshach, Abednego", "Shadrach, Meshach, Azariah only", "Daniel, Meshach, Abednego", "Three guards"], a: 0, ref: "Daniel 3" },
    { q: "Who was the brother of Moses and first High Priest?", o: ["Aaron", "Miriam", "Korah", "Caleb"], a: 0, ref: "Exodus 28" },
    { q: "Which judge defeated the Midianites with only 300 men?", o: ["Samson", "Gideon", "Jephthah", "Barak"], a: 1, ref: "Judges 7" },
    { q: "Who anointed David as the next king of Israel?", o: ["Saul", "Samuel", "Eli", "Nathan"], a: 1, ref: "1 Samuel 16" },
    { q: "What river did Naaman wash in to be healed of leprosy?", o: ["Nile", "Euphrates", "Jordan", "Abana"], a: 2, ref: "2 Kings 5" },
    { q: "Who was taken up to heaven in a whirlwind?", o: ["Elisha", "Elijah", "Moses", "Enoch"], a: 1, ref: "2 Kings 2" },
    { q: "What is the first of the Ten Commandments?", o: ["Keep the Sabbath", "Honor your parents", "No other gods before Me", "Do not steal"], a: 2, ref: "Exodus 20" },
    { q: "How many books are in the Old Testament?", o: ["27", "39", "66", "12"], a: 1, ref: "Old Testament" },
    { q: "Who was the weeping prophet who wrote Lamentations?", o: ["Isaiah", "Jeremiah", "Hosea", "Joel"], a: 1, ref: "Jeremiah" },
    { q: "Who was the prophet that married an unfaithful wife as a sign?", o: ["Hosea", "Amos", "Jonah", "Malachi"], a: 0, ref: "Hosea 1" },
    { q: "Who saw a vision of a valley of dry bones?", o: ["Isaiah", "Ezekiel", "Daniel", "Zechariah"], a: 1, ref: "Ezekiel 37" },
    { q: "Which prophet wrote about the Suffering Servant?", o: ["Isaiah", "Micah", "Nahum", "Habakkuk"], a: 0, ref: "Isaiah 53" },
    { q: "Who was the last judge of Israel before the kings?", o: ["Eli", "Samuel", "Deborah", "Gideon"], a: 1, ref: "1 Samuel 7" },
    { q: "What happened when Israel marched around Jericho on the seventh day?", o: ["The walls fell", "It rained", "The sun stood still", "They surrendered"], a: 0, ref: "Joshua 6" },
    { q: "Who wrote most of the book of Psalms?", o: ["Solomon", "David", "Asaph", "Moses"], a: 1, ref: "Psalms" },
  ],
  "new-testament": [
    { q: "What is the first book of the New Testament?", o: ["Mark", "Matthew", "John", "Acts"], a: 1, ref: "Matthew" },
    { q: "How many Gospels are in the Bible?", o: ["2", "3", "4", "5"], a: 2, ref: "The Gospels" },
    { q: "What are the four Gospels?", o: ["Matthew, Mark, Luke, John", "Matthew, Mark, Luke, Acts", "John, Acts, Romans, Hebrews", "Peter, Paul, James, Jude"], a: 0, ref: "The Gospels" },
    { q: "How many books are in the New Testament?", o: ["27", "39", "66", "21"], a: 0, ref: "New Testament" },
    { q: "Who baptized Jesus?", o: ["John the Baptist", "Peter", "Andrew", "James"], a: 0, ref: "Matthew 3" },
    { q: "Who betrayed Jesus for thirty pieces of silver?", o: ["Peter", "Judas Iscariot", "Thomas", "Bartholomew"], a: 1, ref: "Matthew 26" },
    { q: "Who denied Jesus three times before the rooster crowed?", o: ["Peter", "John", "James", "Andrew"], a: 0, ref: "Luke 22" },
    { q: "How many apostles did Jesus choose?", o: ["10", "12", "14", "70"], a: 1, ref: "Luke 6" },
    { q: "Who replaced Judas Iscariot as an apostle?", o: ["Matthias", "Barnabas", "Silas", "Timothy"], a: 0, ref: "Acts 1" },
    { q: "Who wrote the Gospel of John?", o: ["John", "James", "Luke", "Mark"], a: 0, ref: "John" },
    { q: "Who wrote the book of Acts?", o: ["Luke", "Paul", "Peter", "Mark"], a: 0, ref: "Acts 1" },
    { q: "Who wrote the most letters in the New Testament?", o: ["Peter", "Paul", "John", "James"], a: 1, ref: "Paul's Epistles" },
    { q: "What is the last book of the Bible?", o: ["Jude", "Revelation", "3 John", "Hebrews"], a: 1, ref: "Revelation" },
    { q: "Who wrote the book of Revelation?", o: ["John", "Paul", "Peter", "Luke"], a: 0, ref: "Revelation 1" },
    { q: "Where was John when he wrote Revelation?", o: ["Patmos", "Rome", "Ephesus", "Corinth"], a: 0, ref: "Revelation 1" },
    { q: "What happened on the day of Pentecost?", o: ["The Holy Spirit came", "Jesus ascended", "The temple was built", "Paul was converted"], a: 0, ref: "Acts 2" },
    { q: "Who was the first Christian martyr?", o: ["Stephen", "James", "Peter", "Paul"], a: 0, ref: "Acts 7" },
    { q: "Who met Jesus on the road to Damascus?", o: ["Saul", "Cornelius", "Barnabas", "Philip"], a: 0, ref: "Acts 9" },
    { q: "What was Saul's name after his conversion?", o: ["Silas", "Paul", "Simon", "Sosthenes"], a: 1, ref: "Acts 13" },
    { q: "Which disciple was a tax collector before following Jesus?", o: ["Matthew", "Peter", "John", "Philip"], a: 0, ref: "Matthew 9" },
    { q: "Who was the Ethiopian official baptized by Philip?", o: ["A eunuch", "A centurion", "A pharisee", "A scribe"], a: 0, ref: "Acts 8" },
    { q: "Which book of the Bible is called the 'Love Chapter'?", o: ["1 Corinthians 13", "Romans 8", "Psalm 23", "John 3"], a: 0, ref: "1 Corinthians 13" },
    { q: "What does the word 'gospel' mean?", o: ["Good news", "Holy book", "New law", "Sacred song"], a: 0, ref: "The Gospels" },
    { q: "Who was the Roman governor who ordered Jesus' crucifixion?", o: ["Pilate", "Herod", "Caiaphas", "Felix"], a: 0, ref: "John 19" },
    { q: "Who helped Jesus carry His cross?", o: ["Simon of Cyrene", "Barabbas", "Joseph of Arimathea", "Nicodemus"], a: 0, ref: "Luke 23" },
    { q: "Who asked Pilate for Jesus' body to bury Him?", o: ["Joseph of Arimathea", "Nicodemus only", "Mary Magdalene", "Peter"], a: 0, ref: "Matthew 27" },
    { q: "How many times did Peter tell Jesus he would forgive a brother? (Jesus said 70×7)", o: ["Seven times", "Seventy times seven", "Twice", "Never"], a: 1, ref: "Matthew 18" },
    { q: "What did the men do when the roof blocked the paralyzed man from Jesus?", o: ["They carried him away", "They lowered him through the roof", "They waited outside", "They sent a servant"], a: 1, ref: "Mark 2" },
    { q: "Which book begins with 'In the beginning was the Word'?", o: ["Genesis", "John", "Matthew", "Hebrews"], a: 1, ref: "John 1" },
    { q: "Who said 'I am the way, the truth, and the life'?", o: ["Jesus", "Paul", "Peter", "Moses"], a: 0, ref: "John 14" },
    { q: "Which disciple doubted Jesus' resurrection until he saw the wounds?", o: ["Thomas", "Andrew", "Nathanael", "James"], a: 0, ref: "John 20" },
    { q: "Who was known as the 'beloved disciple'?", o: ["John", "Peter", "James", "Matthew"], a: 0, ref: "John 13" },
    { q: "Which two disciples were brothers and fishermen?", o: ["Peter and Andrew", "James and John", "Matthew and Thomas", "Philip and Bartholomew"], a: 0, ref: "Matthew 4" },
    { q: "What did Zacchaeus climb to see Jesus?", o: ["A sycamore tree", "A wall", "A rooftop", "A mountain"], a: 0, ref: "Luke 19" },
    { q: "Who was the governor that asked 'What is truth?'", o: ["Pilate", "Herod", "Festus", "Gallio"], a: 0, ref: "John 18" },
    { q: "Who was Paul's companion on his first missionary journey?", o: ["Barnabas", "Timothy", "Silas", "Luke"], a: 0, ref: "Acts 13" },
    { q: "Who was the young man who traveled with Paul and was his 'son in the faith'?", o: ["Timothy", "Titus", "Mark", "Apollos"], a: 0, ref: "1 Timothy 1" },
    { q: "Which church did Paul write to about love being the greatest gift?", o: ["Corinth", "Rome", "Ephesus", "Philippi"], a: 0, ref: "1 Corinthians 13" },
    { q: "What is the fruit of the Spirit according to Galatians 5?", o: ["Love, joy, peace", "Faith, works, miracles", "Power, wealth, wisdom", "Patience only"], a: 0, ref: "Galatians 5" },
    { q: "Who was the first Gentile convert baptized with his whole household?", o: ["Cornelius", "Lydia", "The jailer", "Barnabas"], a: 0, ref: "Acts 10" },
  ],
  "life-of-jesus": [
    { q: "In which town was Jesus born?", o: ["Nazareth", "Bethlehem", "Jerusalem", "Capernaum"], a: 1, ref: "Matthew 2" },
    { q: "Who was the mother of Jesus?", o: ["Mary", "Martha", "Elizabeth", "Anna"], a: 0, ref: "Luke 1" },
    { q: "Who was the earthly father of Jesus?", o: ["Joseph", "Zechariah", "Simon", "Cleopas"], a: 0, ref: "Matthew 1" },
    { q: "Who announced to Mary that she would bear a son?", o: ["The angel Gabriel", "The angel Michael", "Elizabeth", "A prophet"], a: 0, ref: "Luke 1" },
    { q: "Where did Jesus grow up?", o: ["Nazareth", "Bethlehem", "Jericho", "Capernaum"], a: 0, ref: "Matthew 2" },
    { q: "How many days did Jesus fast in the wilderness?", o: ["7", "21", "40", "50"], a: 2, ref: "Matthew 4" },
    { q: "Who tempted Jesus in the wilderness?", o: ["Satan", "Pharisees", "Herod", "Judas"], a: 0, ref: "Matthew 4" },
    { q: "Where was Jesus baptized?", o: ["Jordan River", "Sea of Galilee", "Nile River", "Pool of Siloam"], a: 0, ref: "Matthew 3" },
    { q: "At what age did Jesus discuss with the teachers in the temple?", o: ["10", "12", "16", "30"], a: 1, ref: "Luke 2" },
    { q: "How old was Jesus when He began His ministry?", o: ["About 30", "About 25", "About 33", "About 40"], a: 0, ref: "Luke 3" },
    { q: "What did Jesus turn water into at the wedding in Cana?", o: ["Wine", "Milk", "Oil", "Honey"], a: 0, ref: "John 2" },
    { q: "What was Jesus' first miracle?", o: ["Water to wine", "Feeding 5000", "Calming the storm", "Healing a leper"], a: 0, ref: "John 2" },
    { q: "Where was Jesus crucified?", o: ["Golgotha", "Mount Zion", "Bethany", "Gethsemane"], a: 0, ref: "John 19" },
    { q: "What was written on the sign above Jesus' cross?", o: ["King of the Jews", "Son of God", "The Nazarene", "Savior of Israel"], a: 0, ref: "John 19" },
    { q: "On which day of the week did Jesus rise from the dead?", o: ["Sunday", "Saturday", "Friday", "Monday"], a: 0, ref: "Mark 16" },
    { q: "Who was the first person to see the risen Jesus?", o: ["Mary Magdalene", "Peter", "John", "Mary His mother"], a: 0, ref: "John 20" },
    { q: "Where did Jesus ascend to heaven from?", o: ["Mount of Olives", "Mount Sinai", "Mount Carmel", "Temple mount"], a: 0, ref: "Acts 1" },
    { q: "What did Jesus say to the storm on the Sea of Galilee?", o: ["Peace, be still", "Be gone", "Silence", "Return"], a: 0, ref: "Mark 4" },
    { q: "What did Jesus call Peter and Andrew to become?", o: ["Fishers of men", "Teachers of Israel", "Guards of the temple", "Writers of the law"], a: 0, ref: "Matthew 4" },
    { q: "Which mountain did Jesus take Peter, James and John to be transfigured?", o: ["Mount of Transfiguration", "Mount Sinai", "Mount Ararat", "Mount Gerizim"], a: 0, ref: "Matthew 17" },
    { q: "Who came to Jesus by night to ask about being born again?", o: ["Nicodemus", "Gamaliel", "Zacchaeus", "Joseph of Arimathea"], a: 0, ref: "John 3" },
    { q: "What did Jesus do in the temple that angered the money changers?", o: ["Drove them out", "Taught there", "Prayed", "Healed the blind"], a: 0, ref: "John 2" },
    { q: "What is the shortest verse in the Bible?", o: ["Jesus wept", "God is love", "Rejoice always", "Pray without ceasing"], a: 0, ref: "John 11" },
    { q: "Who did Jesus raise from the dead in Bethany?", o: ["Lazarus", "Jairus' daughter", "The widow's son", "Tabitha"], a: 0, ref: "John 11" },
    { q: "What did Jesus say to the thief on the cross?", o: ["Today you will be with Me in paradise", "Follow Me", "Go and sin no more", "Your faith has healed you"], a: 0, ref: "Luke 23" },
    { q: "Where did Jesus pray the night before His crucifixion?", o: ["Gethsemane", "The temple", "Bethany", "Mount of Olives only"], a: 0, ref: "Matthew 26" },
    { q: "What did the soldiers place on Jesus' head as a crown?", o: ["Thorns", "Gold", "Olive branches", "A wreath of laurel"], a: 0, ref: "Matthew 27" },
    { q: "Who said 'My Lord and my God' when he saw the risen Jesus?", o: ["Thomas", "Peter", "John", "Nathaniel"], a: 0, ref: "John 20" },
    { q: "What did Jesus ask Peter three times after the resurrection?", o: ["Do you love Me?", "Do you believe?", "Will you follow?", "Who do you say I am?"], a: 0, ref: "John 21" },
    { q: "Which city is called 'the city of David' in the Gospels?", o: ["Bethlehem", "Jerusalem", "Hebron", "Nazareth"], a: 0, ref: "Luke 2" },
    { q: "What did Jesus say about the greatest commandment?", o: ["Love the Lord your God with all your heart", "Honor your parents", "Keep the Sabbath", "Do not murder"], a: 0, ref: "Matthew 22" },
    { q: "Who anointed Jesus' feet with expensive perfume?", o: ["Mary of Bethany", "Mary Magdalene only", "Martha", "Joanna"], a: 0, ref: "John 12" },
    { q: "What did Jesus say to Jairus when told his daughter had died?", o: ["Do not be afraid, only believe", "She is asleep", "Weep with me", "It is finished"], a: 0, ref: "Mark 5" },
    { q: "How many times did Peter deny Jesus?", o: ["Three", "Two", "Four", "Seven"], a: 0, ref: "Luke 22" },
    { q: "Who was the traitor that kissed Jesus to identify Him?", o: ["Judas Iscariot", "Peter", "A soldier", "A pharisee"], a: 0, ref: "Matthew 26" },
    { q: "What was Jesus' occupation before His ministry?", o: ["Carpenter", "Fisherman", "Shepherd", "Tax collector"], a: 0, ref: "Mark 6" },
    { q: "What did Jesus say to His mother from the cross?", o: ["Woman, behold your son", "I thirst", "It is finished", "Father forgive them"], a: 0, ref: "John 19" },
    { q: "What was the last thing Jesus said before dying?", o: ["Father, into Your hands I commit My spirit", "It is finished only", "I thirst", "My God, My God"], a: 0, ref: "Luke 23" },
    { q: "Who was Jesus' cousin who prepared the way for Him?", o: ["John the Baptist", "James", "Andrew", "Barnabas"], a: 0, ref: "Luke 1" },
    { q: "What did the wise men bring to the baby Jesus?", o: ["Gold, frankincense, myrrh", "Gold, silver, bronze", "Wine, oil, bread", "Figs, dates, honey"], a: 0, ref: "Matthew 2" },
  ],
  people: [
    { q: "Who was the first murderer in the Bible?", o: ["Cain", "Abel", "Lamech", "Esau"], a: 0, ref: "Genesis 4" },
    { q: "Who was the oldest man recorded in the Bible?", o: ["Methuselah", "Adam", "Noah", "Abraham"], a: 0, ref: "Genesis 5" },
    { q: "Who was known as the father of many nations?", o: ["Abraham", "Isaac", "Jacob", "David"], a: 0, ref: "Genesis 17" },
    { q: "Who wrestled with God and was renamed Israel?", o: ["Jacob", "Abraham", "Joseph", "Moses"], a: 0, ref: "Genesis 32" },
    { q: "What did Jacob's name become after wrestling with God?", o: ["Israel", "Judah", "Levi", "Edom"], a: 0, ref: "Genesis 32" },
    { q: "Who was Moses' sister who watched over him in the bulrushes?", o: ["Miriam", "Rachel", "Leah", "Deborah"], a: 0, ref: "Exodus 2" },
    { q: "Who led Israel into the Promised Land after Moses?", o: ["Joshua", "Caleb", "Samuel", "Eleazar"], a: 0, ref: "Joshua 1" },
    { q: "Who was the judge and prophetess who led Israel to victory?", o: ["Deborah", "Ruth", "Esther", "Hannah"], a: 0, ref: "Judges 4" },
    { q: "Who was the Moabite woman who became an ancestor of King David?", o: ["Ruth", "Orpah", "Naomi", "Tamar"], a: 0, ref: "Ruth 4" },
    { q: "Who was the priest who raised Samuel in the tabernacle?", o: ["Eli", "Aaron", "Zadok", "Abiathar"], a: 0, ref: "1 Samuel 1" },
    { q: "Who was David's best friend and Saul's son?", o: ["Jonathan", "Abner", "Joab", "Amnon"], a: 0, ref: "1 Samuel 18" },
    { q: "Who was the wise queen who visited Solomon?", o: ["Queen of Sheba", "Queen Esther", "Queen Jezebel", "Queen Athaliah"], a: 0, ref: "1 Kings 10" },
    { q: "Who was the prophetess who dedicated Jesus in the temple?", o: ["Anna", "Elizabeth", "Mary", "Martha"], a: 0, ref: "Luke 2" },
    { q: "Who was the tax collector who climbed a tree to see Jesus?", o: ["Zacchaeus", "Matthew", "Levi", "Bartimaeus"], a: 0, ref: "Luke 19" },
    { q: "Who were the sisters of Lazarus?", o: ["Mary and Martha", "Rachel and Leah", "Lydia and Priscilla", "Anna and Elizabeth"], a: 0, ref: "John 11" },
    { q: "Who was the blind beggar healed by Jesus at Jericho?", o: ["Bartimaeus", "Zacchaeus", "Simon", "Blind man only"], a: 0, ref: "Mark 10" },
    { q: "Who was the Roman centurion whose servant Jesus healed?", o: ["A centurion of Capernaum", "Cornelius", "Claudius", "Lysias"], a: 0, ref: "Luke 7" },
    { q: "Who was the woman who touched Jesus' cloak and was healed?", o: ["A woman with an issue of blood", "Mary Magdalene", "The widow of Nain", "Salome"], a: 0, ref: "Mark 5" },
    { q: "Who was the widow at the temple treasury who gave two mites?", o: ["The poor widow", "Anna", "Elizabeth", "Hannah"], a: 0, ref: "Mark 12" },
    { q: "Who was Barnabas' cousin who joined Paul on a journey?", o: ["John Mark", "Timothy", "Silas", "Apollos"], a: 0, ref: "Colossians 4" },
    { q: "Who was the seller of purple cloth in Philippi who was baptized?", o: ["Lydia", "Priscilla", "Phoebe", "Dorcas"], a: 0, ref: "Acts 16" },
    { q: "Who was the disciple who sewed tents with Paul?", o: ["Aquila", "Crispus", "Gaius", "Stephanas"], a: 0, ref: "Acts 18" },
    { q: "Who was Dorcas in the book of Acts?", o: ["A disciple who made clothes and was raised from the dead", "A prophetess", "Paul's sister", "A judge"], a: 0, ref: "Acts 9" },
    { q: "Who was the eloquent preacher from Alexandria?", o: ["Apollos", "Tertullus", "Elymas", "Demetrius"], a: 0, ref: "Acts 18" },
    { q: "Who was the high priest at Jesus' trial?", o: ["Caiaphas", "Annas only", "Zacharias", "Eli"], a: 0, ref: "Matthew 26" },
    { q: "Who was King Herod's wife who asked for John the Baptist's head?", o: ["Herodias", "Jezebel", "Vashti", "Bathsheba"], a: 0, ref: "Mark 6" },
    { q: "Who danced for Herod and requested John the Baptist's head?", o: ["Salome", "Herodias", "Esther", "Ruth"], a: 0, ref: "Mark 6" },
    { q: "Who was the disciple called 'the Twin'?", o: ["Thomas", "Philip", "Bartholomew", "Thaddaeus"], a: 0, ref: "John 11" },
    { q: "Who was the zealot among the twelve apostles?", o: ["Simon the Zealot", "James", "John", "Andrew"], a: 0, ref: "Luke 6" },
    { q: "Who wrote the book of James?", o: ["James, the brother of Jesus", "James the apostle only", "John", "Jude"], a: 0, ref: "James 1" },
    { q: "Who was the shepherd boy who became king of Israel?", o: ["David", "Saul", "Solomon", "Josiah"], a: 0, ref: "1 Samuel 16" },
    { q: "Who was the giant killed by David?", o: ["Goliath", "Og", "Sihon", "Anak"], a: 0, ref: "1 Samuel 17" },
    { q: "Who was the queen who lost her crown for refusing the king's order?", o: ["Vashti", "Esther", "Jezebel", "Bathsheba"], a: 0, ref: "Esther 1" },
    { q: "Who was the man who built a tower to reach heaven?", o: ["The people of Babel", "Nimrod", "Cain", "Pharaoh"], a: 0, ref: "Genesis 11" },
    { q: "Who was the faithful friend who stood by Job?", o: ["Eliphaz, Bildad, Zophar came; God restored Job", "Bildad only", "None", "Elihu"], a: 3, ref: "Job" },
    { q: "Who was Lot's wife turned into?", o: ["A pillar of salt", "A stone", "A tree", "Ash"], a: 0, ref: "Genesis 19" },
    { q: "Who was the patriarch who offered his son Isaac as a sacrifice?", o: ["Abraham", "Jacob", "Isaac", "Terah"], a: 0, ref: "Genesis 22" },
    { q: "Who was the angel who appeared to Mary?", o: ["Gabriel", "Michael", "Raphael", "Uriel"], a: 0, ref: "Luke 1" },
    { q: "Who was the prophet who confronted King David about Bathsheba?", o: ["Nathan", "Gad", "Samuel", "Ahijah"], a: 0, ref: "2 Samuel 12" },
    { q: "Who was the young king who found the Book of the Law and reformed Judah?", o: ["Josiah", "Hezekiah", "Joash", "Manasseh"], a: 0, ref: "2 Kings 22" },
  ],
  places: [
    { q: "In what city was the Last Supper held?", o: ["Jerusalem", "Bethlehem", "Capernaum", "Nazareth"], a: 0, ref: "Luke 22" },
    { q: "What is the name of the garden where Jesus was arrested?", o: ["Gethsemane", "Eden", "Golgotha", "Bethany"], a: 0, ref: "Matthew 26" },
    { q: "Which sea did Jesus walk on?", o: ["Sea of Galilee", "Dead Sea", "Red Sea", "Mediterranean Sea"], a: 0, ref: "Matthew 14" },
    { q: "What is the name of the place where Jesus was crucified?", o: ["Golgotha (the Place of the Skull)", "Gethsemane", "Mount Carmel", "Bethany"], a: 0, ref: "John 19" },
    { q: "In which town did Jesus turn water into wine?", o: ["Cana", "Capernaum", "Nain", "Nazareth"], a: 0, ref: "John 2" },
    { q: "What was the hometown of Mary, Martha, and Lazarus?", o: ["Bethany", "Bethlehem", "Bethesda", "Bethsaida"], a: 0, ref: "John 11" },
    { q: "Where was the pool where Jesus healed a lame man?", o: ["Bethesda", "Siloam", "Gihon", "Jordan"], a: 0, ref: "John 5" },
    { q: "What mountain did Moses receive the Ten Commandments on?", o: ["Sinai", "Carmel", "Ararat", "Zion"], a: 0, ref: "Exodus 19" },
    { q: "Where did Noah's ark come to rest?", o: ["Mount Ararat", "Mount Sinai", "Mount Nebo", "Mount Moriah"], a: 0, ref: "Genesis 8" },
    { q: "Where did Abraham prepare to sacrifice Isaac?", o: ["Mount Moriah", "Mount Carmel", "Mount Horeb", "Mount Gilboa"], a: 0, ref: "Genesis 22" },
    { q: "Where did Elijah defeat the prophets of Baal?", o: ["Mount Carmel", "Mount Sinai", "Mount Tabor", "Mount Zion"], a: 0, ref: "1 Kings 18" },
    { q: "Where did the Israelites cross the Jordan into the Promised Land?", o: ["Near Jericho", "Near Jerusalem", "Near Bethel", "Near Shechem"], a: 0, ref: "Joshua 3" },
    { q: "What was the capital city of Israel under David?", o: ["Jerusalem", "Hebron", "Samaria", "Shechem"], a: 0, ref: "2 Samuel 5" },
    { q: "What was the capital of the northern kingdom of Israel?", o: ["Samaria", "Jerusalem", "Bethel", "Dan"], a: 0, ref: "1 Kings 16" },
    { q: "Where was Paul born?", o: ["Tarsus", "Rome", "Jerusalem", "Antioch"], a: 0, ref: "Acts 21" },
    { q: "Where were the believers first called Christians?", o: ["Antioch", "Jerusalem", "Rome", "Ephesus"], a: 0, ref: "Acts 11" },
    { q: "Which city did Paul write to about the resurrection?", o: ["Corinth", "Galatia", "Philippi", "Colossae"], a: 0, ref: "1 Corinthians 15" },
    { q: "What was the prison city where Paul and Silas sang hymns?", o: ["Philippi", "Rome", "Caesarea", "Athens"], a: 0, ref: "Acts 16" },
    { q: "Where did the church in Acts first gather?", o: ["Jerusalem", "Antioch", "Ephesus", "Damascus"], a: 0, ref: "Acts 2" },
    { q: "What sea is the lowest place on Earth?", o: ["Dead Sea", "Red Sea", "Sea of Galilee", "Black Sea"], a: 0, ref: "The Bible lands" },
    { q: "Which river did Jesus get baptized in?", o: ["Jordan", "Nile", "Euphrates", "Tigris"], a: 0, ref: "Matthew 3" },
    { q: "What was the name of the wilderness where John the Baptist preached?", o: ["Wilderness of Judea", "Wilderness of Sinai", "Wilderness of Paran", "Wilderness of Shur"], a: 0, ref: "Matthew 3" },
    { q: "Where did Joseph, Mary, and Jesus flee to from Herod?", o: ["Egypt", "Babylon", "Syria", "Greece"], a: 0, ref: "Matthew 2" },
    { q: "What was the city where Jesus grew up, called 'Can anything good come from there'?", o: ["Nazareth", "Bethlehem", "Cana", "Capernaum"], a: 0, ref: "John 1" },
    { q: "Which lake is also called the Sea of Galilee?", o: ["Lake Gennesaret", "Lake Tiberias", "Lake Huleh", "Lake Merom"], a: 1, ref: "Luke 5" },
    { q: "Where was the Temple located in Jesus' day?", o: ["Jerusalem", "Mount Gerizim", "Shiloh", "Bethel"], a: 0, ref: "Mark 11" },
    { q: "What was the mountain where Jesus taught the Beatitudes?", o: ["The Mount (near Capernaum)", "Mount Sinai", "Mount Carmel", "Mount Moriah"], a: 0, ref: "Matthew 5" },
    { q: "Where was John the Baptist imprisoned and beheaded?", o: ["Machaerus", "Rome", "Caesarea", "Jerusalem"], a: 0, ref: "Mark 6" },
    { q: "What city did Paul speak to the philosophers at?", o: ["Athens", "Corinth", "Ephesus", "Rome"], a: 0, ref: "Acts 17" },
    { q: "Which island was Paul shipwrecked on?", o: ["Malta", "Cyprus", "Crete", "Patmos"], a: 0, ref: "Acts 28" },
    { q: "What was the city of the Ephesians famous for?", o: ["The temple of Artemis", "The colosseum", "The hanging gardens", "The lighthouse"], a: 0, ref: "Acts 19" },
    { q: "Where was the tabernacle set up after Joshua's conquest?", o: ["Shiloh", "Gilgal", "Bethel", "Shechem"], a: 0, ref: "Joshua 18" },
    { q: "What city did Jonah try to flee to instead of Nineveh?", o: ["Tarshish", "Joppa", "Carthage", "Tyre"], a: 0, ref: "Jonah 1" },
    { q: "What was the hometown of Goliath?", o: ["Gath", "Gaza", "Ashkelon", "Ekron"], a: 0, ref: "1 Samuel 17" },
    { q: "Which city was destroyed by fire and brimstone?", o: ["Sodom and Gomorrah", "Jericho", "Ai", "Hazor"], a: 0, ref: "Genesis 19" },
    { q: "Where was the Garden of Eden located?", o: ["Eastward (with the rivers Pishon, Gihon, Tigris, Euphrates)", "In Egypt", "In Babylon", "On Mount Ararat"], a: 0, ref: "Genesis 2" },
    { q: "What mountain did Moses view the Promised Land from before he died?", o: ["Mount Nebo", "Mount Sinai", "Mount Carmel", "Mount Hermon"], a: 0, ref: "Deuteronomy 34" },
    { q: "What was the name of the tower the people built at Babel?", o: ["The Tower of Babel", "The Tower of Siloam", "The Tower of David", "The Tower of Hananel"], a: 0, ref: "Genesis 11" },
    { q: "Where did the wise men find the baby Jesus?", o: ["Bethlehem", "Nazareth", "Jerusalem", "Jericho"], a: 0, ref: "Matthew 2" },
    { q: "What river watered the Garden of Eden (one of the four)?", o: ["Tigris and Euphrates", "Nile and Jordan", "Jordan and Pishon", "Abana and Pharpar"], a: 0, ref: "Genesis 2" },
  ],
  miracles: [
    { q: "How many loaves and fish fed the 5,000?", o: ["Five loaves and two fish", "Seven loaves and few fish", "Two loaves and five fish", "Ten loaves and no fish"], a: 0, ref: "Matthew 14" },
    { q: "How many baskets of leftovers were gathered after feeding the 5,000?", o: ["12", "7", "5", "3"], a: 0, ref: "Matthew 14" },
    { q: "Who did Jesus raise from the dead after four days in the tomb?", o: ["Lazarus", "Jairus' daughter", "The widow's son at Nain", "Tabitha"], a: 0, ref: "John 11" },
    { q: "What did Jesus do to calm the storm?", o: ["Rebuked the wind and sea", "Prayed all night", "Called fire from heaven", "Sent angels"], a: 0, ref: "Mark 4" },
    { q: "How many lepers did Jesus heal, and how many returned to thank Him?", o: ["Ten healed, one returned", "Ten healed, ten returned", "Five healed, one returned", "One healed, one returned"], a: 0, ref: "Luke 17" },
    { q: "What did Jesus use to heal the man born blind?", o: ["Clay made with spit and dirt", "Water from the pool", "Oil and wine", "His shadow"], a: 0, ref: "John 9" },
    { q: "Who walked on water toward Jesus?", o: ["Peter", "John", "Thomas", "Philip"], a: 0, ref: "Matthew 14" },
    { q: "What happened when Peter tried to walk on water?", o: ["He sank when he doubted", "He walked all the way", "He swam back", "An angel caught him"], a: 0, ref: "Matthew 14" },
    { q: "How many men were in the group Jesus cast demons from into the pigs?", o: ["Two", "One", "Three", "Twelve"], a: 0, ref: "Matthew 8" },
    { q: "What did Jesus say to the fig tree that had no fruit?", o: ["May no fruit ever come from you again", "Be fruitful", "Grow taller", "You are cursed only"], a: 0, ref: "Mark 11" },
    { q: "What happened to the demon-possessed pigs?", o: ["They rushed into the sea", "They ran away", "They became sheep", "They disappeared"], a: 0, ref: "Matthew 8" },
    { q: "Who was healed of a fever by Jesus?", o: ["Peter's mother-in-law", "Mary Magdalene", "The centurion's servant", "Jairus' daughter"], a: 0, ref: "Mark 1" },
    { q: "What did Jesus do to the paralyzed man lowered through the roof?", o: ["Forgave his sins and healed him", "Only healed him", "Told him to wait", "Sent him to the priests"], a: 0, ref: "Mark 2" },
    { q: "Who did Jesus heal at the Pool of Bethesda?", o: ["A man who had been sick 38 years", "A blind man", "A deaf man", "A leper"], a: 0, ref: "John 5" },
    { q: "What did the woman with the issue of blood touch?", o: ["The hem of Jesus' cloak", "Jesus' hand", "The cross", "The temple door"], a: 0, ref: "Mark 5" },
    { q: "How many water jars did Jesus fill with water at Cana?", o: ["Six", "Five", "Seven", "Twelve"], a: 0, ref: "John 2" },
    { q: "Who was the widow's son Jesus raised at Nain?", o: ["The widow of Nain's son", "The son of the Shunammite", "Tabitha", "Eutychus"], a: 0, ref: "Luke 7" },
    { q: "What did Jesus do to heal the deaf man with a speech impediment?", o: ["Put His fingers in his ears and touched his tongue", "Spit on the ground", "Said 'be opened' only", "Touched his eyes"], a: 0, ref: "Mark 7" },
    { q: "How many people were fed with seven loaves and a few fish?", o: ["4,000", "5,000", "7,000", "10,000"], a: 0, ref: "Mark 8" },
    { q: "How many baskets were left over after feeding the 4,000?", o: ["Seven", "Twelve", "Four", "Two"], a: 0, ref: "Mark 8" },
    { q: "What happened to the money in the fish's mouth that Peter caught?", o: ["A coin for the temple tax", "Silver coins", "Gold coins", "Nothing"], a: 0, ref: "Matthew 17" },
    { q: "Who was healed of dropsy on the Sabbath?", o: ["A man with dropsy", "A woman bent over", "A man with a withered hand", "A blind man"], a: 0, ref: "Luke 14" },
    { q: "What did Jesus do to the withered hand of the man in the synagogue?", o: ["Healed it", "Told him to go home", "Rebuked the crowd", "Anointed it with oil"], a: 0, ref: "Mark 3" },
    { q: "Who was the woman bent over for 18 years healed by Jesus?", o: ["A woman with a spirit of infirmity", "Mary Magdalene", "The widow of Zarephath", "Hannah"], a: 0, ref: "Luke 13" },
    { q: "What did the demons beg Jesus to let them enter?", o: ["A herd of pigs", "The sea", "The temple", "The tombs only"], a: 0, ref: "Mark 5" },
    { q: "Who was the official whose son Jesus healed from a distance?", o: ["A nobleman in Capernaum", "The centurion's servant", "Jairus", "Zacchaeus"], a: 0, ref: "John 4" },
    { q: "What happened when Jesus touched the coffin at Nain?", o: ["The young man sat up and spoke", "The coffin broke", "The crowd fainted", "Nothing"], a: 0, ref: "Luke 7" },
    { q: "Who was the Syrophoenician woman's daughter healed of?", o: ["An unclean spirit", "Leprosy", "Blindness", "A fever"], a: 0, ref: "Mark 7" },
    { q: "What did Jesus do to the ten lepers?", o: ["Cleansed them all", "Healed five", "Told them to see priests only", "Sent them home"], a: 0, ref: "Luke 17" },
    { q: "Who did Jesus heal at the Pool of Siloam?", o: ["The man born blind", "The lame man", "The deaf man", "The leper"], a: 0, ref: "John 9" },
    { q: "What did Jesus do before feeding the 5,000?", o: ["Blessed and broke the loaves", "Asked them to bring food", "Prayed all night", "Told them to go home"], a: 0, ref: "Matthew 14" },
    { q: "How did Jesus appear to the disciples after the resurrection?", o: ["Through closed doors", "By the sea only", "On the mountain only", "In the temple"], a: 0, ref: "John 20" },
    { q: "What happened to the net when Peter obeyed Jesus and cast it again?", o: ["It was full of 153 fish", "It broke", "It caught nothing", "It was full of seaweed"], a: 0, ref: "John 21" },
    { q: "Who was healed by the shadow of Peter?", o: ["The sick brought to the streets", "The lame man at the gate", "Aeneas", "Tabitha"], a: 0, ref: "Acts 5" },
    { q: "Who was raised from the dead by Peter in Joppa?", o: ["Tabitha (Dorcas)", "Eutychus", "Aeneas", "The jailer"], a: 0, ref: "Acts 9" },
    { q: "Who was raised from the dead by Paul after falling from a window?", o: ["Eutychus", "Tabitha", "Timothy", "Crispus"], a: 0, ref: "Acts 20" },
    { q: "What did Paul say to the blind sorcerer Elymas?", o: ["You will be blind for a time", "You are forgiven", "Go in peace", "Follow me"], a: 0, ref: "Acts 13" },
    { q: "Who was healed by Paul on the island of Malta?", o: ["The father of Publius", "The governor", "A sailor", "A soldier"], a: 0, ref: "Acts 28" },
    { q: "What did the handkerchiefs from Paul do?", o: ["Healed the sick", "Turned to gold", "Became flags", "Nothing"], a: 0, ref: "Acts 19" },
    { q: "What happened to the jail at Philippi when Paul and Silas sang?", o: ["The doors opened and chains fell off", "It caught fire", "The roof collapsed", "Nothing"], a: 0, ref: "Acts 16" },
  ],
  "teachings-parables": [
    { q: "Which parable is about a son who squandered his inheritance?", o: ["The Prodigal Son", "The Lost Sheep", "The Talents", "The Sower"], a: 0, ref: "Luke 15" },
    { q: "In the parable of the Good Samaritan, who stopped to help the wounded man?", o: ["A Samaritan", "A priest", "A Levite", "A merchant"], a: 0, ref: "Luke 10" },
    { q: "In the parable of the sower, what does the seed represent?", o: ["The word of God", "Money", "People", "Crops"], a: 0, ref: "Luke 8" },
    { q: "What did the foolish virgins forget to take for their lamps?", o: ["Oil", "Wicks", "Matches", "Light"], a: 0, ref: "Matthew 25" },
    { q: "What happened to the servant who buried his talent?", o: ["He was cast into outer darkness", "He was promoted", "He was forgiven", "He received more"], a: 0, ref: "Matthew 25" },
    { q: "How many sheep did the shepherd leave to find the one lost?", o: ["Ninety-nine", "Ninety", "Fifty", "None"], a: 0, ref: "Luke 15" },
    { q: "What did the mustard seed grow into?", o: ["A large tree", "A vine", "A bush only", "A flower"], a: 0, ref: "Matthew 13" },
    { q: "What is the pearl of great price a parable of?", o: ["The kingdom of heaven", "Wisdom", "Wealth", "Salvation only"], a: 0, ref: "Matthew 13" },
    { q: "What did the unforgiving servant owe that was forgiven?", o: ["Ten thousand talents", "A hundred denarii", "A few coins", "Nothing"], a: 0, ref: "Matthew 18" },
    { q: "What did the unforgiving servant do to his fellow servant?", o: ["Threw him in prison for a small debt", "Forgave him", "Paid his debt", "Fled"], a: 0, ref: "Matthew 18" },
    { q: "What happened to the man who built his house on the sand?", o: ["It fell when the storm came", "It stood firm", "It floated", "It grew"], a: 0, ref: "Matthew 7" },
    { q: "What happened to the man who built his house on the rock?", o: ["It stood firm", "It fell", "It cracked", "It washed away"], a: 0, ref: "Matthew 7" },
    { q: "What is the Golden Rule?", o: ["Do to others what you would have them do to you", "Love only your friends", "Eye for an eye", "Give and take"], a: 0, ref: "Matthew 7" },
    { q: "What are the Beatitudes about?", o: ["Blessings for the humble and faithful", "The ten commandments", "The fruit of the Spirit", "The armor of God"], a: 0, ref: "Matthew 5" },
    { q: "What did Jesus say is the second greatest commandment?", o: ["Love your neighbor as yourself", "Keep the Sabbath", "Do not covet", "Honor your father and mother"], a: 0, ref: "Matthew 22" },
    { q: "What did Jesus say about the salt that loses its saltiness?", o: ["It is good for nothing but to be thrown out", "It becomes sweet", "It is still useful", "It becomes brighter"], a: 0, ref: "Matthew 5" },
    { q: "What did Jesus say about the light of the world?", o: ["A city on a hill cannot be hidden", "Hide it under a bowl", "It fades at night", "Only kings have it"], a: 0, ref: "Matthew 5" },
    { q: "In the parable of the workers, what did the landowner pay everyone?", o: ["A denarius", "Two denarii", "A talent", "Nothing"], a: 0, ref: "Matthew 20" },
    { q: "What is the parable of the wheat and tares about?", o: ["Good and evil growing together until harvest", "Farming methods", "Wealth", "The seasons"], a: 0, ref: "Matthew 13" },
    { q: "What did the rich man in the parable of the rich fool plan to do?", o: ["Build bigger barns", "Give everything away", "Go on a journey", "Plant a vineyard"], a: 0, ref: "Luke 12" },
    { q: "What happened to the rich fool that night?", o: ["His life was required of him", "He became richer", "He was praised", "He moved away"], a: 0, ref: "Luke 12" },
    { q: "In the parable of the two sons, which one did the father's will?", o: ["The one who said no but then went", "The one who said yes but didn't go", "Neither", "Both"], a: 0, ref: "Matthew 21" },
    { q: "What did the unjust steward do when he was fired?", o: ["Reduced the debts of his master's debtors", "Ran away", "Fought the master", "Begged for mercy only"], a: 0, ref: "Luke 16" },
    { q: "What did the rich man and Lazarus parable teach?", o: ["The reversal of fortunes after death", "Wealth is everything", "Poverty is a curse", "Angels are invisible"], a: 0, ref: "Luke 16" },
    { q: "What is the lesson of the parable of the persistent widow?", o: ["Always pray and not give up", "Never bother judges", "Only pray once", "Be loud"], a: 0, ref: "Luke 18" },
    { q: "Who did the Pharisee and the tax collector parable say was justified?", o: ["The tax collector who humbled himself", "The Pharisee", "Both", "Neither"], a: 0, ref: "Luke 18" },
    { q: "What did the foolish farmer do in the parable of the rich fool?", o: ["Stored up treasure for himself instead of being rich toward God", "Shared everything", "Gave to the poor", "Traveled"], a: 0, ref: "Luke 12" },
    { q: "What did Jesus say about worry and the birds?", o: ["They neither sow nor reap, yet God feeds them", "They work hard", "They store up treasure", "They fear"], a: 0, ref: "Matthew 6" },
    { q: "What did Jesus say about the lilies of the field?", o: ["Even Solomon was not arrayed like one", "They wither quickly", "They are weeds", "They are food"], a: 0, ref: "Matthew 6" },
    { q: "What did Jesus teach about forgiveness?", o: ["Forgive seventy times seven", "Forgive three times", "Never forgive", "Forgive only friends"], a: 0, ref: "Matthew 18" },
    { q: "What did Jesus say about judging others?", o: ["First take the log out of your own eye", "Judge everyone", "Ignore your own faults", "Judge only strangers"], a: 0, ref: "Matthew 7" },
    { q: "What did Jesus say about the narrow gate?", o: ["Few find it", "Everyone enters", "It is wide", "It is locked"], a: 0, ref: "Matthew 7" },
    { q: "What did Jesus say about the wise and foolish builders?", o: ["Hear and do His words = wise", "Only hear = wise", "Build big = wise", "Pray long = wise"], a: 0, ref: "Matthew 7" },
    { q: "What is the greatest commandment according to Jesus?", o: ["Love the Lord your God with all your heart, soul, and mind", "Love your neighbor only", "Keep the Sabbath", "Do not bear false witness"], a: 0, ref: "Matthew 22" },
    { q: "What did Jesus say to the rich young ruler who kept the commandments?", o: ["Sell what you have and give to the poor, then follow Me", "Keep more commandments", "Build a temple", "Pray more"], a: 0, ref: "Mark 10" },
    { q: "What did Jesus say about the camel and the needle?", o: ["It is easier for a camel to go through a needle's eye than for a rich man to enter heaven", "Camels are holy", "Needles are precious", "Rich men are blessed"], a: 0, ref: "Mark 10" },
    { q: "What did Jesus teach in the Sermon on the Mount about anger?", o: ["Do not be angry without cause; reconcile quickly", "Anger is fine", "Venting helps", "Ignore it"], a: 0, ref: "Matthew 5" },
    { q: "What did Jesus say about loving your enemies?", o: ["Pray for those who persecute you", "Hate them", "Avoid them", "Fight them"], a: 0, ref: "Matthew 5" },
    { q: "What is the meaning of the parable of the net?", o: ["The kingdom gathers good and bad; the bad are separated at the end", "Fishing is holy", "Nets are tools", "The sea is the world only"], a: 0, ref: "Matthew 13" },
    { q: "What did Jesus say about treasures?", o: ["Lay up treasures in heaven, not on earth", "Store gold", "Hide silver", "Invest wisely only"], a: 0, ref: "Matthew 6" },
  ],
  "psalms-prophets": [
    { q: "Who is the Shepherd in Psalm 23?", o: ["The Lord", "David", "Moses", "An angel"], a: 0, ref: "Psalm 23" },
    { q: "How many psalms are in the book of Psalms?", o: ["150", "100", "120", "66"], a: 0, ref: "Psalms" },
    { q: "What is the beginning of wisdom according to Proverbs?", o: ["The fear of the Lord", "Knowledge", "Age", "Wealth"], a: 0, ref: "Proverbs 9" },
    { q: "Who wrote most of the Proverbs?", o: ["Solomon", "David", "Agur", "Lemuel"], a: 0, ref: "Proverbs 1" },
    { q: "What is the shortest psalm?", o: ["Psalm 117", "Psalm 23", "Psalm 1", "Psalm 150"], a: 0, ref: "Psalm 117" },
    { q: "What is the longest chapter in the Bible?", o: ["Psalm 119", "Genesis 1", "Matthew 5", "Revelation 22"], a: 0, ref: "Psalm 119" },
    { q: "What is the shortest chapter in the Bible?", o: ["Psalm 117", "Psalm 23", "Obadiah", "Jude"], a: 0, ref: "Psalm 117" },
    { q: "What does Psalm 1 say the blessed man delights in?", o: ["The law of the Lord", "Wealth", "Honor", "Rest"], a: 0, ref: "Psalm 1" },
    { q: "Who wrote Psalm 23?", o: ["David", "Solomon", "Moses", "Asaph"], a: 0, ref: "Psalm 23" },
    { q: "What is the message of the book of Ecclesiastes?", o: ["Life without God is vanity", "Gather wealth", "Enjoy everything", "Fear nothing"], a: 0, ref: "Ecclesiastes" },
    { q: "Who said 'Vanity of vanities, all is vanity'?", o: ["The Preacher (Solomon)", "David", "Job", "Isaiah"], a: 0, ref: "Ecclesiastes 1" },
    { q: "What did Job say when he lost everything?", o: ["The Lord gave, and the Lord has taken away; blessed be the name of the Lord", "Why me", "I give up", "Curse God"], a: 0, ref: "Job 1" },
    { q: "What does 'The Lord is my shepherd; I shall not want' come from?", o: ["Psalm 23", "Psalm 1", "Isaiah 40", "Proverbs 3"], a: 0, ref: "Psalm 23" },
    { q: "Which prophet said 'Here am I; send me'?", o: ["Isaiah", "Jeremiah", "Ezekiel", "Amos"], a: 0, ref: "Isaiah 6" },
    { q: "Which prophet was called in his mother's womb?", o: ["Jeremiah", "Isaiah", "Jonah", "Micah"], a: 0, ref: "Jeremiah 1" },
    { q: "Which prophet was a shepherd and dresser of sycamore trees?", o: ["Amos", "Hosea", "Joel", "Obadiah"], a: 0, ref: "Amos 7" },
    { q: "Which book has only one chapter and is the shortest book of the Old Testament?", o: ["Obadiah", "Joel", "Haggai", "Nahum"], a: 0, ref: "Obadiah" },
    { q: "What did Micah prophesy about Bethlehem?", o: ["The ruler of Israel would come from it", "It would be destroyed", "It would become a port", "It would be renamed"], a: 0, ref: "Micah 5" },
    { q: "What did Malachi prophesy about Elijah?", o: ["Elijah would come before the great day of the Lord", "Elijah had died", "Elijah was a king", "Elijah wrote the law"], a: 0, ref: "Malachi 4" },
    { q: "What did Isaiah prophesy about a virgin?", o: ["She would bear a son named Immanuel", "She would be queen", "She would be a judge", "She would be barren"], a: 0, ref: "Isaiah 7" },
    { q: "What does 'Immanuel' mean?", o: ["God with us", "God is great", "Prince of peace", "Son of God"], a: 0, ref: "Matthew 1" },
    { q: "What did Zechariah prophesy about the King riding on a donkey?", o: ["Your King comes to you, humble, riding on a donkey", "The King would walk", "The King would fly", "There would be no king"], a: 0, ref: "Zechariah 9" },
    { q: "What did Daniel prophesy about the Son of Man?", o: ["He would come with the clouds of heaven and receive an everlasting kingdom", "He would be a warrior", "He would be a priest only", "He would be a judge only"], a: 0, ref: "Daniel 7" },
    { q: "What was Jeremiah's message about the new covenant?", o: ["God would write His law on people's hearts", "The old law was enough", "The temple would last forever", "Sacrifices were unnecessary"], a: 0, ref: "Jeremiah 31" },
    { q: "What did Joel prophesy about the Spirit?", o: ["God would pour out His Spirit on all people", "The Spirit would come only to kings", "The Spirit was gone", "The Spirit would be silent"], a: 0, ref: "Joel 2" },
    { q: "What did Habakkuk say about the just?", o: ["The just shall live by faith", "The just shall be rich", "The just shall fight", "The just shall rest"], a: 0, ref: "Habakkuk 2" },
    { q: "What did Jonah preach to Nineveh?", o: ["Forty days and Nineveh shall be overthrown", "Peace and prosperity", "Build a temple", "Crown a king"], a: 0, ref: "Jonah 3" },
    { q: "What did the people of Nineveh do when Jonah preached?", o: ["Repented in sackcloth and ashes", "Laughed", "Attacked him", "Ignored him"], a: 0, ref: "Jonah 3" },
    { q: "What did the LORD do when Nineveh repented?", o: ["He relented from the disaster He had said He would bring", "Destroyed them anyway", "Left them", "Sent another prophet"], a: 0, ref: "Jonah 3" },
    { q: "Which prophet saw the Lord high and lifted up with seraphim calling 'Holy, holy, holy'?", o: ["Isaiah", "Ezekiel", "Daniel", "Micah"], a: 0, ref: "Isaiah 6" },
    { q: "What did the seraphim touch Isaiah's lips with?", o: ["A live coal from the altar", "A feather", "Water", "Oil"], a: 0, ref: "Isaiah 6" },
    { q: "What is the 'suffering servant' passage in Isaiah about?", o: ["Jesus bearing our sins", "Moses leading Israel", "David conquering", "Solomon building"], a: 0, ref: "Isaiah 53" },
    { q: "What did Ezekiel eat in his vision that tasted like honey?", o: ["A scroll", "Bread", "Figs", "Honeycomb"], a: 0, ref: "Ezekiel 3" },
    { q: "What vision did Ezekiel see of God's glory leaving the temple?", o: ["The cherubim with wheels", "A burning bush", "A ladder", "A chariot of fire"], a: 0, ref: "Ezekiel 10" },
    { q: "What did the dry bones become in Ezekiel's vision?", o: ["A great army of living people", "Dust", "Mountains", "Trees"], a: 0, ref: "Ezekiel 37" },
    { q: "What did Hosea name his first child?", o: ["Jezreel", "Lo-ammi", "Lo-ruhamah", "Israel"], a: 0, ref: "Hosea 1" },
    { q: "What did the LORD say to Hosea about His people?", o: ["I desire mercy, not sacrifice", "I desire gold", "I desire temples", "I desire fasting only"], a: 0, ref: "Hosea 6" },
    { q: "What did Amos say about justice?", o: ["Let justice run down like water and righteousness like a mighty stream", "Justice is slow", "Justice is for kings", "Justice is optional"], a: 0, ref: "Amos 5" },
    { q: "What did Micah say the LORD requires?", o: ["To do justly, love mercy, and walk humbly with God", "Many sacrifices", "Long prayers", "Big temples"], a: 0, ref: "Micah 6" },
    { q: "What is the final verse of the Old Testament about?", o: ["Elijah coming before the great and dreadful day of the Lord", "The flood", "The exodus", "The temple"], a: 0, ref: "Malachi 4" },
  ],
};

function builtinSeed(excludeSet) {
  const all = [];
  for (const cat of CATEGORIES) {
    for (const item of QUESTION_BANK[cat]) {
      if (excludeSet && excludeSet.has(norm(item.q))) continue;
      all.push({ question: item.q, options: item.o, correctAnswer: item.a, ref: item.ref });
    }
  }
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all;
}

function pickQuestions(count, usedRaw) {
  const exclude = usedRaw && usedRaw.length ? new Set(usedRaw.map(norm)) : null;
  const all = builtinSeed(exclude);
  return all.slice(0, Math.min(count, all.length));
}

// ── /api/trivia — ensure the bank has questions ─────────────────────────────
async function handleTrivia(request, env, ctx) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const body = await request.json().catch(() => ({}));
  const count = Math.max(5, Math.min(30, Number(body.count) || BANK_BATCH));

  try {
    const meta = (await fbGet(env, `${P}/meta`).catch(() => null)) || {};
    const bank = (await fbGet(env, `${P}/bank`).catch(() => null)) || {};
    const len = bankCount(bank);
    const usedRaw = Array.isArray(meta.used) ? meta.used : [];
    const usedSet = new Set(usedRaw.map(norm));
    const bankSet = new Set(Object.values(bank).filter((q) => q?.question).map((q) => norm(q.question)));

    if (meta.generating && Date.now() - meta.generating < GEN_LOCK_MS) {
      return json({ bankLen: len, generating: true });
    }

    // Empty bank → generate a fresh AI batch immediately (fallback: built-ins),
    // then start the question clock.
    if (len === 0) {
      await fbPut(env, `${P}/meta`, { generating: Date.now(), used: usedRaw });
      let questions;
      try {
        questions = await generateQuestions(count, env, usedRaw);
      } catch (err) {
        console.error("[Trivia] opencode.ai failed, using built-in:", err.message);
        questions = null;
      }
      if (!questions || !questions.length) questions = pickQuestions(count, usedRaw);
      let fresh = filterFresh(questions, usedSet, bankSet);
      if (!fresh.length) fresh = questions;
      if (!fresh.length) fresh = builtinSeed();   // absolute last resort — never stall
      const patch = {};
      fresh.forEach((q, i) => (patch[i] = q));
      await fbPut(env, `${P}/bank`, patch);
      const game = await fbGet(env, `${P}/game`).catch(() => null);
      await fbPut(env, `${P}/game`, {
        questionStart: Date.now(),
        slotDuration: SLOT_DURATION,
        bankLen: fresh.length,
        startedAt: game?.startedAt || Date.now(),
      });
      await markUsed(env, fresh);
      ctxWait(ctx, env, count, usedRaw);
      return json({ bankLen: fresh.length, source: fresh.length ? "ai" : "seed" });
    }

    // Bank healthy — nothing to do (the client only calls when the bank
    // runs low, but guard against redundant generation anyway).
    const game0 = (await fbGet(env, `${P}/game`).catch(() => null)) || {};
    const globalSlot = game0.questionStart ? Math.floor((Date.now() - game0.questionStart) / SLOT_DURATION) : 0;
    if (globalSlot - len + TOP_UP_THRESHOLD <= 0) {
      return json({ bankLen: len, healthy: true });
    }

    // Bank low → generate fresh batches via opencode.ai (avoiding repeats).
    await fbPut(env, `${P}/meta`, { generating: Date.now(), used: usedRaw });
    const need = Math.max(count, Math.min(60, globalSlot - len + TOP_UP_THRESHOLD));

    const allAccepted = [];
    let fromStatic = false;
    for (let round = 0; round < 3 && allAccepted.length < need; round++) {
      const want = Math.min(BANK_BATCH, need - allAccepted.length);
      let batch;
      try {
        batch = await generateQuestions(want, env, usedRaw);
      } catch (err) {
        console.error("[Trivia] opencode.ai failed, using built-in:", err.message);
        batch = null;
      }
      if (!batch || !batch.length) {
        batch = pickQuestions(want, usedRaw);
        fromStatic = true;
      }
      let fresh = filterFresh(batch, usedSet, bankSet);
      if (!fresh.length) fresh = batch;
      if (!fresh.length) break;
      const patch = {};
      fresh.forEach((q, i) => (patch[len + allAccepted.length + i] = q));
      await fbPatch(env, `${P}/bank`, patch);
      fresh.forEach((q) => q?.question && bankSet.add(norm(q.question)));
      allAccepted.push(...fresh);
    }
    if (!allAccepted.length) {
      await fbPut(env, `${P}/meta`, { generating: 0, used: usedRaw });
      return json({ bankLen: len, skipped: true });
    }
    await markUsed(env, allAccepted);
    const bankLen = len + allAccepted.length;

    if (bankLen > BANK_MAX) {
      const patch = {};
      allAccepted.forEach((q, i) => (patch[i] = q));
      await fbPut(env, `${P}/bank`, patch);
      await fbDelete(env, `${P}/answers`).catch(() => {});
      await fbPut(env, `${P}/game`, {
        questionStart: Date.now(),
        slotDuration: SLOT_DURATION,
        bankLen: allAccepted.length,
        startedAt: Date.now(),
      });
      await fbPut(env, `${P}/meta`, { generating: 0, used: (await readUsed(env)) });
      return json({ bankLen: allAccepted.length, reset: true, source: fromStatic ? "seed" : "ai" });
    }

    const game = await fbGet(env, `${P}/game`).catch(() => null);
    if (game) {
      await fbPatch(env, `${P}/game`, { bankLen });
    } else {
      await fbPut(env, `${P}/game`, {
        questionStart: Date.now(),
        slotDuration: SLOT_DURATION,
        bankLen,
        startedAt: Date.now(),
      });
    }
    await fbPut(env, `${P}/meta`, { generating: 0, used: (await readUsed(env)) });
    return json({ bankLen, source: fromStatic ? "bank" : "ai" });
  } catch (err) {
    console.error("[Trivia] error:", err.message);
    await fbPut(env, `${P}/meta`, { generating: 0 }).catch(() => {});
    return json({ error: err.message }, 500);
  }
}

function ctxWait(ctx, env, count, usedRaw) {
  ctx?.waitUntil?.(
    (async () => {
      try {
        const used = (await readUsed(env)).slice();
        const usedSet = new Set(used.map(norm));
        const bank = (await fbGet(env, `${P}/bank`).catch(() => null)) || {};
        const len = bankCount(bank);
        const bankSet = new Set(Object.values(bank).filter((q) => q?.question).map((q) => norm(q.question)));
        let questions;
        try {
          questions = await generateQuestions(count, env, used);
        } catch (err) {
          console.error("[Trivia] bg opencode.ai failed:", err.message);
          await fbPut(env, `${P}/meta`, { generating: 0, lastError: err.message }).catch(() => {});
          return;
        }
        const fresh = filterFresh(questions, usedSet, bankSet);
        if (!fresh.length) {
          await fbPut(env, `${P}/meta`, { generating: 0 }).catch(() => {});
          return;
        }
        const patch = {};
        fresh.forEach((q, i) => (patch[len + i] = q));
        await fbPatch(env, `${P}/bank`, patch);
        const game = await fbGet(env, `${P}/game`).catch(() => null);
        if (game) await fbPatch(env, `${P}/game`, { bankLen: len + fresh.length });
        await markUsed(env, fresh);
        await fbPut(env, `${P}/meta`, { generating: 0, used: (await readUsed(env)) }).catch(() => {});
        console.log("[Trivia] bg top-up appended", fresh.length);
      } catch (err) {
        console.error("[Trivia] bg top-up error:", err.message);
        await fbPut(env, `${P}/meta`, { generating: 0, lastError: err.message }).catch(() => {});
      }
    })()
  );
}

// ── /api/time — clock sync for question timing ──────────────────────────────
async function handleTime(request, env) {
  const game = await fbGet(env, `${P}/game`).catch(() => null);
  return json({ now: Date.now(), game: game || null });
}

// ── Firebase proxies (Dice Arena pattern) ───────────────────────────────────
function upstreamUrl(env, pathAfter, search) {
  const host = (env.FB_HOST || FB_DEFAULT_HOST).replace(/^https?:\/\//, "");
  const u = new URL(`https://${host}${pathAfter}`);
  u.search = search;
  return u;
}

async function restProxy(request, env, url) {
  const pathAfter = url.pathname.replace(/^\/firebase/, "");
  const target = upstreamUrl(env, pathAfter, url.search);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("cf-connecting-ip");
  headers.set("origin", url.origin);
  const method = headers.get("x-fb-method") || request.method;
  headers.delete("x-fb-method");
  const init = { method, headers, redirect: "follow" };
  if (method !== "GET" && method !== "HEAD") {
    init.body = request.body;
  }
  const res = await fetch(target, init);
  if (!url.pathname.startsWith("/firebase/bible/global/meta/logs")) {
    logRequest(env, method, url.pathname, res.status);
  }
  const outHeaders = new Headers(res.headers);
  outHeaders.set("Cache-Control", "no-store");
  outHeaders.set("Access-Control-Allow-Origin", url.origin);
  return new Response(res.body, { status: res.status, headers: outHeaders });
}

async function sseProxy(request, env, url) {
  const pathAfter = url.pathname.replace(/^\/firebase\/stream/, "");
  const target = upstreamUrl(env, pathAfter, url.search);
  const upstream = await fetch(target, { headers: { Accept: "text/event-stream" } });
  if (!upstream.ok || !upstream.body) {
    return json({ error: `upstream ${upstream.status}` }, upstream.status);
  }
  const headers = new Headers();
  headers.set("Content-Type", "text/event-stream");
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("X-Accel-Buffering", "no");
  headers.set("Access-Control-Allow-Origin", url.origin);
  return new Response(upstream.body, { status: 200, headers });
}

let logBuffer = [];
let logFlushing = false;
function logRequest(env, method, path, status) {
  logBuffer.push({ m: method, p: path.slice(0, 60), s: status, t: Date.now() });
  if (logBuffer.length > 30) logBuffer.shift();
  if (logFlushing) return;
  logFlushing = true;
  ctxWaitSafe(env, () => {
    try {
      return fbPut(env, `${P}/meta/logs`, logBuffer.slice(-25));
    } finally {
      logFlushing = false;
    }
  });
}
function ctxWaitSafe(env, fn) {
  fn().catch(() => {});
}

// ── Static assets (inlined at build time by build.js) ───────────────────────
// Each value is replaced by a JSON string literal of the file contents.
// NOTE: do not wrap these in backticks — the files contain backticks of
// their own (template literals), which would break the outer literal.
const STATIC = {
  "index.html": __INDEX_HTML__,
  "style.css": __STYLE_CSS__,
  "discord.js": __DISCORD_JS__,
  "firebase.js": __FIREBASE_JS__,
  "app.js": __APP_JS__,
  "vendor/discord-sdk.mjs": __VENDOR_DISCORD_SDK_MJS__,
  "privacy.html": __PRIVACY_HTML__,
  "terms.html": __TERMS_HTML__,
};

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path.startsWith("/firebase/stream/")) return await sseProxy(request, env, url);
      if (path.startsWith("/firebase/")) return await restProxy(request, env, url);
      if (path === "/api/exchange" && request.method === "POST") return await handleExchange(request, env);
      if (path === "/api/trivia") return await handleTrivia(request, env, ctx);
      if (path === "/api/time") return await handleTime(request, env);
      if (path === "/privacy") return html(STATIC["privacy.html"]);
      if (path === "/terms") return html(STATIC["terms.html"]);
      if (path === "/" || path === "") {
        return html(STATIC["index.html"]);
      }
      const assetPath = path.slice(1);
      const content = STATIC[assetPath];
      if (content !== undefined) {
        const ext = "." + (assetPath.split(".").pop() || "");
        return new Response(content, {
          headers: { "Content-Type": CONTENT_TYPES[ext] || "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
        });
      }
      return notFound();
    } catch (err) {
      console.error("[BibleTrivia] error:", err.message);
      return json({ error: "Internal error" }, 500);
    }
  },
};
