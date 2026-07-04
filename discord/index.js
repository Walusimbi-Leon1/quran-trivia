/**
 * Bible Game — Discord Bot
 * 
 * Slash commands:
 *   /play          — Start or join a Bible Game in this channel
 *   /guess <word>  — Submit a guess for the current verse
 *   /leaderboard   — Show the scoreboard
 *   /leave         — Leave the current game
 *   /verses        — Show verse count in the database
 * 
 * Environment:
 *   DISCORD_TOKEN      — Bot token
 *   FIREBASE_SA        — Firebase service account JSON (stringified)
 *   GUILD_ID           — (optional) For dev guild command registration
 */

import { Client, GatewayIntentBits, REST, Routes, EmbedBuilder } from 'discord.js';
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
// Game state (per channel)
// ---------------------------------------------------------------------------
const games = new Map(); // channelId -> game state

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
    blankMap.has(i) ? `**\\_\\_\\_**` : w
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
// Discord client
// ---------------------------------------------------------------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const commands = [
    {
      name: 'play',
      description: 'Start or join a Bible Game in this channel',
    },
    {
      name: 'guess',
      description: 'Submit a guess for the missing word',
      options: [{
        name: 'word',
        description: 'Your guess for the missing word',
        type: 3, // STRING
        required: true,
      }],
    },
    {
      name: 'leaderboard',
      description: 'Show the current scoreboard',
    },
    {
      name: 'leave',
      description: 'Leave the current game',
    },
    {
      name: 'verses',
      description: 'Show how many verses are loaded in the database',
    },
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    if (process.env.GUILD_ID) {
      // Dev guild — instant registration
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID),
        { body: commands },
      );
      console.log(`  → Registered in guild ${process.env.GUILD_ID}`);
    } else {
      // Global — takes up to 1h to propagate
      await rest.put(
        Routes.applicationCommands(client.user.id),
        { body: commands },
      );
      console.log('  → Registered globally');
    }
  } catch (err) {
    console.error('Command registration failed:', err);
  }
});

// ---------------------------------------------------------------------------
// Slash command handler
// ---------------------------------------------------------------------------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, channelId, user } = interaction;

  switch (commandName) {
    case 'play': return handlePlay(interaction);
    case 'guess': return handleGuess(interaction);
    case 'leaderboard': return handleLeaderboard(interaction);
    case 'leave': return handleLeave(interaction);
    case 'verses': return handleVerses(interaction);
  }
});

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

async function handlePlay(interaction) {
  await interaction.deferReply();

  const { channelId, user } = interaction;

  // Check existing game
  if (games.has(channelId)) {
    const g = games.get(channelId);
    if (g.players[user.id]) {
      await interaction.editReply('You are already in the game!');
      return;
    }
    // Add to existing game
    g.players[user.id] = { name: user.displayName, score: 0 };
    await interaction.editReply(`**${user.displayName}** joined the Bible Game!`);
    return;
  }

  // Load verses
  const versesSnap = await db.ref('verses').once('value');
  const versesData = versesSnap.val();
  if (!versesData) {
    await interaction.editReply('❌ No verses found in the database. Seed verses first.');
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
    await interaction.editReply('❌ No verses found in the database. Seed verses first.');
    return;
  }

  // Create new game
  const game = {
    channelId,
    status: 'playing',
    round: 0,
    maxRounds: 10,
    players: {
      [user.id]: { name: user.displayName, score: 0 },
    },
    allVerses: verseList,
    currentVerse: null,
    blanks: [],
  };

  games.set(channelId, game);
  await advanceRound(game);

  const embed = buildGameEmbed(game);
  await interaction.editReply({ embeds: [embed] });

  console.log(`🎮 Game started in channel ${channelId} by ${user.displayName}`);
}

