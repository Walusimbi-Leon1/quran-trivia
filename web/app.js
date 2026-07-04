/**
 * Bible Game — Web App
 * 
 * Multiplayer via Firebase Realtime Database.
 * Players see the same verse with blanks, type the answer, first correct wins.
 */

import { initializeApp } from 'firebase/app';
import { getDatabase, ref, set, push, onValue, update, remove, serverTimestamp } from 'firebase/database';
import { getAnalytics } from 'firebase/analytics';

// ---------------------------------------------------------------------------
// Firebase setup
// ---------------------------------------------------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyCFi9RGPH6OtVgpktsHgP9qjBFdYoCGsNI",
  authDomain: "bible-game-21.firebaseapp.com",
  projectId: "bible-game-21",
  storageBucket: "bible-game-21.firebasestorage.app",
  messagingSenderId: "974314606890",
  appId: "1:974314606890:web:ab91bebf621193aeae8e53",
  measurementId: "G-FTR8BJHKL8"
};

const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const db = getDatabase(app);

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const $ = id => document.getElementById(id);
const screens = {
  lobby: $('lobby'),
  room: $('room'),
  game: $('game'),
  results: $('results'),
};

const playerNameInput = $('player-name');
const roomNameInput = $('room-name');
const btnJoin = $('btn-join');
const activeRooms = $('active-rooms');
const roomCodeSpan = $('room-code');
const playerCountSpan = $('player-count');
const playersList = $('players-list');
const btnStart = $('btn-start');
const btnLeave = $('btn-leave');
const roundNum = $('round-num');
const myScore = $('my-score');
const verseRef = $('verse-ref');
const verseText = $('verse-text');
const guessInput = $('guess-input');
const feedback = $('feedback');
const leaderboard = $('leaderboard');
const finalLeaderboard = $('final-leaderboard');
const btnPlayAgain = $('btn-play-again');
const btnBackLobby = $('btn-back-lobby');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let myId = null;
let myName = '';
let currentRoom = null;
let currentGameId = null;
let isHost = false;
let gameUnsubscribers = [];

// ---------------------------------------------------------------------------
// Common words that should NOT be blanked (mirrors game-engine.js)
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

