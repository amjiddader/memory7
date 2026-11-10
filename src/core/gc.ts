import { getMeta, setMeta } from './db.js';
import { normalize } from './dedupe.js';
import type { Store } from './store.js';
import type { Memory } from './types.js';

const DAY = 86_400_000;
const DONE = /^\s*(\[x\]|done\b|✓|✅)/i;

export interface GcResult {
  merged: number;
  archived: number;
  doneTodos: number;
}

/**
 * Housekeeping, all via soft delete so `memory7 undo` still works:
 *  - merge exact duplicates (same scope/project/normalized text), keeping pinned/oldest
 *  - archive untouched notes (never used, older than 180 days)
 *  - remove todos marked done
 */
export function gc(store: Store, now = Date.now()): GcResult {
  const res: GcResult = { merged: 0, archived: 0, doneTodos: 0 };
  const all = store.db.prepare('SELECT * FROM memories WHERE deleted_at IS NULL ORDER BY id').all() as unknown as Memory[];
  store.tx(() => {
    const seen = new Map<string, Memory>();
    const drop: number[] = [];
    for (const m of all) {
      const sig = `${m.scope}|${m.project_id ?? ''}|${normalize(m.content)}`;
      const prev = seen.get(sig);
      if (!prev) {
        seen.set(sig, m);
        continue;
      }
      if (m.pinned && !prev.pinned) {
        drop.push(prev.id);
        seen.set(sig, m);
      } else drop.push(m.id);
    }
    res.merged = store.delete(drop, 'gc').length;
    const dropped = new Set(drop);

    const old: number[] = [];
    const done: number[] = [];
    for (const m of all) {
      if (dropped.has(m.id) || m.pinned) continue;
      if (m.type === 'note' && m.hit_count === 0 && m.source !== 'auto' && now - Math.max(m.updated_at, m.last_used_at ?? 0) > 180 * DAY) old.push(m.id);
      else if (m.type === 'todo' && DONE.test(m.content)) done.push(m.id);
    }
    res.archived = store.delete(old, 'gc').length;
    res.doneTodos = store.delete(done, 'gc').length;
  });
  try {
    store.db.exec("INSERT INTO memories_fts(memories_fts) VALUES('optimize')");
  } catch {
    /* best effort */
  }
  setMeta(store.db, 'last_gc', String(now));
  return res;
}

/** Run gc at most once a day. */
export function lazyGc(store: Store, now = Date.now()): GcResult | null {
  const last = Number(getMeta(store.db, 'last_gc') ?? 0);
  if (now - last < DAY) return null;
  return gc(store, now);
}
