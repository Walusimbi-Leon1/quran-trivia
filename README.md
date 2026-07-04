# 📖 Bible Game

A multiplayer Bible verse guessing game. Players see a verse from the **SGSS Bible** with key words blanked out. The first player to type the correct missing word wins points.

Play on **Discord**, **Telegram**, or directly in your **browser** — all using the same Firebase-backed game engine.

**[🌐 Play Now → https://bible-game-4mh.pages.dev](https://bible-game-4mh.pages.dev)**
**[✈️ Telegram Bot: @bible_game_21_bot](https://t.me/bible_game_21_bot)**

---

## 🎮 How It Works

1. A random verse from the SGSS Bible is displayed
2. One or two **significant words** (like "Christ", "prophet", "salvation") are replaced with `___` blanks
3. Every player in the room sees the same verse with the same blanks
4. Players type the word they think fills the blank
5. **First correct answer** for each blank gets the points
6. When all blanks are filled, the next verse appears
7. The game runs for 10 rounds, then declares a winner

### Scoring
- **15 pts** — First to solve a blank in the round
- **10 pts** — Each subsequent blank solved

---

## 🚀 Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/Walusimbi-Leon1/bible-game.git
cd bible-game
npm install
```

### 2. Seed the Verses

The game needs verses in Firebase RTDB. First, add your SGSS Bible verse files to `verse-data/` as JSON arrays, then:

```bash
export FIREBASE_SA='{ "type": "service_account", ... }'
npm run seed
```

Sample verses are included in `verse-data/sample.json` — 40 well-known verses to get started.

### 3. Choose Your Platform

| Platform | Command | Env Vars |
|---|---|---|
| **Web** | `npm run web` | None (Firebase keys are client-safe) |
| **Discord** | `npm run discord` | `DISCORD_TOKEN`, `FIREBASE_SA` |
| **Telegram** | `npm run telegram` | `TELEGRAM_TOKEN`, `FIREBASE_SA` |

---

## 🌐 Web App

Play directly in any browser with real-time multiplayer.

```
npm run web
# → http://localhost:4000
```

### Features
- **Real-time rooms** — Create or join a room, all players see the same game
- **Auto-completing blanks** — When someone guesses correctly, the blank fills in for everyone
- **Firebase sync** — Game state updates in real time across all players
- **Responsive** — Works on desktop and mobile

### How to Play
1. Enter your name
2. Create a room (or leave blank for a random room code)
3. Share the room code with friends
4. Click **Start Game**
5. Type the missing word and press **Enter**
6. Watch real-time leaderboard updates

---

## 💬 Discord Bot

Add the bot to your server and play in any text channel.

### Commands

| Command | Description |
|---|---|
| `/play` | Start a new game or join an existing one |
| `/guess <word>` | Submit your guess for the missing word |
| `/leaderboard` | Show the scoreboard |
| `/leave` | Leave the current game |
| `/verses` | Show how many verses are loaded |

### Setup

1. Create a bot at https://discord.com/developers/applications
2. Enable **Message Content Intent** in the Bot settings
3. Copy the bot token
4. Run:
```bash
export DISCORD_TOKEN="your-bot-token"
export FIREBASE_SA='{"type":"service_account",...}'
npm run discord
```

### Guild-Specific Commands
Set `GUILD_ID` to register commands instantly in a dev guild:
```bash
export GUILD_ID="your-guild-id"
```

---

## ✈️ Telegram Bot

### Commands

| Command | Description |
|---|---|
| `/play` | Start a new game or join an existing one |
| `/guess <word>` | Submit your guess |
| `/leaderboard` | Show the scoreboard |
| `/leave` | Leave the game |
| `/verses` | Show verse count |
| `/start` | Show help |

### Setup

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Copy the token
3. Set the secret:
   ```bash
   cd telegram-worker
   npx wrangler secret put TELEGRAM_TOKEN
   ```
4. Deploy:
   ```bash
   cd telegram-worker
   npx wrangler deploy
   ```
5. Set the webhook:
   ```bash
   curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{"url":"https://bible-game-telegram.YOUR-SUBDOMAIN.workers.dev/api/webhook"}'
   ```

The bot runs as a **Cloudflare Worker** at `https://bible-game-telegram.walusimbileon2.workers.dev`.
Uses Firebase RTDB REST API (no Node.js dependency needed).

---

## 🗂️ Project Structure

```
bible-game/
├── shared/
│   ├── game-engine.js       # Core game logic (verse masking, guessing, scoring)
│   └── firebase-config.js   # Firebase configuration
├── verse-data/
│   └── sample.json          # SGSS Bible verses (add your full Bible here!)
├── web/
│   ├── index.html           # Web app entry point
│   ├── style.css            # Web app styles
│   └── app.js               # Web app logic (Firebase realtime)
├── discord/
│   ├── package.json         # Discord bot dependencies
│   └── index.js             # Discord bot
├── telegram/
│   ├── package.json         # Telegram bot dependencies (Node.js)
│   └── index.js             # Telegram bot (Node.js — legacy)
├── telegram-worker/
│   ├── wrangler.toml        # Cloudflare Worker config
│   └── index.js             # Telegram bot (Cloudflare Worker — live)
├── scripts/
│   ├── seed-firebase.js     # Seed Firebase RTDB with verses
│   └── import-verses.js     # Import SGSS Bible from text format
├── .github/workflows/
│   └── deploy.yml           # GitHub Pages deployment
└── package.json
```

---

## 📚 Adding SGSS Bible Verses

The full SGSS Bible goes into `verse-data/` as JSON files. Each verse has this format:

```json
{
  "ref": "John 3:16",
  "book": "John",
  "chapter": 3,
  "verse": 16,
  "text": "For God so loved the world that He gave His only begotten Son..."
}
```

### Import from text format

Prepare a text file with one verse per line:

```
Genesis 1:1 | In the beginning God created the heavens and the earth
Exodus 20:1 | And God spoke all these words saying
```

Then run:

```bash
node scripts/import-verses.js verses.txt
```

This generates `verse-data/sgss-bible.json`. Then seed to Firebase:

```bash
npm run seed
```

---

## 🔧 Firebase Setup

This game uses **Firebase Realtime Database** for:

- **Verse storage** — All SGSS Bible verses under `/verses/`
- **Game state** — Active games under `/games/` (web app)
- **Rooms** — Room/player management under `/rooms/`

The web app uses the Firebase **Web SDK** (public-facing config, safe to embed).

Node bots use **firebase-admin** with a service account (set via `FIREBASE_SA` env var).

### Database Structure

```
/verses/
  /{Book}/
    /{Chapter}/
      /{Verse}/
        ref: "John 3:16"
        book: "John"
        chapter: 3
        verse: 16
        text: "For God so loved the world..."

/rooms/
  /{roomCode}/
    status: "lobby" | "playing"
    hostId: "{playerId}"
    playerCount: 2
    players/
      /{playerId}/
        name: "Leon"
        score: 0

/games/
  /{roomCode}/
    status: "playing" | "finished"
    round: 5
    maxRounds: 10
    currentVerse: { ... }
    players: { ... }
```

---

## 🤝 Contributing

1. Fork the repo
2. Create a feature branch
3. Make your changes
4. Push and submit a PR

---

## 📄 License

MIT

---

*Built with 🥒 by Leon AI 4*
