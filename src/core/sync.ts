import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hashFile, parseAnchors, safeJoin } from './anchors.js';
import { getMeta, setMeta } from './db.js';
import type { Config, DB } from './db.js';
import { DUP_THRESHOLD, findSimilar } from './dedupe.js';
import { cleanContent, cleanTags, newUid } from './store.js';
import type { Store } from './store.js';
import { findSecret } from './secrets.js';
import { MAX_CONTENT, MEM_TYPES } from './types.js';
import type { Anchor, MemType, Memory, ProjectInfo } from './types.js';

/**
 * Shared project memory.
 *
 * `<repo>/.memory/memory.jsonl` is the source of truth for memories shared through git; the local SQLite
 * database stays the fast index. One JSON object per line, sorted by `ident`, so diffs are small and
 * `merge=union` (written to .memory/.gitattributes) merges concurrent additions without conflicts.
 *
 *   ident    the memory's key, or "~<uid>" for keyless memories (stable across machines)
 *   updated  unix seconds; the newest line wins on conflict
 *   deleted  tombstone, so a delete reaches teammates who still have the memory
 *
 * Sync is enabled for a project when its `.memory/` folder exists (created by `memory7 init --project`).
 * Everything read from the file is untrusted: lines are validated, secret-filtered, size-limited and can
 * only create project-scoped memories.
 */

export const SYNC_DIR = '.memory';
export const SYNC_FILE = 'memory.jsonl';
const MAX_BYTES = 2_000_000;
const MAX_LINES = 5000;
const TOMBSTONE_DAYS = 180;
const IDENT = /^(?:~[0-9a-f]{6,32}|[a-z0-9:_.-]{1,60})$/;

export interface SyncLine {
  ident: string;
  updated: number;
  deleted?: true;
  type?: MemType;
  content?: string;
  tags?: string;
  files?: Array<{ p: string; h: string }>;
}

export interface SyncReport {
  created: number;
  updated: number;
  deleted: number;
  rejected: number;
  wrote: boolean;
  /** set when the file looked damaged and was left untouched */
  skippedWrite?: string;
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
const sec = (ms: number) => Math.floor(ms / 1000);

export const syncFile = (p: ProjectInfo): string => join(p.root, SYNC_DIR, SYNC_FILE);

export function syncEnabled(p: ProjectInfo | null, cfg: Config): p is ProjectInfo {
  if (!p || cfg.sync === false || process.env.MEMORY7_NO_SYNC) return false;
  return existsSync(join(p.root, SYNC_DIR));
}

/** Create the `.memory/` folder and the git settings that make the file merge cleanly. Returns paths that were newly created. */
export function enableSync(p: ProjectInfo): string[] {
  const created: string[] = [];
  const dir = join(p.root, SYNC_DIR);
  mkdirSync(dir, { recursive: true });
  const files: Array<[string, string]> = [
    ['.gitattributes', `${SYNC_FILE} text eol=lf merge=union\n`],
    ['.gitignore', '*.tmp\n'],
    [SYNC_FILE, ''],
  ];
  for (const [name, body] of files) {
    const f = join(dir, name);
    if (!existsSync(f)) {
      writeFileSync(f, body);
      created.push(join(SYNC_DIR, name));
    }
  }
  return created;
}

// ------------------------------------------------------------------ parsing

function validate(raw: unknown): SyncLine | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.ident !== 'string' || !IDENT.test(r.ident)) return null;
  if (typeof r.updated !== 'number' || !Number.isFinite(r.updated) || r.updated <= 0) return null;
  const updated = Math.min(Math.floor(r.updated), sec(Date.now()) + 86_400); // no far-future timestamps that would win forever
  if (r.deleted === true) return { ident: r.ident, updated, deleted: true };

  if (typeof r.type !== 'string' || !(MEM_TYPES as readonly string[]).includes(r.type)) return null;
  if (typeof r.content !== 'string') return null;
  const content = cleanContent(r.content);
  if (!content || content.length > MAX_CONTENT || findSecret(content)) return null;
  const line: SyncLine = { ident: r.ident, updated, type: r.type as MemType, content };
  if (typeof r.tags === 'string') {
    const t = cleanTags(r.tags);
    if (t) line.tags = t;
  }
  if (Array.isArray(r.files)) {
    const files: Array<{ p: string; h: string }> = [];
    for (const f of r.files.slice(0, 10)) {
      const o = f as { p?: unknown; h?: unknown };
      if (typeof o?.p === 'string' && o.p.length <= 300 && typeof o.h === 'string' && /^[0-9a-f]{8,40}$/.test(o.h)) files.push({ p: o.p, h: o.h });
    }
    if (files.length) line.files = files;
  }
  return line;
}

