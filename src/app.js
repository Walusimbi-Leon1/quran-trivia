/**
 * Quran Trivia 🕌 — client
 *
 * Single GLOBAL room. Every player sees the same question at the same time:
 *   slot = floor((now - game.questionStart) / slotDuration)
 *   question = bank[slot % bank.length]
 * Questions rotate continuously (20s each), generated from the SGSS Quran by
 * opencode.ai big-pickle via the GitHub Actions pipeline. Speed-based scoring:
 * first correct answer in a slot scores highest. Players + scores persist in
 * Firebase — leaving never deletes them.
 */

import { initDiscord, isDiscord, inDiscordFrame } from "./discord.js";
import { dbRead, dbWrite, dbUpdate, dbDelete } from "./firebase.js";

// ── Constants ────────────────────────────────────────────────────────────────
const SLOT_DURATION = 20000;   // must match worker
const TOP_UP_THRESHOLD = 20;   // request more questions when fewer remain
const PLAYER_BATCH_SIZE = 50;  // fetch top 50 players + self for leaderboard

// ── State ────────────────────────────────────────────────────────────────────
let me = { id: null, username: "Guest", avatarUrl: "", score: 0 };
let game = null;       // { questionStart, slotDuration, bankLen }
let bank = [];         // array of { question, options, correctAnswer, ref? }
let players = {};      // uid → player
let answers = {};      // uid → { answer, at } for current slot
let offset = 0;        // clock offset (server - client)
let currentSlot = -1;
let myAnswer = null;
let hasAnswered = false;
let revealed = false;
let requestingBank = false;
let lastAnswerGain = 0;

const $ = (id) => document.getElementById(id);
const now = () => Date.now() + offset;

// ── SVG icon helpers (crisp at any size, no plain emoji) ────────────────────
const DISCORD_LOGO =
  '<svg viewBox="0 0 127.14 96.36" aria-hidden="true"><path fill="currentColor" d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-39.11 0A72.37 72.37 0 0 0 35.64 0 105.89 105.89 0 0 0 9.39 8.09C-7.21 32.65-1.71 56.6.54 80.21h0A105.73 105.73 0 0 0 32.71 96.36a77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1A105.25 105.25 0 0 0 126.6 80.22h0C129.24 52.84 122.09 29.11 107.7 8.07ZM42.45 65.69C36.18 65.69 31 60 31 53s5-12.74 11.43-12.74S54 46 53.89 53 48.84 65.69 42.45 65.69Zm42.24 0C78.41 65.69 73.25 60 73.25 53s5-12.74 11.44-12.74S96.23 46 96.12 53 91.08 65.69 84.69 65.69Z"/></svg>';
