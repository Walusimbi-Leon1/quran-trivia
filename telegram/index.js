/**
 * Bible Game — Telegram Bot
 * 
 * Commands:
 *   /play      — Start or join a Bible Game in this chat
 *   /guess     — Submit a guess for the missing word
 *   /leaderboard — Show the scoreboard
 *   /leave     — Leave the current game
 *   /verses    — Show verse count in the database
 * 
 * Environment:
 *   TELEGRAM_TOKEN  — Bot token from BotFather
 *   FIREBASE_SA     — Firebase service account JSON (stringified)
 */

import { Telegraf, Markup } from 'telegraf';
import admin from 'firebase-admin';

// ---------------------------------------------------------------------------
// Firebase
// ---------------------------------------------------------------------------
const firebaseSA = process.env.FIREBASE_SA;
if (!firebaseSA) {
  console.error('❌ Missing FIREBASE_SA environment variable');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(firebaseSA)),
  databaseURL: 'https://bible-game-21-default-rtdb.firebaseio.com',
});

const db = admin.database();

// ---------------------------------------------------------------------------
// Game state (per chat)
// ---------------------------------------------------------------------------
const games = new Map(); // chatId -> game state

// ---------------------------------------------------------------------------
// Common words (mirrors game-engine.js)
// ---------------------------------------------------------------------------
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

