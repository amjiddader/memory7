import type { DB } from './db.js';
import type { Memory, Scope } from './types.js';

const STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'with', 'at', 'by', 'it', 'this',
  'that', 'as', 'we', 'i', 'my', 'me', 'user', 'users', 'uses', 'use', 'using', 'used',
]);

export function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._+#-]+/g, ' ')
    .split(' ')
    .filter((w) => (w.length > 1 || /\d/.test(w)) && !STOP.has(w));
}

export function normalize(s: string): string {
  return words(s).join(' ');
}

function stem(w: string): string {
  return w.replace(/(ing|ed|es|s)$/, '');
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function trigrams(s: string): Set<string> {
  const t = ` ${normalize(s)} `;
  const out = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return (2 * inter) / (a.size + b.size);
}

/** 0..1. Blend of word overlap (stemmed) and character-trigram overlap. */
export function similarity(a: string, b: string): number {
  const wa = new Set(words(a).map(stem));
  const wb = new Set(words(b).map(stem));
  return (jaccard(wa, wb) + dice(trigrams(a), trigrams(b))) / 2;
}

export interface SimilarHit {
  memory: Memory;
  score: number;
}

export const DUP_THRESHOLD = 0.85;
export const SIMILAR_THRESHOLD = 0.5;

/** Active memories in the same scope that read like `content`, best first. */
export function findSimilar(db: DB, scope: Scope, projectId: string | null, content: string, limit = 5): SimilarHit[] {
  const terms = [...new Set(words(content))].slice(0, 12);
  if (!terms.length) return [];
  const q = terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' OR ');
  const rows = db
    .prepare(
      `SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid
       WHERE memories_fts MATCH ? AND m.deleted_at IS NULL AND m.scope = ? AND IFNULL(m.project_id,'') = ?
       ORDER BY bm25(memories_fts) LIMIT ?`,
    )
    .all(q, scope, projectId ?? '', 20) as unknown as Memory[];
  return rows
    .map((memory) => ({ memory, score: similarity(content, memory.content) }))
    .filter((h) => h.score >= SIMILAR_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