const GLOBE_LOGO =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12h18M12 3c3.2 3.6 3.2 14.4 0 18M12 3c-3.2 3.6-3.2 14.4 0 18" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
function starSvg(size = 14) {
  return `<svg class="star" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2.6l2.85 6.02 6.65.82-4.9 4.56 1.28 6.56L12 17.3l-5.88 3.26 1.28-6.56-4.9-4.56 6.65-.82z"/></svg>`;
}
function crownSvg(size = 14) {
  return `<svg class="crown" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 17V9.5l4.5 3.5L12 7.5l4.5 5.5L21 9.5V17z"/></svg>`;
}
function rankBadge(rank) {
  if (rank === 1) return `<span class="rank-badge gold" title="#1">${crownSvg(15)}</span>`;
  if (rank === 2) return `<span class="rank-badge silver" title="#2">2</span>`;
  if (rank === 3) return `<span class="rank-badge bronze" title="#3">3</span>`;
  return `<span class="rank-badge n">${rank}</span>`;
}
function platformBadge(p) {
  if (p?.platform === "discord") return `<span class="plat-badge discord" title="Playing from Discord">${DISCORD_LOGO}</span>`;
  return `<span class="plat-badge browser" title="Playing in browser">${GLOBE_LOGO}</span>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function initials(name) {
  return (name || "?").trim().charAt(0).toUpperCase() || "?";
}
function avatarHtml(player, size = 40) {
  const name = escapeHtml(initials(player?.username));
  const style = `width:${size}px;height:${size}px`;
  if (player?.avatarUrl) {
    return `<img class="avatar" style="${style}" src="${escapeHtml(player.avatarUrl)}" alt="" onerror="this.outerHTML='<span class=&quot;avatar avatar-fallback&quot; style=&quot;${style}&quot;>${name}</span>'">`;
  }
  return `<span class="avatar avatar-fallback" style="${style}">${name}</span>`;
}
function bankArray(obj) {
  if (!obj || typeof obj !== "object") return [];
  return Object.keys(obj)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => obj[k])
    .filter(Boolean);
}
function showScreen(name) {
  ["loading", "error", "game"].forEach((s) => {
    const el = $(`screen-${s}`);
    if (el) el.classList.toggle("hidden", s !== name);
  });
}

// ── Question timing (deterministic, shared by all players) ──────────────────
// slot = floor((now - game.questionStart) / slotDuration)
// Each slot maps to bank[slot % bank.length]. The worker resets questionStart
// to `now` whenever the slot counter runs past the bank length (clock
// exhaustion), so the slot normally stays within bounds. The modulo here is a
// final safety net: even if the clock drifts, the game never shows a blank /
// stuck screen — it wraps around and keeps showing questions. The worker's
// /api/trivia restart resets questionStart, so the slot resets to 0 on the
// next syncGameClock() call.
function currentQuestion() {
  if (!game || !game.questionStart || !bank.length) return null;
  const duration = game.slotDuration || SLOT_DURATION;
  const elapsed = Math.max(0, now() - game.questionStart);
  const slot = Math.floor(elapsed / duration);

  // Wrap around if we somehow exceed bank length (shouldn't happen with
  // proper worker restarts, but safe fallback)
  const index = slot % bank.length;
  const q = bank[index];
  if (!q) return null;

  return {
    slot,
    index: slot + 1,          // human-friendly "Question #N"
    question: q,
    slotStart: game.questionStart + slot * duration,
    slotEnd: game.questionStart + (slot + 1) * duration,
  };
}

// ── Firebase paths ──────────────────────────────────────────────────────────
const P = "quran/global";

// ── Realtime sync (robust polling) ─────────────────────────────────────────
// NOTE: Firebase SSE through the Cloudflare Worker proxy freezes after the
// initial snapshot (verified 2026-08-08) — live updates never arrive. So we
// poll players + the current slot's answers every few seconds instead. The
// game is 20s/slot, so 3s polling keeps everything fresh with tiny load.
async function syncPlayers() {
  try {
    // First, get shallow list of player IDs to know who exists
    const shallow = await dbRead(`${P}/players?shallow=true`).catch(() => {});
    const playerIds = shallow && typeof shallow === "object" ? Object.keys(shallow) : [];
    
    if (!playerIds.length) {
      players = {};
      renderLeaderboard();
      renderPresence();
      return;
    }

    // Get current user's data first (always needed)
    const meData = await dbRead(`${P}/players/${me.id}`).catch(() => null);
    if (meData && typeof meData === "object") {
      players[me.id] = meData;
    }

    // Fetch top players by score for leaderboard (limit to PLAYER_BATCH_SIZE)
    // We'll get a sample and sort locally - in production you'd want Firebase queries
    const topPlayers = {};
    let fetchedCount = 0;
    
    // Prioritize: self + recent active players + high scorers
    const priorityIds = [me.id]; // always include self
    
    // Add some random sample to get variety (avoid bias)
    const sampleSize = Math.min(PLAYER_BATCH_SIZE - 1, playerIds.length - 1);
    const otherIds = playerIds.filter(id => id !== me.id);
    
    // Shuffle and take sample
    for (let i = otherIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [otherIds[i], otherIds[j]] = [otherIds[j], otherIds[i]];
    }
    priorityIds.push(...otherIds.slice(0, sampleSize));
    
    // Fetch prioritized players
    for (const id of priorityIds) {
      if (fetchedCount >= PLAYER_BATCH_SIZE) break;
      if (!id || players[id]) continue; // skip if already have
      
      try {
        const data = await dbRead(`${P}/players/${id}`).catch(() => null);
        if (data && typeof data === "object") {
          players[id] = data;
          fetchedCount++;
        }
      } catch (e) {
        // ignore individual fetch errors
      }
    }
    
    // Ensure we have at least some players if we had any
    if (Object.keys(players).length === 0 && playerIds.length > 0) {
      // Fallback: fetch first few players
      for (let i = 0; i < Math.min(5, playerIds.length); i++) {
        const id = playerIds[i];
        if (!id) continue;
        try {
          const data = await dbRead(`${P}/players/${id}`).catch(() => null);
          if (data && typeof data === "object") {
            players[id] = data;
          }
        } catch (e) {}
      }
    }
    
    renderLeaderboard();
    renderPresence();
  } catch (e) {
    console.warn("[syncPlayers] error:", e);
    // Degrade gracefully - keep existing players data
    renderLeaderboard();
    renderPresence();
  }
}

const syncAnswers = async () => {
  if (currentSlot < 0) return;
  try {
    const data = await dbRead(`${P}/answers/${currentSlot}`).catch(() => null);
    if (data && typeof data === "object") {
      answers = data;
      refresh();
    }
  } catch (e) {
    /* keep last known state */
  }
};

const beat = () => {
  // Don't save bandwidth while tab is hidden - visibility is handled in startSync
  syncPlayers();
  syncAnswers();
};

function startSync() {
  const visible = () => document.visibilityState !== "hidden";

  beat();
  setInterval(syncPlayers, 5000);      // Reduced from 3000ms to 5000ms
  setInterval(syncAnswers, 1000);      // Increased answer polling for responsiveness
  setInterval(() => {
    // Periodic full refresh every 30 seconds
    syncPlayers().then(() => {
      if (game && currentSlot >= 0) {
        loadSlotAnswers(currentSlot);
      }
    });
  }, 30000);
  
  document.addEventListener("visibilitychange", () => {
    if (visible()) {
      syncPlayers();
      syncAnswers();
    }
  });
};

// ── Boot: identity ──────────────────────────────────────────────────────────
async function resolveIdentity() {
  const discordInfo = await initDiscord();
  if (discordInfo.user) {
    return {
      id: "u" + discordInfo.user.id,
      username: discordInfo.user.global_name || discordInfo.user.username || "Player",
      avatarUrl: `https://cdn.discordapp.com/avatars/${discordInfo.user.id}/${discordInfo.user.avatar || "0"}.png`,
      platform: "discord",
    };
  }
  // Guest: stable id in localStorage so scores persist across reloads.
  // Browser and Discord-fallback guests use SEPARATE keys, so the same person
  // playing in a Discord Activity AND a browser tab gets two distinct records
  // instead of the two sessions fighting over one id.
  const key = inDiscordFrame ? "bt_guest_id_discord" : "bt_guest_id";
  let gid = null;
  try {
    gid = localStorage.getItem(key);
  } catch (e) { /* private mode */ }
  if (!gid) {
    gid = "g" + Math.random().toString(36).slice(2, 10);
    try {
      localStorage.setItem(key, gid);
    } catch (e) { /* ignore */ }
  }
  return {
    id: gid,
    username: guestNameFromId(gid),  // stable + unique per session
    avatarUrl: "",
    platform: isDiscord ? "discord" : "browser",
  };
}

