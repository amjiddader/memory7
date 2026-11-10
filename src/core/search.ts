import type { DB } from './db.js';
import { expand } from '../data/synonyms.js';
import { checkAnchors, parseAnchors } from './anchors.js';
import type { AnchorState } from './anchors.js';
import { scopeClause, shortType } from './store.js';
import type { MemType, Memory, SearchScope } from './types.js';

const QUERY_STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'with', 'at', 'by', 'it', 'this', 'that',
  'what', 'which', 'who', 'how', 'do', 'does', 'did', 'i', 'my', 'me', 'we', 'our', 'user', 'users', 'about', 'any', 'there', 'should',
  'can', 'could', 'would', 'use', 'uses', 'using', 'used', 'have', 'has', 'get', 'tell', 'know', 'remember',
]);

export function queryTerms(query: string): string[] {
  const out: string[] = [];
  for (const raw of query.toLowerCase().split(/[^a-z0-9._+#-]+/)) {
    const t = raw.replace(/^[._+#-]+|[._+#-]+$/g, '');
    if (t.length < 2 || QUERY_STOP.has(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out.slice(0, 10);
}

const TYPE_WEIGHT: Record<MemType, number> = {
  preference: 1.2,
  environment: 1.2,
  gotcha: 1.15,
  decision: 1.1,
  convention: 1.1,
  command: 1.05,
  stack: 1.0,
  todo: 0.95,
  note: 0.9,
};

const DAY = 86_400_000;

export function recencyFactor(m: Memory, now = Date.now()): number {
  const base = Math.max(m.last_used_at ?? 0, m.updated_at);
  const days = Math.max(0, (now - base) / DAY);
  return Math.max(0.35, Math.pow(0.5, days / 60));
}

export function baseScore(m: Memory, currentProjectId: string | null, now = Date.now()): number {
  const usage = 1 + Math.log(1 + m.hit_count) * 0.3;
  const scopeBonus = m.scope === 'global' ? 1.0 : m.project_id === currentProjectId ? 1.2 : 0.6;
  return TYPE_WEIGHT[m.type] * recencyFactor(m, now) * usage * (m.pinned ? 1.5 : 1) * scopeBonus;
}

const q = (w: string) => `"${w.replace(/"/g, '')}"`;

function andQuery(terms: string[]): string {
  return terms
    .map((t) => {
      const alts = [`${q(t)}*`, ...expand(t).map(q)];
      return alts.length > 1 ? `(${alts.join(' OR ')})` : alts[0]!;
    })
    .join(' AND ');
}

function orQuery(terms: string[]): string {
  const all = new Set<string>();
  for (const t of terms) {
    all.add(`${q(t)}*`);
    for (const s of expand(t)) all.add(q(s));
  }
  return [...all].join(' OR ');
}

function stem(w: string): string {
  const s = w.replace(/(ing|ed|es|s)$/, '');
  return s.length >= 3 ? s : w;
}

/** Fraction of query terms (or their synonyms) present in the memory text. */
function coverage(m: Memory, terms: string[]): number {
  if (!terms.length) return 1;
  const text = `${m.content} ${m.key ?? ''} ${m.tags ?? ''}`.toLowerCase();
  const ws = text.split(/[^a-z0-9._+#-]+/).filter(Boolean);
  let hit = 0;
  for (const t of terms) {
    const st = stem(t);
    const syns = expand(t);
    if (ws.some((w) => w.startsWith(st) || syns.includes(w))) hit++;
  }
  return hit / terms.length;
}

function grams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i <= s.length - 3; i++) out.add(s.slice(i, i + 3));
  return out;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return (2 * inter) / (a.size + b.size);
}

/** Typo-tolerant coverage: a term counts when some word in the memory is trigram-similar to it. Capped below 1 so it never counts as an exact match. */
function fuzzyCoverage(m: Memory, terms: string[]): number {
  const ws = `${m.content} ${m.key ?? ''} ${m.tags ?? ''}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const wg = ws.map(grams);
  let hit = 0;
  for (const t of terms) {
    const tg = grams(t);
    if (wg.some((g) => dice(tg, g) >= 0.55)) hit++;
  }
  return Math.min(0.9, hit / terms.length);
}

export interface Hit {
  memory: Memory;
  score: number;
  state: AnchorState;
  /** fraction of query terms (or synonyms) found; 1 means every term matched */
  cov: number;
}

export interface SearchOpts {
  query: string;
  scope: SearchScope;
  projectId: string | null;
  projectRoot: string | null;
  type?: MemType;
  limit: number;
}

type Row = Memory & { bm: number };

function runFts(db: DB, table: 'memories_fts' | 'memories_tri', match: string, o: SearchOpts, fetch: number): Row[] {
  const where = ['m.deleted_at IS NULL'];
  const args: Array<string | number> = [match];
  scopeClause(o.scope, o.projectId, where, args, 'm', false);
  if (o.type) {
    where.push('m.type = ?');
    args.push(o.type);
  }
  args.push(fetch);
  const rank = table === 'memories_fts' ? `bm25(${table}, 1.0, 0.7, 2.0)` : `bm25(${table})`;
  try {
    return db
      .prepare(
        `SELECT m.*, ${rank} AS bm FROM ${table} JOIN memories m ON m.id = ${table}.rowid
         WHERE ${table} MATCH ? AND ${where.join(' AND ')} ORDER BY bm LIMIT ?`,
      )
      .all(...args) as unknown as Row[];
  } catch {
    return []; // malformed MATCH expression: treat as no results rather than failing the tool call
  }
}

export function search(db: DB, o: SearchOpts): Hit[] {
  const terms = queryTerms(o.query);
  const now = Date.now();
  const fetch = Math.max(30, o.limit * 6);
  let rows: Row[] = [];
  let fuzzy = false;

  if (!terms.length) {
    // nothing searchable (empty or all stopwords): list best memories in scope
    const where = ['deleted_at IS NULL'];
    const args: Array<string | number> = [];
    scopeClause(o.scope, o.projectId, where, args, '', false);
    if (o.type) {
      where.push('type = ?');
      args.push(o.type);
    }
    args.push(fetch);
    rows = db.prepare(`SELECT *, 0 AS bm FROM memories WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`).all(...args) as unknown as Row[];
  } else {
    rows = runFts(db, 'memories_fts', andQuery(terms), o, fetch);
    if (rows.length < o.limit && terms.length > 1) {
      const seen = new Set(rows.map((r) => r.id));
      for (const r of runFts(db, 'memories_fts', orQuery(terms), o, fetch)) if (!seen.has(r.id)) rows.push(r);
    }
    if (!rows.length) {
      // typo tolerance: candidates share some 3-grams with a term; fuzzyCoverage then decides
      const gs = new Set<string>();
      for (const t of terms) {
        if (t.length < 3) continue;
        for (const g of grams(t)) if (gs.size < 40) gs.add(g);
      }
      if (gs.size) {
        rows = runFts(db, 'memories_tri', [...gs].map(q).join(' OR '), o, fetch).filter((r) => fuzzyCoverage(r as Memory, terms) > 0);
        fuzzy = true;
      }
    }
  }

  if (o.scope === 'any-project') rows = rows.filter((r) => r.source !== 'team' || r.project_id === o.projectId);

  const hits: Hit[] = rows.map((r, idx) => {
    const { bm: _bm, ...memory } = r;
    const cov = fuzzy ? fuzzyCoverage(memory as Memory, terms) : coverage(memory as Memory, terms);
    const relevance = terms.length ? 0.65 * cov + 0.35 / (1 + idx * 0.5) : 1;
    let state: AnchorState = 'ok';
    const anchors = parseAnchors(memory.anchors);
    if (anchors.length && o.projectRoot && memory.project_id === o.projectId) state = checkAnchors(o.projectRoot, anchors);
    const stalePenalty = state === 'ok' ? 1 : 0.5;
    return { memory: memory as Memory, score: relevance * baseScore(memory as Memory, o.projectId, now) * stalePenalty, state, cov };
  });
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, o.limit);
}

// ------------------------------------------------------------------ formatting

export function projectNames(db: DB): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of db.prepare('SELECT id, name FROM projects').all() as Array<{ id: string; name: string }>) m.set(r.id, r.name);
  return m;
}

export function formatLine(m: Memory, currentProjectId: string | null, names: Map<string, string>, state: AnchorState = 'ok'): string {
  const where = m.scope === 'global' ? 'g' : m.project_id === currentProjectId ? 'p' : `p:${names.get(m.project_id ?? '') ?? '?'}`;
  const flag = state === 'stale' ? ' ?stale' : state === 'missing' ? ' ?missing' : '';
  return `#${m.id} [${shortType(m.type)}|${where}]${m.key ? ` {${m.key}}` : ''} ${m.content}${flag}`;
}