function isSignificant(word) {
  const clean = word.replace(/[.,;:!?'"()\-–—\[\]{}«»""'']/g, '').toLowerCase();
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

  const maskedWords = words.map((w, i) =>
    blankMap.has(i) ? `___` : w
  );

  return {
    maskedText: maskedWords.join(' '),
    blanks: selected.map(s => ({
      original: s.word.replace(/[.,;:!?'"()\-–—\[\]{}«»""'']/g, ''),
      clean: s.word.replace(/[.,;:!?'"()\-–—\[\]{}«»""'']/g, '').toLowerCase(),
      index: s.index,
    })),
  };
}

function checkGuess(guess, blanks) {
  const clean = guess.replace(/[.,;:!?'"()\-–—\[\]{}«»""'']/g, '').trim().toLowerCase();
  if (!clean) return { correct: false, matched: null };
  for (const b of blanks) {
    if (b.clean === clean) return { correct: true, matched: b.original };
  }
  return { correct: false, matched: null };
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------
const token = process.env.TELEGRAM_TOKEN;
if (!token) {
  console.error('❌ Missing TELEGRAM_TOKEN environment variable');
  process.exit(1);
}

const bot = new Telegraf(token);

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

bot.command('start', (ctx) => {
  ctx.reply(
    '📖 *Bible Game*\n\n' +
    'Fill in the missing words from Bible verses!\n\n' +
    '*/play* — Start or join a game\n' +
    '*/guess <word>* — Submit a guess\n' +
    '*/leaderboard* — Show the scoreboard\n' +
    '*/leave* — Leave the game\n' +
    '*/verses* — Show verse count',
    { parse_mode: 'Markdown' }
  );
});

bot.command('play', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const user = ctx.from;
  const userName = user.first_name || user.username || 'Anonymous';

  // Check existing game
  if (games.has(chatId)) {
    const g = games.get(chatId);
    if (g.players[user.id]) {
      await ctx.reply('You are already in the game!');
      return;
    }
    g.players[user.id] = { name: userName, score: 0 };
    await ctx.reply(`**${userName}** joined the Bible Game!`, { parse_mode: 'Markdown' });
    return;
  }

  // Load verses
  const versesSnap = await db.ref('verses').once('value');
  const versesData = versesSnap.val();
  if (!versesData) {
    await ctx.reply('❌ No verses found in the database. Seed verses first.');
    return;
  }

  const verseList = [];
  for (const book of Object.values(versesData)) {
    for (const chapter of Object.values(book)) {
      for (const verse of Object.values(chapter)) {
        if (verse.text && verse.ref) verseList.push(verse);
      }
    }
  }

  if (verseList.length === 0) {
    await ctx.reply('❌ No verses found in the database. Seed verses first.');
    return;
  }

  // Create new game
  const game = {
    chatId,
    status: 'playing',
    round: 0,
    maxRounds: 10,
    players: {
      [user.id]: { name: userName, score: 0 },
    },
    allVerses: verseList,
    currentVerse: null,
    blanks: [],
  };

  games.set(chatId, game);
  await advanceRound(game);

  const msg = buildGameMessage(game);
  await ctx.reply(msg.text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      Markup.button.callback('🎯 /guess', 'guess_prompt'),
    ]),
  });

  console.log(`🎮 Game started in chat ${chatId} by ${userName}`);
});

bot.command('guess', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const game = games.get(chatId);

  if (!game || game.status !== 'playing') {
    await ctx.reply('❌ No active game. Use /play to start one!');
    return;
  }

  if (!game.players[ctx.from.id]) {
    await ctx.reply('❌ You are not in this game. Use /play to join!');
    return;
  }

  // Get the guess from command arguments
  const text = ctx.message.text;
  const parts = text.split(' ');
  const guess = parts.slice(1).join(' ').trim();

  if (!guess) {
    await ctx.reply('Usage: /guess <word>');
    return;
  }

  if (!game.currentVerse || !game.blanks) {
    await ctx.reply('⏳ Waiting for the next verse...');
    return;
  }

  const playerSolved = game.currentVerse.solvedBlanks?.some(sb => sb.solvedBy === ctx.from.id);
  if (playerSolved) {
    await ctx.reply('✅ You already solved a blank this round!');
    return;
  }

  const { correct, matched } = checkGuess(guess, game.blanks);

  if (!correct) {
    await ctx.reply(`❌ "${guess}" is not correct. Try again!`);
    return;
  }

  const blank = game.blanks.find(b => b.clean === matched.toLowerCase());
  if (!blank) return;

  if (!game.currentVerse.solvedBlanks) game.currentVerse.solvedBlanks = [];
  if (game.currentVerse.solvedBlanks.find(sb => sb.index === blank.index)) {
    await ctx.reply('⏳ That blank was already solved by someone else!');
    return;
  }

  game.currentVerse.solvedBlanks.push({
    index: blank.index,
    word: matched,
    solvedBy: ctx.from.id,
  });

  const pts = game.currentVerse.solvedBlanks.length === 1 ? 15 : 10;
  game.players[ctx.from.id].score = (game.players[ctx.from.id].score || 0) + pts;

  // Reply first (ephemeral-like)
  await ctx.reply(`✅ **${matched}** is correct! You earned *${pts} pts* 🎉`, {
    parse_mode: 'Markdown',
  });

  // Chat-wide announcement
  const userName = ctx.from.first_name || ctx.from.username || 'Player';
  await ctx.reply(`**${userName}** got it! **${matched}** ✅`, {
    parse_mode: 'Markdown',
  });

  // Check if all blanks solved
  if (game.currentVerse.solvedBlanks.length >= game.blanks.length) {
    await ctx.reply('🎯 All blanks filled! Next verse coming...');
    await advanceRound(game);
    const msg = buildGameMessage(game);
    await ctx.reply(msg.text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        Markup.button.callback('🎯 Guess', 'guess_prompt'),
      ]),
    });
  }
});

bot.command('leaderboard', async (ctx) => {
  const game = games.get(String(ctx.chat.id));
  if (!game || !game.players) {
    await ctx.reply('No active game in this chat. Use /play to start one!');
    return;
  }

  const sorted = Object.values(game.players)
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  const medals = ['🥇', '🥈', '🥉'];
  const lines = sorted.map((p, i) =>
    `${medals[i] || `#${i + 1}`} *${p.name}* — ${p.score || 0} pts`
  );

  await ctx.reply(`🏆 *Bible Game — Leaderboard*\n\n${lines.join('\n')}`, {
    parse_mode: 'Markdown',
  });
});

bot.command('leave', async (ctx) => {
  const game = games.get(String(ctx.chat.id));
  if (!game || !game.players[ctx.from.id]) {
    await ctx.reply('You are not in a game in this chat.');
    return;
  }

  delete game.players[ctx.from.id];

  if (Object.keys(game.players).length === 0) {
    games.delete(String(ctx.chat.id));
    await ctx.reply('You left the game. The game has ended (no players left).');
  } else {
    await ctx.reply('You left the game.');
  }
});

bot.command('verses', async (ctx) => {
  const snap = await db.ref('verses').once('value');
  const data = snap.val();
  let count = 0;
  if (data) {
    for (const book of Object.values(data)) {
      for (const chapter of Object.values(book)) {
        count += Object.keys(chapter).length;
      }
    }
  }
  await ctx.reply(`📖 *${count}* verses in the SGSS Bible database.`, {
    parse_mode: 'Markdown',
  });
});

// ---------------------------------------------------------------------------
// Inline keyboard handler
// ---------------------------------------------------------------------------
bot.action('guess_prompt', (ctx) => {
  ctx.answerCbQuery();
  ctx.reply('Type /guess <word> to submit your answer!');
});

// ---------------------------------------------------------------------------
// Game helpers
// ---------------------------------------------------------------------------

async function advanceRound(game) {
  game.round++;
  if (game.round > game.maxRounds) {
    game.status = 'finished';
    return;
  }

  const verse = game.allVerses[Math.floor(Math.random() * game.allVerses.length)];
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
      `Use /guess <word> to submit!\n\n` +
      `🏆 *Leaderboard*\n${lb}`,
  };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
bot.launch().then(() => {
  console.log('✅ Telegram bot started');
});

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