// Deterministic guest name derived from the id: stable across reloads and
// unique per session (no shared localStorage name collisions).
function guestNameFromId(gid) {
  let sum = 0;
  for (const c of gid) sum = (sum * 31 + c.charCodeAt(0)) % 997;
  return "Guest " + (100 + (sum % 900));
}

// ── Sync clock with the worker ──────────────────────────────────────────────
async function syncTime() {
  try {
    const res = await fetch("/api/time");
    if (res.ok) {
      const data = await res.json();
      offset = data.now - Date.now();
      if (data.game && (!game || !game.questionStart)) game = data.game;
    }
  } catch (e) {
    /* keep previous offset */
  }
}

// ── Join (persistent player record) ─────────────────────────────────────────
async function joinGlobal() {
  const existing = await dbRead(`${P}/players/${me.id}`).catch(() => null);
  if (existing && typeof existing === "object") {
    me.score = existing.score || 0;
    await dbUpdate(`${P}/players/${me.id}`, {
      username: me.username,
      avatarUrl: me.avatarUrl,
      platform: isDiscord ? "discord" : "browser",
      online: true,
      lastSeen: Date.now(),
    });
  } else {
    await dbWrite(`${P}/players/${me.id}`, {
      id: me.id,
      username: me.username,
      avatarUrl: me.avatarUrl,
      platform: isDiscord ? "discord" : "browser",
      score: 0,
      online: true,
      lastSeen: Date.now(),
      joinedAt: Date.now(),
    });
  }
}

