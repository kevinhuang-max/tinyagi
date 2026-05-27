/**
 * End-to-end test for semantic memory + embeddings.
 *
 * Uses the dependency-free HashEmbedder so the test doesn't need an
 * external API. Verifies:
 *   1. sqlite-vec availability detection
 *   2. HashEmbedder determinism
 *   3. indexMemoryDir indexes valid .md files and skips invalid ones
 *   4. semanticSearch ranks topically-similar docs above unrelated ones
 *   5. Re-indexing unchanged files is a no-op (content_hash hit)
 *   6. Re-indexing changed content updates the entry
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tinyagi-semmem-'));
fs.mkdirSync(path.join(tmpHome, 'logs'), { recursive: true });
process.env.TINYAGI_HOME = tmpHome;

const {
    HashEmbedder,
    isSemanticMemoryAvailable,
    indexMemoryFile,
    indexMemoryDir,
    semanticSearch,
    getSemanticMemoryStats,
    closeSemanticMemoryDb,
} = await import('../packages/core/dist/index.js');

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  PASS', msg); }
    else { failed++; console.log('  FAIL', msg); }
}

console.log('Test 1: sqlite-vec extension loads on this platform');
assert(isSemanticMemoryAvailable() === true, 'isSemanticMemoryAvailable returns true');

console.log('Test 2: HashEmbedder is deterministic and L2-normalized');
const emb = new HashEmbedder(384);
const v1 = await emb.embed('morning briefing');
const v2 = await emb.embed('morning briefing');
let identical = v1.length === v2.length;
for (let i = 0; i < v1.length && identical; i++) identical = v1[i] === v2[i];
assert(identical, 'same input yields same vector');
let norm = 0;
for (let i = 0; i < v1.length; i++) norm += v1[i] * v1[i];
assert(Math.abs(Math.sqrt(norm) - 1) < 1e-5, 'vector is L2-normalized');
assert(v1.length === 384, 'vector dimension matches embedder.dimension');

console.log('Test 3: indexMemoryDir indexes valid frontmatter files, skips invalid');
const agentDir = path.join(tmpHome, 'agent-a');
const memDir = path.join(agentDir, 'memory');
fs.mkdirSync(memDir, { recursive: true });

fs.writeFileSync(path.join(memDir, 'morning.md'), `---
name: morning-briefing
summary: Daily morning briefing recipe with calendar, inbox, and follow-ups
---

The morning briefing pulls calendar events, summarizes overnight inbox activity,
and surfaces follow-ups that need attention. Sections: ACT ON TODAY, BOOK,
MOTION, WATCH.
`);
fs.writeFileSync(path.join(memDir, 'cars.md'), `---
name: car-maintenance
summary: Notes on rotating tires and oil changes for the Subaru
---

The Subaru gets an oil change every 5000 miles. Tire rotations alternate front
and rear. Brake pads at 50000 miles. Coolant flush at 60000.
`);
fs.writeFileSync(path.join(memDir, 'no-frontmatter.md'), `Just a plain note, no frontmatter, should be skipped.`);

const result1 = await indexMemoryDir(agentDir, emb);
assert(result1.scanned === 3, `scanned 3 files (got ${result1.scanned})`);
assert(result1.indexed === 2, `indexed 2 valid files (got ${result1.indexed})`);
assert(result1.skipped === 1, `skipped 1 file lacking frontmatter (got ${result1.skipped})`);

const stats = getSemanticMemoryStats();
assert(stats.totalEntries === 2, `stats reports 2 entries (got ${stats.totalEntries})`);
assert(stats.dimension === 384, 'stats reports the embedder dimension');

console.log('Test 4: semanticSearch ranks related content higher');
const hits = await semanticSearch('morning daily calendar briefing', 2, emb);
assert(hits.length === 2, `got 2 hits back (got ${hits.length})`);
assert(hits[0].name === 'morning-briefing', `morning-briefing ranked first (got ${hits[0].name})`);
assert(hits[1].name === 'car-maintenance', 'car-maintenance ranked second (the unrelated one)');
assert(hits[0].distance < hits[1].distance, 'first hit has smaller distance');

console.log('Test 5: re-indexing unchanged file is a no-op');
const result2 = await indexMemoryDir(agentDir, emb);
assert(result2.indexed === 0, `re-index indexed 0 files (got ${result2.indexed})`);
assert(result2.skipped === 3, `re-index skipped all 3 (got ${result2.skipped})`);

console.log('Test 6: re-indexing changed content updates the entry');
fs.writeFileSync(path.join(memDir, 'morning.md'), `---
name: morning-briefing
summary: REVISED daily briefing with new sections
---

This is a completely new body about gardening and tomatoes.
`);
const result3 = await indexMemoryDir(agentDir, emb);
assert(result3.indexed === 1, `changed file was re-indexed (got ${result3.indexed})`);
assert(result3.skipped === 2, `unchanged files still skipped (got ${result3.skipped})`);

const hitsAfter = await semanticSearch('gardening tomatoes', 2, emb);
assert(hitsAfter[0].name === 'morning-briefing', 'after content change, morning-briefing now matches gardening query');
assert(hitsAfter[0].summary.includes('REVISED'), 'updated summary persisted');

closeSemanticMemoryDb();

console.log('');
console.log(`RESULT: ${passed} passed, ${failed} failed`);
fs.rmSync(tmpHome, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