async function handleGuess(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const { channelId, user } = interaction;
  const game = games.get(channelId);

  if (!game || game.status !== 'playing') {
    await interaction.editReply('❌ No active game in this channel. Use `/play` to start one!');
    return;
  }

  if (!game.players[user.id]) {
    await interaction.editReply('❌ You are not in this game. Use `/play` to join!');
    return;
  }

  const guess = interaction.options.getString('word');
  if (!game.currentVerse || !game.blanks) {
    await interaction.editReply('⏳ Waiting for the next verse...');
    return;
  }

  // Check if already answered all blanks
  const playerSolved = game.currentVerse.solvedBlanks?.some(sb => sb.solvedBy === user.id);
  if (playerSolved) {
    await interaction.editReply('✅ You already solved a blank this round!');
    return;
  }

  const { correct, matched } = checkGuess(guess, game.blanks);

  if (!correct) {
    await interaction.editReply(`❌ "${guess}" is not correct. Try again!`);
    return;
  }

  // Correct!
  const blank = game.blanks.find(b => b.clean === matched.toLowerCase());
  if (!blank) {
    await interaction.editReply('❌ Something went wrong.');
    return;
  }

  if (!game.currentVerse.solvedBlanks) game.currentVerse.solvedBlanks = [];
  if (game.currentVerse.solvedBlanks.find(sb => sb.index === blank.index)) {
    await interaction.editReply('⏳ That blank was already solved by someone else!');
    return;
  }

  game.currentVerse.solvedBlanks.push({
    index: blank.index,
    word: matched,
    solvedBy: user.id,
  });

  const pts = game.currentVerse.solvedBlanks.length === 1 ? 15 : 10;
  game.players[user.id].score = (game.players[user.id].score || 0) + pts;

  await interaction.editReply(`✅ **${matched}** is correct! You earned **${pts} pts** 🎉`);

  // Send a public message announcing the correct guess
  await interaction.channel.send(`**${user.displayName}** got it! **${matched}** ✅`);

  // Check if all blanks solved
  if (game.currentVerse.solvedBlanks.length >= game.blanks.length) {
    await interaction.channel.send('🎯 All blanks filled! Next verse coming...');
    await advanceRound(game);
    const embed = buildGameEmbed(game);
    await interaction.channel.send({ embeds: [embed] });
  }
}

async function handleLeaderboard(interaction) {
  await interaction.deferReply();

  const game = games.get(interaction.channelId);
  if (!game || !game.players) {
    await interaction.editReply('No active game in this channel. Use `/play` to start one!');
    return;
  }

  const sorted = Object.values(game.players)
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  const embed = new EmbedBuilder()
    .setTitle('🏆 Bible Game — Leaderboard')
    .setColor(0x22c55e)
    .setDescription(
      sorted.map((p, i) =>
        `${['🥇', '🥈', '🥉'][i] || `#${i + 1}`} **${p.name}** — ${p.score || 0} pts`
      ).join('\n') || 'No players yet.'
    );

  await interaction.editReply({ embeds: [embed] });
}

async function handleLeave(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const game = games.get(interaction.channelId);
  if (!game || !game.players[interaction.user.id]) {
    await interaction.editReply('You are not in a game in this channel.');
    return;
  }

  delete game.players[interaction.user.id];

  if (Object.keys(game.players).length === 0) {
    games.delete(interaction.channelId);
    await interaction.editReply('You left the game. The game has ended (no players left).');
  } else {
    await interaction.editReply('You left the game.');
  }
}

async function handleVerses(interaction) {
  await interaction.deferReply({ ephemeral: true });

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

  await interaction.editReply(`📖 **${count}** verses in the SGSS Bible database.`);
}

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

function buildGameEmbed(game) {
  const cv = game.currentVerse;
  if (!cv) {
    return new EmbedBuilder()
      .setTitle('Bible Game')
      .setDescription('Loading verse...');
  }

  // Show blanks as underscores
  const displayText = cv.maskedText.replace(/\*\*\\_\\_\\_\\*\*/g, '___');

  const sorted = Object.values(game.players)
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  const embed = new EmbedBuilder()
    .setTitle(`📖 Round ${game.round}/${game.maxRounds}`)
    .setColor(0x22c55e)
    .setDescription(
      `**${cv.ref}**\n\n` +
      `> ${displayText}\n\n` +
      `Type \`/guess <word>\` to submit your answer!`
    )
    .addFields({
      name: '🏆 Leaderboard',
      value: sorted.map((p, i) =>
        `${['🥇', '🥈', '🥉'][i] || `#${i + 1}`} ${p.name} — ${p.score} pts`
      ).join('\n'),
    })
    .setFooter({ text: 'Missing words are shown as ___' });

  return embed;
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('❌ Missing DISCORD_TOKEN environment variable');
  process.exit(1);
}

client.login(token);
