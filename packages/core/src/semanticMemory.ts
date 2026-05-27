/**
 * Optional semantic memory layer over `~/.tinyagi/embeddings.db`.
 *
 * Design constraints:
 *  - Opt-in. The existing markdown-based loadMemoryIndex() in memory.ts is
 *    unchanged. No call into this module happens automatically.
 *  - Separate DB file (`embeddings.db`) from the queue DB so it can be
 *    rebuilt without touching live agent state.
 *  - Native extension (sqlite-vec) loaded lazily. Failure throws a clear
 *    error pointing at the platform-specific install package.
 *  - Idempotent indexing via content_hash. Re-indexing an unchanged file
 *    is a no-op.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { TINYAGI_HOME } from './config';
import { log } from './logging';
import { Embedder } from './embeddings';

export const SEMANTIC_MEMORY_DB_PATH = path.join(TINYAGI_HOME, 'embeddings.db');

let db: Database.Database | null = null;
let knownDimension: number | null = null;

export interface SemanticSearchHit {
    filePath: string;
    name: string;
    summary: string;
    distance: number;
}

export interface SemanticMemoryStats {
    totalEntries: number;
    dimension: number | null;
    dbPath: string;
}

function parseFrontmatter(content: string): { name: string; summary: string } {
    const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) return { name: '', summary: '' };
    let name = '';
    let summary = '';
    for (const line of match[1].split('\n')) {
        const n = line.match(/^name:\s*["']?(.+?)["']?\s*$/);
        if (n) { name = n[1]; continue; }
        const s = line.match(/^summary:\s*["']?(.+?)["']?\s*$/);
        if (s) summary = s[1];
    }
    return { name, summary };
}

function sha256(s: string): string {
    return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * Check if sqlite-vec is loadable on this platform without opening the
 * production DB. Useful for capability detection in callers.
 */
export function isSemanticMemoryAvailable(): boolean {
    try {
        const probe = new Database(':memory:');
        try {
            sqliteVec.load(probe);
            return true;
        } finally {
            probe.close();
        }
    } catch {
        return false;
    }
}

