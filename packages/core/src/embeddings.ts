/**
 * Embedder interface and reference implementations.
 *
 * Embeddings are not used anywhere in the core agent loop. They power the
 * optional semantic-memory subsystem (semanticMemory.ts). Users plug in
 * whichever embedder fits their stack; this module ships:
 *
 *   - HashEmbedder    deterministic, dependency-free, useful for tests and
 *                     for users who want approximate similarity without an
 *                     API key.
 *   - OpenAIEmbedder  thin fetch() wrapper around OpenAI's embeddings
 *                     endpoint. Requires OPENAI_API_KEY at construction.
 *
 * Both are opt-in. Importing this module has no side effects.
 */

import crypto from 'crypto';

export interface Embedder {
    /** Vector dimension produced. Must be stable for a given embedder instance. */
    readonly dimension: number;
    /** Embed a single text. Returns a Float32Array of length `dimension`. */
    embed(text: string): Promise<Float32Array>;
    /** Optional batch embed; falls back to sequential `embed` if not provided. */
    embedBatch?(texts: string[]): Promise<Float32Array[]>;
}

/**
 * Deterministic feature-hash embedder.
 *
 * Lowercases, tokenizes on word boundaries, hashes each token into a
 * bucket of `dimension` size, accumulates a TF-style count, and L2-normalizes.
 *
 * Not state-of-the-art. Good enough to exercise the pipeline, to write
 * deterministic tests, and to ship approximate keyword-similar search
 * with zero API dependencies.
 */
export class HashEmbedder implements Embedder {
    public readonly dimension: number;

    constructor(dimension: number = 384) {
        if (!Number.isInteger(dimension) || dimension < 16) {
            throw new Error(`HashEmbedder dimension must be an integer >= 16, got ${dimension}`);
        }
        this.dimension = dimension;
    }

    async embed(text: string): Promise<Float32Array> {
        const vec = new Float32Array(this.dimension);
        const tokens = text.toLowerCase().match(/[a-z0-9]{2,}/g) || [];

        for (const token of tokens) {
            const h = crypto.createHash('sha1').update(token).digest();
            const bucket = h.readUInt32BE(0) % this.dimension;
            const sign = (h.readUInt32BE(4) & 1) === 0 ? 1 : -1;
            vec[bucket] += sign;
        }

        let norm = 0;
        for (let i = 0; i < this.dimension; i++) norm += vec[i] * vec[i];
        norm = Math.sqrt(norm);
        if (norm > 0) {
            for (let i = 0; i < this.dimension; i++) vec[i] /= norm;
        }
        return vec;
    }
}

/**
 * OpenAI embeddings via fetch (no SDK dependency).
 *
 * Default model `text-embedding-3-small` (1536 dims). Override with
 * `model` and `dimension` constructor args, e.g. text-embedding-3-large
 * with 3072 dims, or use OpenAI's `dimensions` truncation.
 *
 * Requires `apiKey` constructor arg or OPENAI_API_KEY env. Never throws
 * on import — only when `embed()` is called without credentials.
 */
export class OpenAIEmbedder implements Embedder {
    public readonly dimension: number;
    private readonly model: string;
    private readonly apiKey: string | undefined;
    private readonly endpoint: string;

    constructor(opts: { apiKey?: string; model?: string; dimension?: number; endpoint?: string } = {}) {
        this.apiKey = opts.apiKey || process.env.OPENAI_API_KEY;
        this.model = opts.model || 'text-embedding-3-small';
        this.dimension = opts.dimension || 1536;
        this.endpoint = opts.endpoint || 'https://api.openai.com/v1/embeddings';
    }

    async embed(text: string): Promise<Float32Array> {
        const [v] = await this.embedBatch([text]);
        return v;
    }

    async embedBatch(texts: string[]): Promise<Float32Array[]> {
        if (!this.apiKey) {
            throw new Error('OpenAIEmbedder: OPENAI_API_KEY not set (and no apiKey passed to constructor)');
        }
        const body: Record<string, unknown> = { input: texts, model: this.model };
        if (this.dimension !== 1536 && this.model.startsWith('text-embedding-3')) {
            body.dimensions = this.dimension;
        }
        const res = await fetch(this.endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`OpenAIEmbedder: HTTP ${res.status} ${res.statusText} — ${errText.slice(0, 200)}`);
        }
        const json = await res.json() as { data: Array<{ embedding: number[] }> };
        return json.data.map(d => Float32Array.from(d.embedding));
    }
}
