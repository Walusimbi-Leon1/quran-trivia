/**
 * Seed Firebase RTDB with verses
 * 
 * Usage: node scripts/seed-firebase.js
 * 
 * This loads all verse JSON files from /verse-data/ and pushes
 * them to Firebase Realtime Database under /verses.
 */

import { readFileSync, readdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import admin from 'firebase-admin';

const __dirname = dirname(fileURLToPath(import.meta.url));
const verseDir = resolve(__dirname, '..', 'verse-data');

// Initialize Firebase Admin
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!serviceAccount) {
  console.error('❌ Missing FIREBASE_SERVICE_ACCOUNT env var');
  console.error('   Set it to the path of your Firebase admin SDK JSON file.');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(serviceAccount)),
  databaseURL: 'https://bible-game-21-default-rtdb.firebaseio.com',
});

const db = admin.database();
const ref = db.ref('verses');

async function seed() {
  const files = readdirSync(verseDir).filter(f => f.endsWith('.json'));
  let total = 0;

  for (const file of files) {
    const data = JSON.parse(readFileSync(join(verseDir, file), 'utf-8'));
    const verses = Array.isArray(data) ? data : [data];

    for (const verse of verses) {
      const key = `${verse.book}/${verse.chapter}/${verse.verse}`;
      await ref.child(key).set(verse);
      total++;
      console.log(`  ✓ ${verse.ref}`);
    }
  }

  console.log(`\n✅ Seeded ${total} verses to Firebase RTDB.`);
  process.exit(0);
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
