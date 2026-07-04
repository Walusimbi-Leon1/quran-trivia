/**
 * Import SGSS Bible verses from text files
 * 
 * Usage: node scripts/import-verses.js <input-file>
 * 
 * Input format (one verse per line):
 *   Genesis 1:1 | In the beginning God created the heavens and the earth
 * 
 * Output: JSON files in /verse-data/ organized by book
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '..', 'verse-data');
mkdirSync(outDir, { recursive: true });

const inputFile = process.argv[2];
if (!inputFile) {
  console.error('Usage: node scripts/import-verses.js <input-file>');
  process.exit(1);
}

const lines = readFileSync(inputFile, 'utf-8')
  .split('\n')
  .map(l => l.trim())
  .filter(l => l && !l.startsWith('#'));

const verses = [];

for (const line of lines) {
  // Parse "Book Chapter:Verse | Text"
  const match = line.match(/^(.+?)\s+(\d+):(\d+)\s*\|\s*(.+)$/);
  if (!match) {
    console.warn(`⚠️  Skipping malformed line: ${line.slice(0, 50)}`);
    continue;
  }

  const [, book, chapter, verse, text] = match;
  verses.push({
    ref: `${book} ${chapter}:${verse}`,
    book,
    chapter: parseInt(chapter, 10),
    verse: parseInt(verse, 10),
    text: text.replace(/\s+/g, ' ').trim(),
  });
}

// Write as one big file (split into volumes if > 500 verses)
const FILE_LIMIT = 500;

for (let i = 0; i < verses.length; i += FILE_LIMIT) {
  const chunk = verses.slice(i, i + FILE_LIMIT);
  const vol = Math.floor(i / FILE_LIMIT) + 1;
  const filename = vol === 1 ? 'sgss-bible.json' : `sgss-bible-${vol}.json`;
  writeFileSync(join(outDir, filename), JSON.stringify(chunk, null, 2));
  console.log(`  ✓ ${filename} (${chunk.length} verses)`);
}

console.log(`\n✅ Imported ${verses.length} verses total.`);
