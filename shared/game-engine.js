/**
 * Bible Game — Core Game Engine
 * 
 * Shared logic used by all platforms (web, Discord, Telegram):
 *   - Verse selection & masking
 *   - Guess validation
 *   - Scoring
 *   - Room management
 */

// ---------------------------------------------------------------------------
// Common words that should NEVER be blanked out
// ---------------------------------------------------------------------------
const COMMON_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "up", "as", "is", "are", "was", "were",
  "be", "been", "being", "have", "has", "had", "do", "does", "did",
  "will", "would", "could", "should", "may", "might", "shall", "can",
  "not", "no", "nor", "so", "if", "then", "than", "that", "this",
  "these", "those", "it", "its", "he", "him", "his", "she", "her",
  "they", "them", "their", "we", "us", "our", "you", "your", "i", "me",
  "my", "who", "whom", "whose", "which", "what", "when", "where", "why",
  "how", "all", "each", "every", "both", "few", "many", "some", "any",
  "much", "more", "most", "other", "such", "own", "same", "into",
  "upon", "about", "like", "through", "between", "under", "over",
  "after", "before", "above", "below", "out", "off", "down", "just",
  "also", "very", "too", "even", "still", "already", "again",
  "here", "there", "then", "now", "yet", "only", "once", "well",
  "go", "went", "come", "came", "make", "made", "said", "say", "see",
  "saw", "know", "knew", "give", "gave", "take", "took", "let",
  "get", "got", "set", "put", "bring", "brought", "find", "found",
  "call", "called", "tell", "told", "ask", "asked", "show", "showed",
  "keep", "kept", "hold", "held", "begin", "began", "begun",
  "shall", "should", "must", "need", "dare", "ought", "used",
  "unto", "thou", "thy", "thee", "ye", "doth", "hath", "art",
  "wilt", "shalt", "canst", "didst", "hadst", "camest", "spake",
]);

// ---------------------------------------------------------------------------
// Punctuation that should be stripped from guesses
// ---------------------------------------------------------------------------
const PUNCTUATION = /[.,;:!?'"()\-–—\[\]{}«»""'']/g;

// ---------------------------------------------------------------------------
// Bible verse source — loaded from JSON files in /verse-data/
// ---------------------------------------------------------------------------
let verseCache = null;

/**
 * Load all verses from the verse-data directory.
 * Each JSON file should export { ref, book, chapter, verse, text }.
 */
export async function loadVerses() {
  if (verseCache) return verseCache;
  
  try {
    // Node.js: load from filesystem
    const fs = await import('fs/promises');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    
    const verseDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..', 'verse-data'
    );
    
    const files = await fs.readdir(verseDir);
    const verses = [];
    
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const data = JSON.parse(await fs.readFile(path.join(verseDir, file), 'utf-8'));
      if (Array.isArray(data)) {
        verses.push(...data);
      } else {
        verses.push(data);
      }
    }
    
    verseCache = verses;
    return verses;
  } catch {
    // Browser: verses are loaded from a CDN or inline via firebase
    return verseCache || [];
  }
}

/**
 * Set verses programmatically (used by browser / seed script).
 */
export function setVerses(verses) {
  verseCache = verses;
}

/**
 * Get all loaded verses.
 */
export function getVerses() {
  return verseCache || [];
}

// ---------------------------------------------------------------------------
// Verse masking
// ---------------------------------------------------------------------------

/**
 * Determine whether a word is "significant" (not a common word).
 * Words are compared case-insensitively.
 */
function isSignificantWord(word) {
  const clean = word.replace(PUNCTUATION, '').toLowerCase();
  if (!clean || clean.length <= 1) return false;
  if (clean.startsWith('_')) return false; // already a blank
  return !COMMON_WORDS.has(clean);
}

/**
 * Mask significant words in a verse text.
 * Returns { maskedText, blanks: [{ original, index }] }
 * 
 * @param {string} text - The full verse text
 * @param {number} count - Number of words to blank (default 1-2 randomly)
 */
export function maskVerse(text, count) {
  const words = text.split(/\s+/);
  
  // Find all significant words and their positions
  const candidates = words
    .map((w, i) => ({ word: w, index: i }))
    .filter(({ word }) => isSignificantWord(word));
  
  if (candidates.length === 0) {
    return { maskedText: text, blanks: [] };
  }
  
  // Pick random words to blank (avoid duplicates)
  const blankCount = count ?? (candidates.length >= 2 ? 1 + Math.round(Math.random()) : 1);
  const shuffled = candidates.sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, Math.min(blankCount, candidates.length));
  
  // Create masked text
  const blankMap = new Map(selected.map(s => [s.index, s]));
  const maskedWords = words.map((w, i) => {
    if (blankMap.has(i)) {
      return '_'.repeat(Math.max(w.replace(PUNCTUATION, '').length, 3));
    }
    return w;
  });
  
  return {
    maskedText: maskedWords.join(' '),
    blanks: selected.map(s => ({
      original: s.word.replace(PUNCTUATION, ''),
      clean: s.word.replace(PUNCTUATION, '').toLowerCase(),
      index: s.index,
    })),
  };
}