function ensureDb(dimension: number): Database.Database {
    if (db && knownDimension !== null && knownDimension !== dimension) {
        throw new Error(
            `Semantic memory DB was initialized with dimension=${knownDimension} but caller passed dimension=${dimension}. ` +
            `Mixing embedders with different dimensions in the same DB is not supported. ` +
            `Delete ${SEMANTIC_MEMORY_DB_PATH} to switch embedders.`
        );
    }
    if (db) return db;

    fs.mkdirSync(path.dirname(SEMANTIC_MEMORY_DB_PATH), { recursive: true });
    db = new Database(SEMANTIC_MEMORY_DB_PATH);
    db.pragma('journal_mode = WAL');
    try {
        sqliteVec.load(db);
    } catch (e) {
        db.close();
        db = null;
        throw new Error(
            `Failed to load sqlite-vec native extension. This is required for semantic memory. ` +
            `On Linux/Mac/Windows, ensure the platform package (sqlite-vec-<os>-<arch>) is installed. ` +
            `Original error: ${(e as Error).message}`
        );
    }

    // memory_meta is a regular table linked by rowid to vec_memory.
    db.exec(`
        CREATE TABLE IF NOT EXISTS memory_meta (
            rowid INTEGER PRIMARY KEY,
            file_path TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            summary TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_memory_meta_path ON memory_meta(file_path);
    `);

    // vec0 virtual table with a fixed-dimension embedding column.
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(embedding float[${dimension}])`);

    knownDimension = dimension;
    return db;
}

function vectorToBuffer(v: Float32Array): Buffer {
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/**
 * Index a single memory file. Reads frontmatter (name + summary) and the
 * full body, embeds `name + summary + body`, upserts into vec_memory and
 * memory_meta keyed by file_path. Idempotent: unchanged files are skipped.
 *
 * Returns true if the file was (re)indexed, false if skipped as unchanged
 * or skipped because frontmatter was missing required fields.
 */
export async function indexMemoryFile(
    absoluteFilePath: string,
    embedder: Embedder
): Promise<boolean> {
    if (!fs.existsSync(absoluteFilePath)) return false;
    const content = fs.readFileSync(absoluteFilePath, 'utf8');
    const { name, summary } = parseFrontmatter(content);
    if (!name || !summary) return false;

    const hash = sha256(content);
    const dbh = ensureDb(embedder.dimension);

    const existing = dbh
        .prepare('SELECT rowid, content_hash FROM memory_meta WHERE file_path = ?')
        .get(absoluteFilePath) as { rowid: number; content_hash: string } | undefined;

    if (existing && existing.content_hash === hash) return false;

    const embedText = `${name}\n${summary}\n${content}`;
    const vec = await embedder.embed(embedText);
    const buf = vectorToBuffer(vec);

    const txn = dbh.transaction(() => {
        if (existing) {
            dbh.prepare('UPDATE vec_memory SET embedding = ? WHERE rowid = ?').run(buf, existing.rowid);
            dbh.prepare(
                'UPDATE memory_meta SET name = ?, summary = ?, content_hash = ?, indexed_at = datetime(\'now\') WHERE rowid = ?'
            ).run(name, summary, hash, existing.rowid);
        } else {
            const insertVec = dbh.prepare('INSERT INTO vec_memory(embedding) VALUES (?)');
            const info = insertVec.run(buf);
            const rowid = Number(info.lastInsertRowid);
            dbh.prepare(
                'INSERT INTO memory_meta(rowid, file_path, name, summary, content_hash) VALUES (?, ?, ?, ?, ?)'
            ).run(rowid, absoluteFilePath, name, summary, hash);
        }
    });
    txn();
    return true;
}

/**
 * Walk a memory directory (the same shape that loadMemoryIndex scans) and
 * index every .md file with valid frontmatter. Returns counts.
 */
export async function indexMemoryDir(
    agentDir: string,
    embedder: Embedder
): Promise<{ indexed: number; skipped: number; scanned: number }> {
    const memoryDir = path.join(agentDir, 'memory');
    let indexed = 0;
    let skipped = 0;
    let scanned = 0;
    if (!fs.existsSync(memoryDir)) return { indexed, skipped, scanned };

    const walk = async (dir: string) => {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
            if (item.name.startsWith('.')) continue;
            const p = path.join(dir, item.name);
            if (item.isDirectory()) {
                await walk(p);
            } else if (item.name.endsWith('.md')) {
                scanned++;
                const did = await indexMemoryFile(p, embedder);
                if (did) indexed++; else skipped++;
            }
        }
    };
    await walk(memoryDir);
    log('INFO', `semanticMemory: indexed ${indexed}, skipped ${skipped}, scanned ${scanned} under ${memoryDir}`);
    return { indexed, skipped, scanned };
}

/**
 * Top-k semantic search. `query` is embedded with the same embedder used
 * to index. Returns hits ordered by distance ascending (closer = better).
 */
export async function semanticSearch(
    query: string,
    k: number,
    embedder: Embedder
): Promise<SemanticSearchHit[]> {
    const dbh = ensureDb(embedder.dimension);
    const qvec = await embedder.embed(query);
    const buf = vectorToBuffer(qvec);

    const rows = dbh.prepare(`
        SELECT m.file_path, m.name, m.summary, v.distance
        FROM vec_memory v
        JOIN memory_meta m ON m.rowid = v.rowid
        WHERE v.embedding MATCH ? AND k = ?
        ORDER BY v.distance ASC
    `).all(buf, k) as Array<{ file_path: string; name: string; summary: string; distance: number }>;

    return rows.map(r => ({
        filePath: r.file_path,
        name: r.name,
        summary: r.summary,
        distance: r.distance,
    }));
}

export function getSemanticMemoryStats(): SemanticMemoryStats {
    if (!fs.existsSync(SEMANTIC_MEMORY_DB_PATH)) {
        return { totalEntries: 0, dimension: knownDimension, dbPath: SEMANTIC_MEMORY_DB_PATH };
    }
    let total = 0;
    try {
        const probe = new Database(SEMANTIC_MEMORY_DB_PATH, { readonly: true });
        try {
            const row = probe.prepare('SELECT COUNT(*) as n FROM memory_meta').get() as { n: number };
            total = row.n;
        } finally {
            probe.close();
        }
    } catch {
        // table may not exist yet
    }
    return { totalEntries: total, dimension: knownDimension, dbPath: SEMANTIC_MEMORY_DB_PATH };
}

export function closeSemanticMemoryDb(): void {
    if (db) { db.close(); db = null; knownDimension = null; }
}