export function parseSyncText(text: string): { lines: SyncLine[]; rejected: number } {
  const lines: SyncLine[] = [];
  let rejected = 0;
  let n = 0;
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    if (++n > MAX_LINES) {
      rejected++;
      continue;
    }
    try {
      const l = validate(JSON.parse(raw));
      if (l) lines.push(l);
      else rejected++;
    } catch {
      rejected++;
    }
  }
  return { lines, rejected };
}

function encode(l: SyncLine): string {
  const o: Record<string, unknown> = { ident: l.ident, updated: l.updated };
  if (l.deleted) o.deleted = true;
  else {
    o.type = l.type;
    o.content = l.content;
    if (l.tags) o.tags = l.tags;
    if (l.files?.length) o.files = l.files;
  }
  return JSON.stringify(o);
}

// ------------------------------------------------------------------ import

const identOf = (m: Memory): string => m.key ?? `~${m.uid}`;

function findActive(store: Store, pid: string, ident: string): Memory | undefined {
  if (ident.startsWith('~')) {
    return store.db.prepare("SELECT * FROM memories WHERE project_id = ? AND scope = 'project' AND uid = ? AND deleted_at IS NULL").get(pid, ident.slice(1)) as Memory | undefined;
  }
  return store.getByKey('project', pid, ident);
}

function findDeleted(db: DB, pid: string, ident: string): Memory | undefined {
  const sql = ident.startsWith('~')
    ? "SELECT * FROM memories WHERE project_id = ? AND scope = 'project' AND uid = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 1"
    : "SELECT * FROM memories WHERE project_id = ? AND scope = 'project' AND key = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 1";
  return db.prepare(sql).get(pid, ident.startsWith('~') ? ident.slice(1) : ident) as Memory | undefined;
}

/** Baseline anchors from a shared line. `m` is the current mtime when the local file already matches, so unchanged files are not re-hashed. */
function anchorsFromLine(root: string, files: SyncLine['files']): string | null {
  const out: Anchor[] = [];
  for (const f of files ?? []) {
    const abs = safeJoin(root, f.p);
    if (!abs) continue;
    let m = 0;
    try {
      const st = statSync(abs);
      if (st.isFile() && hashFile(abs) === f.h) m = Math.floor(st.mtimeMs);
    } catch {
      /* file absent here: stays unverifiable, reported as missing */
    }
    out.push({ p: f.p, h: f.h, m });
  }
  return out.length ? JSON.stringify(out) : null;
}

function applyLine(store: Store, project: ProjectInfo, line: SyncLine, rep: SyncReport): void {
  const db = store.db;
  const pid = project.id;
  const active = findActive(store, pid, line.ident);

  if (line.deleted) {
    // delete only if our copy is not newer than the deletion
    if (active && sec(active.updated_at) <= line.updated) {
      store.delete([active.id], 'team');
      rep.deleted++;
    }
    return;
  }

  const anchors = anchorsFromLine(project.root, line.files);
  const ms = line.updated * 1000;

  if (active) {
    // newest wins; auto-detected memories never beat a shared one
    if (line.updated > sec(active.updated_at) || active.source === 'auto') {
      db.prepare("UPDATE memories SET content = ?, type = ?, tags = ?, anchors = ?, source = 'team', updated_at = ? WHERE id = ?").run(
        line.content!, line.type!, line.tags ?? null, anchors, ms, active.id,
      );
      store.history(active.id, 'update', active.content, line.content!, 'team');
      rep.updated++;
    }
    return;
  }

  const gone = findDeleted(db, pid, line.ident);
  if (gone) {
    if (line.updated <= sec(gone.deleted_at ?? 0)) return; // we deleted it after this line was written
    db.prepare("UPDATE memories SET deleted_at = NULL, content = ?, type = ?, tags = ?, anchors = ?, source = 'team', updated_at = ? WHERE id = ?").run(
      line.content!, line.type!, line.tags ?? null, anchors, ms, gone.id,
    );
    store.history(gone.id, 'restore', null, line.content!, 'team');
    rep.created++;
    return;
  }

  const keyed = !line.ident.startsWith('~');
  if (!keyed) {
    // the same note saved independently on two machines: adopt the teammate's id instead of duplicating it
    const twin = findSimilar(db, 'project', pid, line.content!, 3).find(
      (h) => h.score >= DUP_THRESHOLD && h.memory.type === line.type && !h.memory.key && h.memory.source !== 'auto',
    );
    if (twin) {
      db.prepare('UPDATE memories SET uid = ? WHERE id = ?').run(line.ident.slice(1), twin.memory.id);
      if (line.updated > sec(twin.memory.updated_at)) {
        db.prepare("UPDATE memories SET content = ?, tags = ?, anchors = ?, source = 'team', updated_at = ? WHERE id = ?").run(
          line.content!, line.tags ?? null, anchors, ms, twin.memory.id,
        );
        store.history(twin.memory.id, 'update', twin.memory.content, line.content!, 'team');
        rep.updated++;
      }
      return;
    }
  }

  const r = db
    .prepare(
      `INSERT INTO memories(scope, project_id, key, type, content, tags, source, anchors, pinned, uid, created_at, updated_at)
       VALUES('project', ?, ?, ?, ?, ?, 'team', ?, 0, ?, ?, ?)`,
    )
    .run(pid, keyed ? line.ident : null, line.type!, line.content!, line.tags ?? null, anchors, keyed ? newUid() : line.ident.slice(1), ms, ms);
  store.history(Number(r.lastInsertRowid), 'create', null, line.content!, 'team');
  rep.created++;
}

