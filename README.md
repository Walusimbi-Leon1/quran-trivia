# 📖 Bible Trivia

**Fast-paced multiplayer Bible trivia for Discord Activities — and the browser.**

One global arena. Every player who opens the game sees the **same question at
the same time** — 20 seconds each, rotating continuously. Answer fast: the
first correct answer scores the most (100 pts, minus 5 per second, min 10).

Every question is **based on the SGSS Bible** — the simplified, easy-English
KJV adaptation — and tagged with its reference (e.g. *John 3:16*) so you can
look it up and learn as you play.

**Live:** https://bible-trivia.walusimbileon1.workers.dev
**Repo:** https://github.com/Walusimbi-Leon1/bible-game
**SGSS Bible:** https://github.com/Walusimbi-Leon1/sgss-bible

## 🎮 How to Play

1. **Open the game** — in a Discord voice channel via the Activities menu, or
   in any browser. There is **no room setup**: everyone plays together in the
   one global arena. A single player can start immediately.
2. **Questions rotate automatically** — same question for everyone, 20 seconds
   on the clock. Pick the right answer before time runs out.
3. **Speed scoring** — the first player to answer correctly gets the most
   points. Wrong or missed answers score nothing.
4. **Leaderboard** — top 20 players by score, live. Your name, avatar and
   score persist in Firebase: leave and come back later, your score is still
   there.

## 🛠️ Architecture

Built on the proven Discord Activity pattern (Trivia Rumble Elite / Dice
Arena / Arrow Blast):

- **Single global room** — all game state lives under `bible/global` in
  Firebase Realtime Database (`bible-game-21-default-rtdb`):
  - `game` — `{ questionStart, slotDuration, bankLen }`
  - `bank/<i>` — question bank (question + options + correct answer + ref)
  - `players/<uid>` — **persistent** player records (score survives leaving)
  - `answers/<slot>/<uid>` — per-question answers
- **Deterministic question timing** — every client computes the current
  question from shared state: `slot = floor((now - questionStart) / 20s)`,
  `question = bank[slot % bank.length]`. All players see the same question at
  the same time, with clock sync via `/api/time`.
- **Question generation (GitHub Actions)** — the game clock drains ~180
  questions/hour (20s each, runs 24/7). A scheduled workflow
  (`.github/workflows/generate-questions.yml`) runs every 30 minutes: it
  fetches **random chapters straight from the SGSS Bible repo**, hands the
  passage text to **opencode.ai (big-pickle model)**, and writes the fresh
  questions into the Firebase bank — keeping ~2 hours of runway. It runs from
  GitHub runners because **opencode.ai blocks Cloudflare Workers egress**
  (error 1042) — the worker itself can never reach it. The worker keeps a
  built-in Bible bank as emergency fallback, and resets the question clock
  when the game is badly behind (instant recovery from "Preparing new
  questions…"). Manual refill: `Actions → Generate Bible Trivia Questions →
  Run workflow`. Repo secret: `OPENCODE_API_KEY`.
- **Discord integration** — vendored same-origin `@discord/embedded-app-sdk`,
  `authorize()` handles both OAuth shapes (PKCE access_token directly, or
  confidential code → `/api/exchange`), timeouts, and graceful guest fallback.
- **Data layer** — Firebase accessed only through the worker's same-origin
  proxy (`/firebase/*` REST + `/firebase/stream/*` SSE), because the Discord
  sandbox blocks direct `firebaseio.com` calls.

## 🚀 Deploy

```bash
node build.js        # inlines src/* into dist/worker.js
CF_API_TOKEN=... DISCORD_CLIENT_ID=... DISCORD_CLIENT_SECRET=... ./deploy.sh
```

Environment variables (deploy.sh / wrangler.toml [vars]):

| Var | Purpose |
| --- | --- |
| `DISCORD_CLIENT_ID` | Discord application client ID |
| `DISCORD_CLIENT_SECRET` | Discord application client secret (worker secret) |
| `REDIRECT_URI` | OAuth redirect — the worker's own URL, must match the Discord portal registration exactly |
| `OPENCODE_API_KEY` | opencode.ai API key (question generation; also the GitHub Actions secret) |
| `MODEL` | Model name, e.g. `big-pickle` |
| `FB_HOST` | Firebase RTDB host (defaults to `bible-game-21-default-rtdb.firebaseio.com`) |

## 📋 Discord Developer Portal setup

1. Application named **Bible Trivia** (create it — you'll get a client ID and
   client secret).
2. **OAuth2 → Redirects**: add `https://bible-trivia.walusimbileon1.workers.dev`
3. **General Information → Activity**: set the Activity URL to
   `https://bible-trivia.walusimbileon1.workers.dev/`
4. Invite the app to a server and launch the Activity from a voice channel.

## 📄 Files

- `src/` — client source (HTML, CSS, JS, vendored Discord SDK)
- `worker.js` — Cloudflare Worker source (routing, OAuth exchange, question
  generation, Firebase proxies, built-in Bible bank)
- `scripts/generate-questions.js` — SGSS-Bible-sourced question generator
  (GitHub Actions)
- `.github/workflows/generate-questions.yml` — 30-min question refill schedule
- `build.js` — inlines `src/*` into `dist/worker.js`
- `deploy.sh` / `wrangler.toml` — deployment

---
*Bible Trivia — built on the SGSS Bible. Not affiliated with Discord Inc.*