function maskVerse(text, count) {
  const words = text.split(/\s+/);
  const candidates = words
    .map((w, i) => ({ word: w, index: i }))
    .filter(({ word }) => isSignificant(word));

  if (!candidates.length) return { maskedText: text, blanks: [] };

  const n = count ?? (candidates.length >= 2 ? 1 + Math.round(Math.random()) : 1);
  const selected = candidates.sort(() => Math.random() - 0.5).slice(0, Math.min(n, candidates.length));
  const blankMap = new Map(selected.map(s => [s.index, s]));
  const maskedWords = words.map((w, i) =>
    blankMap.has(i) ? '___' : w
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

// ---------------------------------------------------------------------------
// Screen switching
// ---------------------------------------------------------------------------
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  if (screens[name]) screens[name].classList.add('active');
}

// ---------------------------------------------------------------------------
// Room management
// ---------------------------------------------------------------------------
function generateId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function refreshActiveRooms() {
  const roomsRef = ref(db, 'rooms');
  onValue(roomsRef, (snap) => {
    const data = snap.val();
    activeRooms.innerHTML = '';
    if (!data) {
      activeRooms.innerHTML = '<div class="room-item" style="color:var(--text-dim)">No active rooms. Create one!</div>';
      return;
    }
    for (const [code, room] of Object.entries(data)) {
      if (room.status === 'lobby' || room.status === 'playing') {
        const div = document.createElement('div');
        div.className = 'room-item';
        div.innerHTML = `<span class="room-code">${code}</span><span class="room-players">${room.playerCount || 0} players</span>`;
        div.addEventListener('click', () => {
          joinRoom(code);
        });
        activeRooms.appendChild(div);
      }
    }
  });
}

async function joinRoom(code) {
  const name = playerNameInput.value.trim() || 'Anonymous';
  myName = name;
  myId = generateId() + '-' + Date.now().toString(36);
  currentRoom = code;

  const roomRef = ref(db, `rooms/${code}`);
  const playerRef = ref(db, `rooms/${code}/players/${myId}`);

  await update(roomRef, {
    status: 'lobby',
    hostId: null, // first player becomes host
    playerCount: 0,
  });

  await set(playerRef, { name, score: 0, joinedAt: serverTimestamp() });

  // Listen for player count
  const playersRef = ref(db, `rooms/${code}/players`);
  onValue(playersRef, (snap) => {
    const players = snap.val() || {};
    const count = Object.keys(players).length;
    roomCodeSpan.textContent = code;
    playerCountSpan.textContent = `${count} players`;
    playersList.innerHTML = Object.entries(players)
      .map(([id, p]) => `<div class="player-chip">${p.name}</div>`)
      .join('');

    // First player is host
    const ids = Object.keys(players);
    isHost = ids[0] === myId;
    btnStart.style.display = isHost ? 'inline-block' : 'none';
  });

  // Listen for game start
  const gameRef = ref(db, `games/${code}`);
  onValue(gameRef, (snap) => {
    const game = snap.val();
    if (game && game.status === 'playing') {
      showScreen('game');
      renderGame(game);
    }
    if (game && game.status === 'finished') {
      showScreen('results');
      renderResults(game);
    }
  });

  showScreen('room');
}

async function createRoom() {
  const code = roomNameInput.value.trim().toUpperCase() || generateId();
  roomNameInput.value = code;
  await joinRoom(code);
}

btnJoin.addEventListener('click', createRoom);

// ---------------------------------------------------------------------------
// Start game
// ---------------------------------------------------------------------------
btnStart.addEventListener('click', async () => {
  if (!currentRoom) return;

  // Load all verses from Firebase
  const versesSnap = await new Promise(resolve => {
    onValue(ref(db, 'verses'), resolve, { onlyOnce: true });
  });
  const verses = versesSnap.val();
  if (!verses) {
    feedback.textContent = 'No verses loaded! Seed the database first.';
    feedback.className = 'feedback wrong';
    return;
  }

  const verseList = [];
  for (const book of Object.values(verses)) {
    for (const chapter of Object.values(book)) {
      for (const verse of Object.values(chapter)) {
        if (verse.text && verse.ref) verseList.push(verse);
      }
    }
  }

  if (verseList.length === 0) {
    feedback.textContent = 'No verses found!';
    feedback.className = 'feedback wrong';
    return;
  }

  const roomSnap = await new Promise(resolve => {
    onValue(ref(db, `rooms/${currentRoom}/players`), resolve, { onlyOnce: true });
  });
  const players = roomSnap.val();

  const gameState = {
    status: 'playing',
    roomId: currentRoom,
    hostId: myId,
    round: 0,
    maxRounds: 10,
    players: players || {},
    currentVerse: null,
    allVerses: verseList,
    createdAt: serverTimestamp(),
  };

  await advanceRound(gameState);
  await set(ref(db, `games/${currentRoom}`), gameState);
});

// ---------------------------------------------------------------------------
// Game logic
// ---------------------------------------------------------------------------
async function advanceRound(gameState) {
  gameState.round++;
  if (gameState.round > gameState.maxRounds) {
    gameState.status = 'finished';
    return;
  }

  const verses = gameState.allVerses;
  const verse = verses[Math.floor(Math.random() * verses.length)];
  const { maskedText, blanks } = maskVerse(verse.text);

  gameState.currentVerse = {
    ref: verse.ref,
    text: verse.text,
    maskedText,
    blanks,
    answered: {},
    solvedBlanks: [],
    roundStart: Date.now(),
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
// Render game state
// ---------------------------------------------------------------------------
function renderGame(game) {
  const cv = game.currentVerse;
  if (!cv) return;

  roundNum.textContent = game.round;
  verseRef.textContent = cv.ref;

  // Render masked text with highlighted blanks
  const words = cv.maskedText.split(/\s+/);
  const filledIdxs = new Set();
  if (cv.solvedBlanks) {
    cv.solvedBlanks.forEach(sb => filledIdxs.add(sb.index));
  }

  verseText.innerHTML = words.map((w, i) => {
    if (w === '___') {
      const blank = cv.blanks.find(b => b.index === i);
      const filled = blank && filledIdxs.has(i);
      const solved = cv.solvedBlanks?.find(sb => sb.index === i);
      if (filled && solved) {
        return `<span class="blank-word filled-blank">${solved.word}</span>`;
      }
      return `<span class="blank-word">${'_'.repeat(Math.max(blank?.original?.length || 3, 3))}</span>`;
    }
    return w;
  }).join(' ');

  // My score
  const me = game.players && game.players[myId];
  myScore.textContent = me ? me.score : 0;

  // Leaderboard
  const sorted = Object.entries(game.players || {})
    .sort(([, a], [, b]) => (b.score || 0) - (a.score || 0));
  leaderboard.innerHTML = sorted.map(([id, p], i) =>
    `<div class="leaderboard-entry">
      <span class="rank">#${i + 1}</span>
      <span class="name">${p.name}${id === myId ? ' (you)' : ''}</span>
      <span class="score">${p.score || 0}</span>
    </div>`
  ).join('');

  // Re-focus guess input
  guessInput.focus();
}

// ---------------------------------------------------------------------------
// Guess submission
// ---------------------------------------------------------------------------
guessInput.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const guess = guessInput.value.trim();
  if (!guess || !currentRoom) return;

  guessInput.value = '';
  feedback.className = 'feedback';

  const gameRef = ref(db, `games/${currentRoom}`);

  // Read current state
  const snap = await new Promise(resolve => {
    onValue(gameRef, resolve, { onlyOnce: true });
  });
  const game = snap.val();
  if (!game || game.status !== 'playing' || !game.currentVerse) {
    feedback.textContent = 'Game is not active.';
    feedback.className = 'feedback wrong';
    return;
  }

  // Check if already answered
  if (game.currentVerse.answered && game.currentVerse.answered[myId]) {
    feedback.textContent = 'You already answered this round!';
    feedback.className = 'feedback info';
    return;
  }

  const cv = game.currentVerse;
  const { correct, matched } = checkGuess(guess, cv.blanks);

  if (!correct) {
    feedback.textContent = `"${guess}" is not correct. Try again!`;
    feedback.className = 'feedback wrong';
    return;
  }

  // Correct!
  const blank = cv.blanks.find(b => b.clean === matched.toLowerCase());
  if (!blank) return;

  feedback.textContent = `✅ Correct! "${matched}"`;
  feedback.className = 'feedback correct';

  // Track which player solved which blank
  if (!cv.answered) cv.answered = {};
  if (!cv.solvedBlanks) cv.solvedBlanks = [];

  cv.answered[myId] = { word: matched, guess, time: Date.now() };

  // Avoid duplicate blank solutions
  if (!cv.solvedBlanks.find(sb => sb.index === blank.index)) {
    cv.solvedBlanks.push({
      index: blank.index,
      word: matched,
      solvedBy: myId,
    });

    // Award points: +10, +5 bonus for first to solve any blank
    if (!game.players[myId]) game.players[myId] = { name: myName, score: 0 };
    const pts = cv.solvedBlanks.length === 1 ? 15 : 10;
    game.players[myId].score = (game.players[myId].score || 0) + pts;
  }

  // Check if all blanks are solved
  if (cv.solvedBlanks.length >= cv.blanks.length) {
    // All blanks filled — advance
    await advanceRound(game);
  } else {
    // Some blanks still open
  }

  // Save to Firebase
  await set(gameRef, game);
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
function renderResults(game) {
  const sorted = Object.entries(game.players || {})
    .sort(([, a], [, b]) => (b.score || 0) - (a.score || 0));

  const medals = ['🥇', '🥈', '🥉'];
  finalLeaderboard.innerHTML = sorted.map(([id, p], i) =>
    `<div class="final-entry ${i < 3 ? 'rank-' + (i + 1) : ''}">
      <span class="rank">${medals[i] || `#${i + 1}`}</span>
      <span class="name">${p.name}</span>
      <span class="score">${p.score || 0} pts</span>
    </div>`
  ).join('');
}

btnPlayAgain.addEventListener('click', async () => {
  if (!currentRoom) return;
  // Reset game
  const gameRef = ref(db, `games/${currentRoom}`);
  const snap = await new Promise(resolve => {
    onValue(gameRef, resolve, { onlyOnce: true });
  });
  const game = snap.val();
  game.status = 'lobby';
  game.round = 0;
  game.currentVerse = null;
  Object.values(game.players).forEach(p => p.score = 0);
  await set(gameRef, game);
  showScreen('room');
});

btnBackLobby.addEventListener('click', () => {
  cleanup();
  showScreen('lobby');
  refreshActiveRooms();
});

btnLeave.addEventListener('click', async () => {
  if (currentRoom && myId) {
    await remove(ref(db, `rooms/${currentRoom}/players/${myId}`));
  }
  cleanup();
  showScreen('lobby');
  refreshActiveRooms();
});

function cleanup() {
  gameUnsubscribers.forEach(fn => fn());
  gameUnsubscribers = [];
  currentRoom = null;
  currentGameId = null;
  isHost = false;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
showScreen('lobby');
refreshActiveRooms();

// Auto-focus player name
playerNameInput.focus();