// ------------------------------------------------------------------ export

function buildExport(store: Store, project: ProjectInfo, fileLines: SyncLine[]): string {
  const db = store.db;
  const cutoff = Date.now() - TOMBSTONE_DAYS * 86_400_000;
  const best = new Map<string, SyncLine>();
  const offer = (l: SyncLine) => {
    const cur = best.get(l.ident);
    // newest wins; on a tie a live memory beats a tombstone
    if (!cur || l.updated > cur.updated || (l.updated === cur.updated && cur.deleted && !l.deleted)) best.set(l.ident, l);
  };

  const live = db
    .prepare("SELECT * FROM memories WHERE project_id = ? AND scope = 'project' AND deleted_at IS NULL AND source != 'auto' AND local_only = 0")
    .all(project.id) as unknown as Memory[];
  for (const m of live) {
    const l: SyncLine = { ident: identOf(m), updated: sec(m.updated_at), type: m.type, content: m.content };
    if (m.tags) l.tags = m.tags;
    const anchors = parseAnchors(m.anchors);
    if (anchors.length) l.files = anchors.map((a) => ({ p: a.p, h: a.h }));
    offer(l);
  }

  const dead = db
    .prepare("SELECT * FROM memories WHERE project_id = ? AND scope = 'project' AND deleted_at IS NOT NULL AND deleted_at > ? AND source != 'auto' AND local_only = 0")
    .all(project.id, cutoff) as unknown as Memory[];
  for (const m of dead) offer({ ident: identOf(m), updated: sec(m.deleted_at!), deleted: true });

  // tombstones already in the file stay until they expire
  for (const l of fileLines) if (l.deleted && l.updated * 1000 > cutoff) offer(l);

  return [...best.values()]
    .sort((a, b) => (a.ident < b.ident ? -1 : a.ident > b.ident ? 1 : 0))
    .map(encode)
    .map((s) => s + '\n')
    .join('');
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Write via a temp file and rename. Windows can refuse the rename while another process (git, antivirus) holds the file, so retry, then fall back to a direct write. */
export function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  try {
    for (let i = 0; i < 5; i++) {
      try {
        renameSync(tmp, path);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw e;
        sleepSync(25 * (i + 1));
      }
    }
    writeFileSync(path, text);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* already renamed */
    }
  }
}

// ------------------------------------------------------------------ sync

/**
 * Two-way sync: pull in whatever changed in the file (git pull, a teammate's commit, a hand edit),
 * then write our state back if it differs. Safe to call often; it is a file read and a hash when nothing changed.
 */
export function sync(store: Store, project: ProjectInfo): SyncReport {
  const rep: SyncReport = { created: 0, updated: 0, deleted: 0, rejected: 0, wrote: false };
  const file = syncFile(project);
  let text = '';
  if (existsSync(file)) {
    if (statSync(file).size > MAX_BYTES) throw new Error(`${file} is larger than ${MAX_BYTES} bytes; not syncing`);
    text = readFileSync(file, 'utf8');
  }
  const parsed = parseSyncText(text);
  rep.rejected = parsed.rejected;
  const metaKey = `sync:${project.id}`;

  if (getMeta(store.db, metaKey) !== sha1(text)) {
    store.tx(() => {
      for (const l of parsed.lines) applyLine(store, project, l, rep);
    });
  }

  // never rewrite a file we mostly cannot read (merge-conflict markers, a newer format): that would destroy it
  if (parsed.rejected >= 3 && parsed.rejected > parsed.lines.length * 0.2) {
    rep.skippedWrite = `${parsed.rejected} unreadable lines in ${SYNC_DIR}/${SYNC_FILE}`;
    return rep;
  }

  const out = buildExport(store, project, parsed.lines);
  if (out !== text) {
    atomicWrite(file, out);
    rep.wrote = true;
  }
  setMeta(store.db, metaKey, sha1(out));
  return rep;
}
