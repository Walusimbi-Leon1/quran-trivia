/**
 * Bible Game — Telegram Bot (Cloudflare Worker)
 * 
 * Handles Telegram webhooks, uses Firebase RTDB REST API.
 * 
 * Routes:
 *   GET  /                     — health check
 *   POST /api/webhook          — Telegram update handler
 *   GET  /api/set-webhook      — trigger to set/refresh webhook
 */

// ─── Common words that should NEVER be blanked ──────────────────────────────
const COMMON = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
  'from','up','as','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','could','should','may','might','shall','can',
  'not','no','nor','so','if','then','than','that','this','these','those','it','its',
  'he','him','his','she','her','they','them','their','we','us','our','you','your',
  'i','me','my','who','whom','whose','which','what','when','where','why','how',
  'all','each','every','both','few','many','some','any','much','more','most',
  'other','such','own','same','into','upon','about','like','through','between',
  'under','over','after','before','above','below','out','off','down','just',
  'also','very','too','even','still','already','again','here','there','then',
  'now','yet','only','once','well','go','went','come','came','make','made',
  'said','say','see','saw','know','knew','give','gave','take','took','let',
  'get','got','set','put','bring','brought','find','found','call','called',
  'tell','told','ask','asked','show','showed','keep','kept','hold','held',
  'begin','began','begun','shall','should','must','need','dare','ought','used',
  'unto','thou','thy','thee','ye','doth','hath','art','wilt','shalt','canst',
  'didst','hadst','camest','spake',
]);