/**
 * Check if a guess matches any of the blanks.
 * Returns { correct: boolean, matched: string|null }.
 * Case-insensitive, punctuation-insensitive.
 */
export function checkGuess(guess, blanks) {
  const cleanGuess = guess.replace(PUNCTUATION, '').trim().toLowerCase();
  if (!cleanGuess) return { correct: false, matched: null };
  
  for (const blank of blanks) {
    if (blank.clean === cleanGuess) {
      return { correct: true, matched: blank.original };
    }
  }
  return { correct: false, matched: null };
}

// ---------------------------------------------------------------------------
// Game room logic
// ---------------------------------------------------------------------------

/**
 * Create a new game state.
 */
export function createGame(roomId, hostId, settings = {}) {
  return {
    roomId,
    hostId,
    status: 'lobby', // lobby | playing | finished
    players: {},
    currentVerse: null,
    currentBlanks: [],
    round: 0,
    maxRounds: settings.maxRounds || 10,
    correctAnswer: null, // { playerId, word }
    settings: {
      blanksPerVerse: settings.blanksPerVerse || 'auto', // auto | 1 | 2 | 3
      ...settings,
    },
    createdAt: Date.now(),
  };
}

/**
 * Add a player to a game.
 */
export function addPlayer(game, playerId, playerName) {
  game.players[playerId] = {
    id: playerId,
    name: playerName,
    score: 0,
    joinedAt: Date.now(),
  };
  return game;
}

/**
 * Start a game: pick first verse.
 */
export async function startGame(game) {
  const verses = await loadVerses();
  if (!verses || verses.length === 0) {
    throw new Error('No verses loaded. Add verses to /verse-data/ first.');
  }
  game.status = 'playing';
  game.round = 0;
  await nextRound(game);
  return game;
}

/**
 * Advance to the next round.
 */
export async function nextRound(game) {
  const verses = await loadVerses();
  
  game.round++;
  if (game.round > game.maxRounds) {
    game.status = 'finished';
    return game;
  }
  
  // Pick random verse
  const verse = verses[Math.floor(Math.random() * verses.length)];
  
  // Determine blank count
  let blankCount;
  if (game.settings.blanksPerVerse === 'auto') {
    blankCount = null; // maskVerse will pick 1-2
  } else {
    blankCount = parseInt(game.settings.blanksPerVerse, 10);
  }
  
  const { maskedText, blanks } = maskVerse(verse.text, blankCount);
  
  game.currentVerse = {
    ref: verse.ref,
    text: verse.text,
    maskedText,
    blanks,
    answered: new Set(), // player IDs who answered this round correctly
    roundStart: Date.now(),
  };
  game.currentBlanks = blanks;
  game.correctAnswer = null;
  
  return game;
}

/**
 * Process a player's guess.
 * Returns { correct, matched, game }.
 */
export function processGuess(game, playerId, guess) {
  if (game.status !== 'playing') {
    return { correct: false, matched: null, reason: 'game_not_playing' };
  }
  if (!game.currentVerse) {
    return { correct: false, matched: null, reason: 'no_current_verse' };
  }
  if (game.currentVerse.answered.has(playerId)) {
    return { correct: false, matched: null, reason: 'already_answered' };
  }
  
  const { correct, matched } = checkGuess(guess, game.currentVerse.blanks);
  
  if (correct) {
    game.currentVerse.answered.add(playerId);
    const player = game.players[playerId];
    if (player) {
      const points = 10 + (game.currentVerse.answered.size === 1 ? 5 : 0); // bonus for first
      player.score += points;
    }
    
    // If all blanks filled, game can advance
    if (game.currentVerse.blanks.every(b => 
      [...game.currentVerse.answered].some(id => {
        const g = game.players[id];
        return g; // simplified — we track which blank each player solved
      })
    )) {
      game.correctAnswer = { playerId, word: matched };
    } else {
      game.correctAnswer = { playerId, word: matched };
    }
  }
  
  return { correct, matched, game };
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

export function getLeaderboard(game) {
  return Object.values(game.players)
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ rank: i + 1, ...p }));
}

export { COMMON_WORDS };
