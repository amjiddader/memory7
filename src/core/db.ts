import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

export interface Config {
  /** token budget for the session digest */
  budget?: number;
  /** sync project memory with <repo>/.memory/memory.jsonl when that folder exists (default true) */
  sync?: boolean;
}

export function memoryHome(): string {
  return process.env.MEMORY7_HOME || join(homedir(), '.memory7');
}

export function loadConfig(): Config {
  try {
    const raw = JSON.parse(readFileSync(join(memoryHome(), 'config.json'), 'utf8'));
    return raw && typeof raw === 'object' ? (raw as Config) : {};
  } catch {
    return {};
  }
}

const require_ = createRequire(import.meta.url);

/** node:sqlite prints an ExperimentalWarning on some Node versions. stdout must stay clean for MCP and stderr noise helps nobody. */
function loadSqlite(): typeof import('node:sqlite') {
  const orig = process.emitWarning;
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : (warning as Error)?.message ?? '';
    if (/sqlite/i.test(text)) return;
    return (orig as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return require_('node:sqlite');
  } finally {
    process.emitWarning = orig;
  }
}

const SCHEMA_VERSION = 2;

export const MIGRATIONS: Record<number, string> = {
  1: `
CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT, root TEXT, remote TEXT,
  created_at INTEGER, last_seen INTEGER
);

CREATE TABLE memories (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global','project')),
  project_id TEXT REFERENCES projects(id),
  key TEXT,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT,
  source TEXT NOT NULL,
  anchors TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX mem_key ON memories(scope, IFNULL(project_id,''), key)
  WHERE key IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX mem_scope ON memories(project_id, type, deleted_at);

CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, tags, key,
  content='memories', content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 2', prefix='2 3'
);
CREATE VIRTUAL TABLE memories_tri USING fts5(
  content, content='memories', content_rowid='id', tokenize='trigram'
);

CREATE TRIGGER mem_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, tags, key) VALUES (new.id, new.content, new.tags, new.key);
  INSERT INTO memories_tri(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER mem_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags, key) VALUES ('delete', old.id, old.content, old.tags, old.key);
  INSERT INTO memories_tri(memories_tri, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER mem_au AFTER UPDATE OF content, tags, key ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags, key) VALUES ('delete', old.id, old.content, old.tags, old.key);
  INSERT INTO memories_fts(rowid, content, tags, key) VALUES (new.id, new.content, new.tags, new.key);
  INSERT INTO memories_tri(memories_tri, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO memories_tri(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE history (
  id INTEGER PRIMARY KEY,
  memory_id INTEGER NOT NULL,
  op TEXT NOT NULL,
  old_content TEXT,
  new_content TEXT,
  at INTEGER NOT NULL,
  source TEXT
);
CREATE INDEX history_mem ON history(memory_id, id);

CREATE TABLE detectors (
  project_id TEXT NOT NULL,
  file TEXT NOT NULL,
  hash TEXT,
  checked_at INTEGER,
  PRIMARY KEY (project_id, file)
);

CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
`,
  2: `
ALTER TABLE memories ADD COLUMN uid TEXT;
ALTER TABLE memories ADD COLUMN local_only INTEGER NOT NULL DEFAULT 0;
UPDATE memories SET uid = lower(hex(randomblob(6))) WHERE uid IS NULL;
CREATE UNIQUE INDEX mem_uid ON memories(IFNULL(project_id,''), uid);
`,
};

export function openDb(path?: string): DB {
  const home = memoryHome();
  const file = path ?? join(home, 'memory7.db');
  if (file !== ':memory:') mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 3000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function currentVersion(db: DB): number {
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
  if (!t) return 0;
  const row = db.prepare("SELECT v FROM meta WHERE k='schema_version'").get() as { v: string } | undefined;
  return row ? Number(row.v) : 0;
}

function migrate(db: DB): void {
  let v = currentVersion(db);
  if (v >= SCHEMA_VERSION) return;
  // BEGIN IMMEDIATE so two processes starting together do not both migrate.
  db.exec('BEGIN IMMEDIATE');
  try {
    v = currentVersion(db);
    for (let next = v + 1; next <= SCHEMA_VERSION; next++) {
      db.exec(MIGRATIONS[next]!);
      db.prepare("INSERT INTO meta(k, v) VALUES('schema_version', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(String(next));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getMeta(db: DB, k: string): string | undefined {
  const r = db.prepare('SELECT v FROM meta WHERE k=?').get(k) as { v: string } | undefined;
  return r?.v;
}

export function setMeta(db: DB, k: string, v: string): void {
  db.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, v);
}