const PUNCTUATION = /[.,;:!?'"()\-–—\[\]{}«»""'']/g;

// ─── Firebase RTDB helpers ─────────────────────────────────────────────────
function firebaseURL(path) {
  return `https://bible-game-21-default-rtdb.firebaseio.com/${path}.json`;
}

async function fbGet(path) {
  const res = await fetch(firebaseURL(path));
  return res.json();
}

async function fbPut(path, data) {
  await fetch(firebaseURL(path), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

// ─── Verse masking ─────────────────────────────────────────────────────────
function isSignificant(word) {
  const clean = word.replace(PUNCTUATION, '').toLowerCase();
  return clean.length > 1 && !COMMON.has(clean);
}

function maskVerse(text) {
  const words = text.split(/\s+/);
  const candidates = words
    .map((w, i) => ({ word: w, index: i }))
    .filter(({ word }) => isSignificant(word));
  if (!candidates.length) return { maskedText: text, blanks: [] };

  const n = candidates.length >= 2 ? 1 + Math.round(Math.random()) : 1;
  const selected = candidates.sort(() => Math.random() - 0.5).slice(0, Math.min(n, candidates.length));
  const blankMap = new Map(selected.map(s => [s.index, s]));

  return {
    maskedText: words.map((w, i) => blankMap.has(i) ? '___' : w).join(' '),
    blanks: selected.map(s => ({
      original: s.word.replace(PUNCTUATION, ''),
      clean: s.word.replace(PUNCTUATION, '').toLowerCase(),
      index: s.index,
    })),
  };
}

function checkGuess(guess, blanks) {
  const clean = guess.replace(PUNCTUATION, '').trim().toLowerCase();
  if (!clean) return { correct: false, matched: null };
  for (const b of blanks) {
    if (b.clean === clean) return { correct: true, matched: b.original };
  }
  return { correct: false, matched: null };
}

// ─── Telegram API helpers ──────────────────────────────────────────────────
const TG_API = (method) => `https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`;

async function tgSend(chatId, text, opts = {}) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: opts.parse_mode || 'Markdown',
    reply_markup: opts.reply_markup,
  };
  // Filter out undefined keys
  const clean = {};
  for (const [k, v] of Object.entries(body)) {
    if (v !== undefined) clean[k] = v;
  }
  await fetch(TG_API('sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(clean),
  });
}

// ─── Game state (in-memory KV, per chat) ───────────────────────────────────
// Games live in memory for the Worker's lifetime + persisted to Firebase
// so they survive Worker restarts.
const games = new Map();

// ─── Loading verses ────────────────────────────────────────────────────────
let versesCache = null;

async function loadVerses() {
  if (versesCache) return versesCache;
  const data = await fbGet('verses');
  if (!data) return [];

  const list = [];
  for (const book of Object.values(data)) {
    for (const chapter of Object.values(book)) {
      for (const verse of Object.values(chapter)) {
        if (verse.text && verse.ref) list.push(verse);
      }
    }
  }
  versesCache = list;
  return list;
}

// ─── Game logic ────────────────────────────────────────────────────────────
async function advanceRound(game) {
  game.round++;
  if (game.round > game.maxRounds) {
    game.status = 'finished';
    return;
  }

  const allVerses = await loadVerses();
  const verse = allVerses[Math.floor(Math.random() * allVerses.length)];
  const { maskedText, blanks } = maskVerse(verse.text);

  game.currentVerse = {
    ref: verse.ref,
    text: verse.text,
    maskedText,
    blanks,
    solvedBlanks: [],
    roundStart: Date.now(),
  };
  game.blanks = blanks;
}

function buildGameMessage(game) {
  const cv = game.currentVerse;
  if (!cv) return { text: 'Loading verse...' };

  const sorted = Object.values(game.players)
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  const medals = ['🥇', '🥈', '🥉'];
  const lb = sorted.map((p, i) =>
    `${medals[i] || `#${i + 1}`} ${p.name} — ${p.score} pts`
  ).join('\n');

  return {
    text:
      `📖 *Round ${game.round}/${game.maxRounds}*\n\n` +
      `*${cv.ref}*\n` +
      `> ${cv.maskedText}\n\n` +
      `Type /guess &lt;word&gt; to submit!\n\n` +
      `🏆 *Leaderboard*\n${lb}`,
  };
}

async function saveGame(chatId, game) {
  // Persist essential state to Firebase for recovery
  await fbPut(`game-state/${chatId}`, {
    round: game.round,
    maxRounds: game.maxRounds,
    status: game.status,
    playerCount: Object.keys(game.players).length,
    playerIds: Object.keys(game.players),
    savedAt: Date.now(),
  });
}

// ─── Command handlers ──────────────────────────────────────────────────────

async function handleStart(chatId) {
  await tgSend(chatId,
    '📖 *Bible Game*\n\n' +
    'Fill in the missing words from Bible verses!\n\n' +
    '*/play* — Start or join a game\n' +
    '*/guess <word>* — Submit a guess\n' +
    '*/leaderboard* — Show the scoreboard\n' +
    '*/leave* — Leave the game\n' +
    '*/verses* — Show verse count'
  );
}

async function handlePlay(chatId, userId, userName) {
  // Check existing game
  if (games.has(chatId)) {
    const g = games.get(chatId);
    if (g.players[userId]) {
      await tgSend(chatId, 'You are already in the game!');
      return;
    }
    g.players[userId] = { name: userName, score: 0 };
    await tgSend(chatId, `*${userName}* joined the Bible Game!`);
    return;
  }

  const allVerses = await loadVerses();
  if (!allVerses.length) {
    await tgSend(chatId, '❌ No verses found in the database. Seed verses first.');
    return;
  }

  const game = {
    chatId,
    status: 'playing',
    round: 0,
    maxRounds: 10,
    players: {
      [userId]: { name: userName, score: 0 },
    },
    allVerses,
    currentVerse: null,
    blanks: [],
  };

  games.set(chatId, game);
  await advanceRound(game);
  await saveGame(chatId, game);

  const msg = buildGameMessage(game);
  await tgSend(chatId, msg.text, {
    reply_markup: { inline_keyboard: [[{ text: '🎯 Guess', callback_data: 'guess_hint' }]] },
  });
}

async function handleGuess(chatId, userId, userName, guessText, chatInstanceId) {
  const game = games.get(chatId);

  if (!game || game.status !== 'playing') {
    await tgSend(chatId, '❌ No active game. Use /play to start one!');
    return;
  }

  if (!game.players[userId]) {
    await tgSend(chatId, '❌ You are not in this game. Use /play to join!');
    return;
  }

  if (!game.currentVerse || !game.blanks) {
    await tgSend(chatId, '⏳ Waiting for the next verse...');
    return;
  }

  const playerSolved = game.currentVerse.solvedBlanks?.some(sb => sb.solvedBy === userId);
  if (playerSolved) {
    await tgSend(chatId, '✅ You already solved a blank this round!');
    return;
  }

  const { correct, matched } = checkGuess(guessText, game.blanks);

  if (!correct) {
    await tgSend(chatId, `❌ "${guessText}" is not correct. Try again!`);
    return;
  }

  const blank = game.blanks.find(b => b.clean === matched.toLowerCase());
  if (!blank) return;

  if (!game.currentVerse.solvedBlanks) game.currentVerse.solvedBlanks = [];
  if (game.currentVerse.solvedBlanks.find(sb => sb.index === blank.index)) {
    await tgSend(chatId, '⏳ That blank was already solved by someone else!');
    return;
  }

  game.currentVerse.solvedBlanks.push({
    index: blank.index,
    word: matched,
    solvedBy: userId,
  });

  const pts = game.currentVerse.solvedBlanks.length === 1 ? 15 : 10;
  game.players[userId].score = (game.players[userId].score || 0) + pts;

  await tgSend(chatId, `✅ *${matched}* is correct! You earned *${pts} pts* 🎉`);
  await tgSend(chatId, `*${userName}* got it! **${matched}** ✅`);

  // Check if all blanks solved
  if (game.currentVerse.solvedBlanks.length >= game.blanks.length) {
    await tgSend(chatId, '🎯 All blanks filled! Next verse coming...');
    await advanceRound(game);
    await saveGame(chatId, game);
    const msg = buildGameMessage(game);
    await tgSend(chatId, msg.text, {
      reply_markup: { inline_keyboard: [[{ text: '🎯 Guess', callback_data: 'guess_hint' }]] },
    });
  }
}

async function handleLeaderboard(chatId) {
  const game = games.get(chatId);
  if (!game || !game.players) {
    await tgSend(chatId, 'No active game in this chat. Use /play to start one!');
    return;
  }

  const sorted = Object.values(game.players)
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  const medals = ['🥇', '🥈', '🥉'];
  const lines = sorted.map((p, i) =>
    `${medals[i] || `#${i + 1}`} *${p.name}* — ${p.score || 0} pts`
  );

  await tgSend(chatId, `🏆 *Bible Game — Leaderboard*\n\n${lines.join('\n')}`);
}

async function handleLeave(chatId, userId) {
  const game = games.get(chatId);
  if (!game || !game.players[userId]) {
    await tgSend(chatId, 'You are not in a game in this chat.');
    return;
  }

  delete game.players[userId];

  if (Object.keys(game.players).length === 0) {
    games.delete(chatId);
    await fbPut(`game-state/${chatId}`, null); // clean up
    await tgSend(chatId, 'You left the game. The game has ended (no players left).');
  } else {
    await tgSend(chatId, 'You left the game.');
  }
}

async function handleVerses(chatId) {
  const allVerses = await loadVerses();
  await tgSend(chatId, `📖 *${allVerses.length}* verses in the SGSS Bible database.`);
}

// ─── Parse command text from a message ─────────────────────────────────────
function parseCommand(text) {
  if (!text || !text.startsWith('/')) return null;
  const parts = text.split(' ');
  const cmd = parts[0].toLowerCase().split('@')[0]; // strip bot username
  const arg = parts.slice(1).join(' ').trim();
  return { cmd, arg };
}

// ─── Main webhook handler ──────────────────────────────────────────────────

async function handleUpdate(update, env) {
  // Callback query (inline button)
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = String(cq.message.chat.id);
    const userId = String(cq.from.id);

    if (cq.data === 'guess_hint') {
      await fetch(TG_API('answerCallbackQuery'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callback_query_id: cq.id,
          text: 'Type /guess <word> to submit your answer!',
          show_alert: false,
        }),
      });
    }
    return;
  }

  // Regular message
  const msg = update.message;
  if (!msg || !msg.text) return;

  const chatId = String(msg.chat.id);
  const userId = String(msg.from.id);
  const userName = msg.from.first_name || msg.from.username || 'Player';
  const text = msg.text;

  const parsed = parseCommand(text);
  if (!parsed) return;

  const { cmd, arg } = parsed;

  try {
    switch (cmd) {
      case '/start':
        await handleStart(chatId);
        break;
      case '/play':
        await handlePlay(chatId, userId, userName);
        break;
      case '/guess':
        if (!arg) {
          await tgSend(chatId, 'Usage: /guess <word>');
          break;
        }
        await handleGuess(chatId, userId, userName, arg);
        break;
      case '/leaderboard':
        await handleLeaderboard(chatId);
        break;
      case '/leave':
        await handleLeave(chatId, userId);
        break;
      case '/verses':
        await handleVerses(chatId);
        break;
      default:
        // Unknown command — ignore
        break;
    }
  } catch (err) {
    console.error('Handler error:', err);
    try {
      await tgSend(chatId, '⚠️ Something went wrong. Try again.');
    } catch (_) {}
  }
}

// ─── Cloudflare Worker entry point ─────────────────────────────────────────

export default {
  async fetch(request, env) {
    // Set env globals for Telegram API calls
    globalThis.TELEGRAM_TOKEN = env.TELEGRAM_TOKEN;

    const url = new URL(request.url);
    const path = url.pathname;

    // Health check
    if (request.method === 'GET' && (path === '/' || path === '/health')) {
      return new Response(JSON.stringify({ status: 'ok', bot: 'Bible Game Telegram', version: '1.0' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Set webhook trigger (GET request to this URL)
    if (request.method === 'GET' && path === '/api/set-webhook') {
      const webhookUrl = `${url.origin}/api/webhook`;
      const res = await fetch(TG_API('setWebhook'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: webhookUrl,
          allowed_updates: ['message', 'callback_query'],
        }),
      });
      const result = await res.json();
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Webhook receiver
    if (request.method === 'POST' && path === '/api/webhook') {
      const update = await request.json();
      // Fire-and-forget (don't block response)
      handleUpdate(update, env).catch(err => console.error('Unhandled:', err));
      return new Response('ok');
    }

    // 404
    return new Response('Not found', { status: 404 });
  },
};