// ── Main loop ───────────────────────────────────────────────────────────────
async function boot() {
  showScreen("loading");

  // OAuth popup (Discord web-client authorize): show confirmation, don't boot.
  if (window.opener && !window.opener.closed) {
    $("screen-loading").classList.add("hidden");
    $("screen-error").classList.add("hidden");
    const gs = $("screen-game");
    gs.classList.remove("hidden");
    gs.innerHTML = `<div class="card center-box" style="min-height:40vh">
      <div style="font-size:52px">✅</div>
      <h2>You're connected!</h2>
      <p class="muted">Return to the game — your Discord name is ready.</p>
    </div>`;
    return;
  }

  const identity = await resolveIdentity();
  me = identity;
  renderHeader();

  // Every step is independently resilient — one failure must never brick the
  // whole game. Firebase writes failing (sandbox restrictions, rate limits)
  // degrade to local-only play instead of an error screen.
  const fails = [];
  await syncTime();
  try {
    await joinGlobal();
  } catch (err) {
    fails.push("join: " + (err.message || err));
  }
  await ensureBank();
  startSync();
  startPresence();

  setInterval(tick, 100);
  setInterval(syncTime, 5 * 60 * 1000);
  $("btn-retry").onclick = () => window.location.reload();

  if (fails.length) {
    console.warn("Degraded boot:", fails);
    // still playable — local mode with the live question stream
  }
}

// ── Optimized presence (30s heartbeat) ─────────────────────────────────────
const LIVE_STALE_MS = 180000; // 3 min without a heartbeat → offline

function renderPresence() {
  const online = Object.values(players).filter(
    (p) => p.online && Date.now() - Number(p.lastSeen) < LIVE_STALE_MS
  ).length;
  $("online-count").textContent = online;
}

function startPresence() {
  const beat = async () => {
    try {
      await dbUpdate(`${P}/players/${me.id}`, {
        online: document.visibilityState !== "hidden",
        lastSeen: Date.now(),
      });
    } catch (e) { /* ignore */ }
  };
  beat();
  setInterval(beat, 30000);
  document.addEventListener("visibilitychange", beat);
  window.addEventListener("beforeunload", () => {
    try {
      dbUpdate(`${P}/players/${me.id}`, { online: false, lastSeen: Date.now() });
    } catch (e) { /* ignore */ }
  });
}

// ── Leaderboard rendering (optimized) ─────────────────────────────────────
function renderLeaderboard() {
  const lb = $("leaderboard");
  if (!lb) return;

  // Convert players object to array, sort by score descending
  const playerList = Object.entries(players || {})
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  // Take top 7, but ensure current user is always included
  const top7 = playerList.slice(0, 7);
  const meIndex = playerList.findIndex(p => p.id === me.id);
  
  let displayList = [...top7];
  if (meIndex >= 7 && !top7.some(p => p.id === me.id)) {
    // Replace last entry with current user if not in top 7
    displayList = [...top7.slice(0, 6), playerList[meIndex]];
  }

  lb.innerHTML = "";
  displayList.forEach((p, idx) => {
    const div = document.createElement("div");
    div.className = "lb-entry";
    div.innerHTML = `
      <div class="rank">${idx + 1}</div>
      <div class="avatar"><img src="${p.avatarUrl || "https://via.placeholder.com/40"}" onerror="this.src='https://via.placeholder.com/40'" alt="" width="40" height="40"></div>
      <div class="info">
        <div class="name">${escapeHtml(p.username || "Anonymous")}</div>
        <div class="score">${p.score || 0}</div>
      </div>
      <div class="indicator ${p.online && Date.now() - Number(p.lastSeen) < LIVE_STALE_MS ? "online" : "offline"}"></div>
    `;
    lb.appendChild(div);
  });
}

// ── Bootstrap ───────────────────────────────────────────────────────────────
boot();