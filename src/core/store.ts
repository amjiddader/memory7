import { randomBytes } from 'node:crypto';
import type { DB } from './db.js';
import { DUP_THRESHOLD, findSimilar, normalize } from './dedupe.js';
import { infer } from './infer.js';
import { findSecret } from './secrets.js';
import { extractPaths, parseAnchors, snapshotAnchors } from './anchors.js';
import { MAX_CONTENT, MEM_TYPES } from './types.js';
import type { Ctx, MemType, Memory, Scope, SearchScope, Source } from './types.js';

export interface SaveInput {
  content: string;
  key?: string;
  type?: MemType;
  scope?: Scope;
  tags?: string[] | string;
  files?: string[];
  pin?: boolean;
  /** update this exact memory */
  id?: number;
  /** if a similar (not identical) memory exists, update it instead of adding */
  replace?: boolean;
}

export interface SaveResult {
  status: 'created' | 'updated' | 'skipped' | 'rejected';
  id?: number;
  message: string;
}

const MAX_PER_PROJECT_WARN = 2000;

export function cleanContent(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function cleanKey(k: string | undefined): string | undefined {
  if (!k) return undefined;
  const v = k.trim().toLowerCase().replace(/[^a-z0-9:_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return v || undefined;
}

export function cleanTags(t: string[] | string | undefined): string | null {
  if (!t) return null;
  const arr = Array.isArray(t) ? t : t.split(/[\s,]+/);
  const out = [...new Set(arr.map((x) => x.toLowerCase().replace(/[^a-z0-9_-]+/g, '')).filter(Boolean))].slice(0, 8);
  return out.length ? out.join(' ') : null;
}

export const newUid = (): string => randomBytes(6).toString('hex');

const q = (s: string, max = 60) => (s.length > max ? s.slice(0, max - 1) + '…' : s);

export class Store {
  private depth = 0;
  private pendingHits = new Set<number>();
  /** called after any user/AI-originated change to shared state (not for auto capture or sync imports) */
  onChange?: () => void;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(public db: DB) {}

  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
  }

  get(id: number): Memory | undefined {
    return this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory | undefined;
  }

  getActive(id: number): Memory | undefined {
    return this.db.prepare('SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL').get(id) as Memory | undefined;
  }

  getByKey(scope: Scope, projectId: string | null, key: string): Memory | undefined {
    return this.db
      .prepare("SELECT * FROM memories WHERE scope = ? AND IFNULL(project_id,'') = ? AND key = ? AND deleted_at IS NULL")
      .get(scope, projectId ?? '', key) as Memory | undefined;
  }

  countProject(projectId: string): number {
    const r = this.db.prepare('SELECT COUNT(*) c FROM memories WHERE project_id = ? AND deleted_at IS NULL').get(projectId) as { c: number };
    return r.c;
  }

  history(memoryId: number, op: string, oldC: string | null, newC: string | null, source: string): void {
    this.db
      .prepare('INSERT INTO history(memory_id, op, old_content, new_content, at, source) VALUES(?,?,?,?,?,?)')
      .run(memoryId, op, oldC, newC, Date.now(), source);
  }

  // ---------------------------------------------------------------- save

  save(ctx: Ctx, input: SaveInput, source: Source = 'ai'): SaveResult {
    const r = this.saveInner(ctx, input, source);
    if ((r.status === 'created' || r.status === 'updated') && source !== 'auto' && source !== 'team') this.onChange?.();
    return r;
  }

  private saveInner(ctx: Ctx, input: SaveInput, source: Source): SaveResult {
    const content = cleanContent(input.content ?? '');
    if (!content) return { status: 'rejected', message: 'rejected: empty content' };
    if (content.length > MAX_CONTENT) {
      return { status: 'rejected', message: `rejected: ${content.length} chars (max ${MAX_CONTENT}). Save one short fact per memory.` };
    }
    const secret = findSecret(content);
    if (secret) {
      return { status: 'rejected', message: `rejected: looks like a secret (${secret}). Save a redacted version, e.g. "uses GitHub token from env GH_TOKEN".` };
    }
    if (input.type && !(MEM_TYPES as readonly string[]).includes(input.type)) {
      return { status: 'rejected', message: `rejected: unknown type "${input.type}". Use: ${MEM_TYPES.join(', ')}` };
    }

    return this.tx(() => {
      // explicit update by id
      if (input.id !== undefined) {
        const m = this.getActive(input.id);
        if (!m) return { status: 'rejected' as const, message: `rejected: no memory #${input.id}` };
        return this.update(ctx, m, content, input, source);
      }

      const inf = infer(content, { scope: input.scope, type: input.type, key: cleanKey(input.key) });
      const notes: string[] = [];
      let scope = inf.scope;
      if (scope === 'project' && !ctx.project) {
        scope = 'global';
        notes.push('no project detected, saved as global');
      }
      const pid = scope === 'project' ? ctx.project!.id : null;
      const key = inf.key;

      // keyed upsert: one current value per subject
      if (key) {
        const existing = this.getByKey(scope, pid, key);
        if (existing) {
          if (source === 'auto' && existing.source !== 'auto') {
            return { status: 'skipped' as const, id: existing.id, message: `skipped: #${existing.id} {${key}} was set by ${existing.source}` };
          }
          if (normalize(existing.content) === normalize(content)) {
            this.touch([existing.id]);
            return { status: 'skipped' as const, id: existing.id, message: `skipped: unchanged #${existing.id} {${key}}` };
          }
          return this.update(ctx, existing, content, { ...input, type: input.type ?? undefined }, source);
        }
      }

      // duplicate / near-duplicate detection
      const similar = findSimilar(this.db, scope, pid, content);
      const best = similar[0];
      if (best && best.score >= DUP_THRESHOLD) {
        this.touch([best.memory.id]);
        return { status: 'skipped' as const, id: best.memory.id, message: `skipped: dup of #${best.memory.id} "${q(best.memory.content)}"` };
      }
      if (best && input.replace) {
        return this.update(ctx, best.memory, content, input, source);
      }

      // insert
      let anchorsJson: string | null = null;
      const explicit = input.files ?? [];
      if (scope === 'project' && ctx.project) {
        // files the text mentions are anchored automatically, so the memory goes stale when they change
        const auto = source === 'auto' ? [] : extractPaths(content, ctx.project.root);
        const all = [...new Set([...explicit, ...auto])];
        if (all.length) {
          const { anchors, rejected } = snapshotAnchors(ctx.project.root, all);
          if (anchors.length) anchorsJson = JSON.stringify(anchors);
          const bad = rejected.filter((x) => explicit.includes(x));
          if (bad.length) notes.push(`files not anchored: ${bad.join(', ')}`);
        }
      } else if (explicit.length) {
        notes.push('files ignored (global memory)');
      }
      const now = Date.now();
      const r = this.db
        .prepare(
          `INSERT INTO memories(scope, project_id, key, type, content, tags, source, anchors, pinned, uid, created_at, updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(scope, pid, key ?? null, inf.type, content, cleanTags(input.tags), source, anchorsJson, input.pin ? 1 : 0, newUid(), now, now);
      const id = Number(r.lastInsertRowid);
      this.history(id, 'create', null, content, source);

      if (best) notes.push(`similar: #${best.memory.id} "${q(best.memory.content)}" (pass id=${best.memory.id} to update it, or memory_delete it)`);
      if (pid && this.countProject(pid) > MAX_PER_PROJECT_WARN) notes.push(`project has >${MAX_PER_PROJECT_WARN} memories, consider memory7 gc`);
      const tag = `[${shortType(inf.type)}|${scope === 'global' ? 'g' : 'p'}]${key ? ` {${key}}` : ''}`;
      return { status: 'created' as const, id, message: `saved #${id} ${tag}${notes.length ? '; ' + notes.join('; ') : ''}` };
    });
  }

  private update(ctx: Ctx, m: Memory, content: string, input: SaveInput, source: Source): SaveResult {
    const now = Date.now();
    const type = input.type && (MEM_TYPES as readonly string[]).includes(input.type) ? input.type : m.type;
    const tags = input.tags !== undefined ? cleanTags(input.tags) : m.tags;

    let anchorsJson = m.anchors;
    const root = ctx.project && m.project_id === ctx.project.id ? ctx.project.root : null;
    if (root) {
      const prior = input.files?.length ? input.files : parseAnchors(m.anchors).map((a) => a.p);
      const paths = [...new Set([...prior, ...(source === 'auto' ? [] : extractPaths(content, root))])];
      if (paths.length) {
        const { anchors } = snapshotAnchors(root, paths);
        anchorsJson = anchors.length ? JSON.stringify(anchors) : null;
      }
    }
    const pinned = input.pin === undefined ? m.pinned : input.pin ? 1 : 0;
    // an AI/user edit takes ownership of an auto memory
    const newSource = source === 'auto' ? m.source : source;

    this.db
      .prepare(
        `UPDATE memories SET content=?, type=?, tags=?, anchors=?, pinned=?, source=?, updated_at=? WHERE id=?`,
      )
      .run(content, type, tags, anchorsJson, pinned, newSource, now, m.id);
    this.history(m.id, 'update', m.content, content, source);
    const keyTxt = m.key ? ` {${m.key}}` : '';
    const was = m.content === content ? '' : ` (was: "${q(m.content)}")`;
    return { status: 'updated', id: m.id, message: `updated #${m.id}${keyTxt}${was}` };
  }

  // ---------------------------------------------------------------- delete / undo

  delete(ids: number[], source: string = 'ai'): number[] {
    const done = this.deleteInner(ids, source);
    if (done.length && source !== 'auto' && source !== 'team') this.onChange?.();
    return done;
  }

  private deleteInner(ids: number[], source: string): number[] {
    const done: number[] = [];
    this.tx(() => {
      for (const id of ids) {
        const m = this.getActive(id);
        if (!m) continue;
        this.db.prepare('UPDATE memories SET deleted_at = ? WHERE id = ?').run(Date.now(), id);
        this.history(id, 'delete', m.content, null, source);
        done.push(id);
      }
    });
    return done;
  }

  /** Revert the most recent change to a memory. Calling it again redoes the change. */
  undo(id: number): string {
    const msg = this.undoInner(id);
    this.onChange?.();
    return msg;
  }

  private undoInner(id: number): string {
    const h = this.db.prepare('SELECT * FROM history WHERE memory_id = ? ORDER BY id DESC LIMIT 1').get(id) as
      | { op: string; old_content: string | null; new_content: string | null }
      | undefined;
    if (!h) return `no history for #${id}`;
    return this.tx(() => {
      const m = this.get(id)!;
      if (h.op === 'delete') {
        try {
          this.db.prepare('UPDATE memories SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(Date.now(), id);
        } catch {
          return `cannot restore #${id}: another memory now uses key {${m.key}}`;
        }
        this.history(id, 'restore', null, m.content, 'user');
        return `restored #${id} "${q(m.content)}"`;
      }
      if (h.op === 'update' && h.old_content !== null) {
        this.db.prepare('UPDATE memories SET content = ?, updated_at = ? WHERE id = ?').run(h.old_content, Date.now(), id);
        this.history(id, 'update', m.content, h.old_content, 'user');
        return `reverted #${id} to "${q(h.old_content)}"`;
      }
      if (h.op === 'create' || h.op === 'restore') {
        this.db.prepare('UPDATE memories SET deleted_at = ? WHERE id = ?').run(Date.now(), id);
        this.history(id, 'delete', m.content, null, 'user');
        return `removed #${id}`;
      }
      return `nothing to undo for #${id}`;
    });
  }

  /** Keep a project memory out of the repo's .memory/ folder (it is removed from the file on the next sync). */
  setLocalOnly(id: number, on: boolean): string {
    const m = this.getActive(id);
    if (!m) return `no memory #${id}`;
    if (m.scope !== 'project') return `#${id} is global: global memory is never written to a repo`;
    if (on && m.source === 'team') return `#${id} came from the repo; use memory_delete to remove it for everyone`;
    this.db.prepare('UPDATE memories SET local_only = ? WHERE id = ?').run(on ? 1 : 0, id);
    this.onChange?.();
    return on ? `#${id} is now local only` : `#${id} will be shared via .memory/ again`;
  }

  /** Re-confirm a memory against the current code: re-snapshot its file anchors without changing the text. */
  verify(ctx: Ctx, id: number): string {
    const m = this.getActive(id);
    if (!m) return `rejected: no memory #${id}`;
    const anchors = parseAnchors(m.anchors);
    if (!anchors.length || !ctx.project || m.project_id !== ctx.project.id) return `verified #${id} (no file anchors to refresh)`;
    const { anchors: fresh } = snapshotAnchors(ctx.project.root, anchors.map((a) => a.p));
    const gone = anchors.length - fresh.length;
    this.db.prepare('UPDATE memories SET anchors = ?, updated_at = ? WHERE id = ?').run(fresh.length ? JSON.stringify(fresh) : null, Date.now(), id);
    this.history(id, 'update', m.content, m.content, 'ai');
    this.onChange?.();
    return gone ? `verified #${id}; ${gone} anchored file(s) no longer exist and were dropped` : `verified #${id}`;
  }

  pin(id: number, on: boolean): boolean {
    const r = this.db.prepare('UPDATE memories SET pinned = ? WHERE id = ? AND deleted_at IS NULL').run(on ? 1 : 0, id);
    return Number(r.changes) > 0;
  }

  // ---------------------------------------------------------------- listing

  list(opts: { scope: SearchScope; projectId: string | null; type?: MemType; limit?: number; source?: Source }): Memory[] {
    const where: string[] = ['deleted_at IS NULL'];
    const args: Array<string | number> = [];
    scopeClause(opts.scope, opts.projectId, where, args);
    if (opts.type) {
      where.push('type = ?');
      args.push(opts.type);
    }
    if (opts.source) {
      where.push('source = ?');
      args.push(opts.source);
    }
    args.push(opts.limit ?? 200);
    return this.db
      .prepare(`SELECT * FROM memories WHERE ${where.join(' AND ')} ORDER BY pinned DESC, updated_at DESC LIMIT ?`)
      .all(...args) as unknown as Memory[];
  }

  // ---------------------------------------------------------------- usage stats (batched)

  touch(ids: number[]): void {
    for (const id of ids) this.pendingHits.add(id);
    if (!this.flushTimer && this.pendingHits.size) {
      this.flushTimer = setTimeout(() => this.flush(), 1000);
      this.flushTimer.unref();
    }
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.pendingHits.size) return;
    const ids = [...this.pendingHits];
    this.pendingHits.clear();
    try {
      this.tx(() => {
        const st = this.db.prepare('UPDATE memories SET hit_count = hit_count + 1, last_used_at = ? WHERE id = ?');
        const now = Date.now();
        for (const id of ids) st.run(now, id);
      });
    } catch {
      /* usage stats are best-effort; never fail a request over them */
    }
  }

  close(): void {
    this.flush();
    this.db.close();
  }
}

export function scopeClause(scope: SearchScope, projectId: string | null, where: string[], args: Array<string | number>, alias = '', hideForeignTeam = true): void {
  const a = alias ? alias + '.' : '';
  switch (scope) {
    case 'global':
      where.push(`${a}scope = 'global'`);
      break;
    case 'project':
      where.push(`${a}project_id = ?`);
      args.push(projectId ?? '\u0000none');
      break;
    case 'any-project':
      // text that arrived through another repo's .memory/ file must not surface in unrelated projects
      // (search filters in JS instead: the rows are fetched anyway and the extra SQL condition costs ~0.7 ms)
      if (hideForeignTeam) {
        where.push(`(${a}source != 'team' OR ${a}project_id = ?)`);
        args.push(projectId ?? '\u0000none');
      }
      break;
    case 'all':
    default:
      where.push(`(${a}scope = 'global' OR ${a}project_id = ?)`);
      args.push(projectId ?? '\u0000none');
  }
}

const SHORT: Record<MemType, string> = {
  preference: 'pref',
  environment: 'env',
  stack: 'stack',
  convention: 'conv',
  decision: 'dec',
  command: 'cmd',
  gotcha: 'gotcha',
  todo: 'todo',
  note: 'note',
};
export const shortType = (t: MemType): string => SHORT[t] ?? t;
