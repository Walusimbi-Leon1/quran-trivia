# 🕌 Quran Trivia

**Fast-paced multiplayer Quran trivia for Discord Activities** — the Muslim community's own version of Bible Trivia, powered by the **SGSS Quran** (Sahih International translation in simple, easy English).

## 🌐 Live

- **Play:** https://quran-trivia.walusimbileon1.workers.dev
- **Source scripture:** https://github.com/Walusimbi-Leon1/sgss-quran (114 surahs · 6,236 verses)
- **Sister game:** [Bible Trivia](https://github.com/Walusimbi-Leon1/bible-game) · [Trivia Rumble 4](https://github.com/Walusimbi-Leon1/trivia-rumble-4)

## 🎮 How It Works

Built exactly like Bible Trivia / Trivia Rumble 4:

- **One global arena** — every player sees the same question at the same time
- **20-second question slots** — the clock never stops
- **Speed-based scoring** — the first correct answer in a slot scores highest
- **Persistent leaderboard** — players and scores live in Firebase; leaving never deletes them
- **No rooms to set up** — join and play instantly

Questions rotate continuously, drawn from the **SGSS Quran** — a simplified, easy-English presentation of the Sahih International translation. Every question is tagged with its surah reference (e.g. "Al-Baqara 2:255") so players can look it up.

## 🏗️ Architecture

```
quran-trivia/
├── worker.js               ← Cloudflare Worker (game server + static hosting)
├── src/                    ← client (index.html, app.js, firebase.js, discord.js…)
├── build.js                ← inlines src → dist/worker.js
├── deploy.sh               ← raw API deploy (fallback)
├── wrangler.toml           ← worker config (quran-trivia)
├── scripts/
│   └── generate-questions.js  ← batch question generator (big-pickle)
└── .github/workflows/
    └── generate-questions.yml ← every 30 min: refill the question bank
```

### Question pipeline

| Piece | How |
|---|---|
| **Source** | [SGSS Quran](https://github.com/Walusimbi-Leon1/sgss-quran) — Sahih International, simple easy English |
| **Generator** | GitHub Actions every 30 min → fetches random surahs → big-pickle (opencode.ai) creates questions → appends to Firebase bank |
| **Model** | `big-pickle` via opencode.ai (reasoning model, big token budget → reliable JSON) |
| **Bank** | Firebase Realtime Database, namespace `quran/global` (shared RTDB, isolated from Bible Trivia's `bible/global`) |
| **Clock** | 20s/question, runs 24/7 → drains ~180 Q/h; generator keeps ~2h runway |
| **Fallback** | 320-question built-in Quran bank in worker.js (instant seed if AI is unreachable) |

### Firebase layout

```
quran/global/
├── game/      { questionStart, slotDuration, bankLen, startedAt }
├── bank/<i>   { question, options, correctAnswer, ref }
├── players/<uid>  { id, username, avatarUrl, score, lastSeen, online }
├── answers/<slot>/<uid>  { answer, at }
└── meta/      { generating, used: [...] }
```

## 🔑 Secrets (never in the repo)

| Secret | Where | Used for |
|---|---|---|
| `OPENCODE_API_KEY` | GitHub Actions secret | question generation |
| `DISCORD_CLIENT_SECRET` | Cloudflare Worker secret | Discord OAuth exchange |
| `DISCORD_CLIENT_ID` | public, in `wrangler.toml` + `src/discord.js` | Discord SDK |

## 🚀 Deploy

```bash
# Build + deploy via wrangler (enables workers.dev subdomain + keeps secrets)
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… npx -y wrangler@4 deploy
```

## ⚖️ Privacy & Terms

- [Privacy Policy](/privacy)
- [Terms of Service](/terms)
- Questions sourced from the **SGSS Quran** (Sahih International translation, used for non-commercial purposes)

💛 **[Support Developer](https://walusimbi-leon1.github.io/voice-support/)**

---

Built for the Muslim community on Discord 🕌
