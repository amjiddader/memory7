import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { DB } from './db.js';
import type { ProjectInfo } from './types.js';

const sha = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);

/** Walk up from `dir` to the directory containing `.git` (dir or file). */
export function findGitRoot(dir: string): string | null {
  let cur = resolve(dir);
  for (;;) {
    if (existsSync(join(cur, '.git'))) return cur;
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

/** Resolve the real `.git` directory, following worktree/submodule `.git` files. Returns [gitDir, commonDir]. */
function gitDirs(root: string): [string, string] | null {
  const dot = join(root, '.git');
  try {
    const st = statSync(dot);
    if (st.isDirectory()) return [dot, dot];
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, 'utf8'));
    if (!m) return null;
    const gitDir = resolve(root, m[1]!.trim());
    let common = gitDir;
    try {
      common = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim());
    } catch {
      /* not a linked worktree */
    }
    return [gitDir, common];
  } catch {
    return null;
  }
}

export function normalizeRemote(url: string): string {
  let u = url.trim().toLowerCase();
  u = u.replace(/^[a-z+]+:\/\//, ''); // protocol
  u = u.replace(/^[^@/]+@/, ''); // user@
  u = u.replace(/:(?!\d+\/)/, '/'); // scp-style host:path -> host/path (leave host:port/ alone)
  u = u.replace(/:\d+\//, '/'); // drop port
  u = u.replace(/\.git$/, '').replace(/\/+$/, '');
  return u;
}

export function readRemote(root: string): string | null {
  const dirs = gitDirs(root);
  if (!dirs) return null;
  try {
    const cfg = readFileSync(join(dirs[1], 'config'), 'utf8');
    const m = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(cfg);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

export function readBranch(root: string): string | null {
  const dirs = gitDirs(root);
  if (!dirs) return null;
  try {
    const head = readFileSync(join(dirs[0], 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return m ? m[1]! : head.slice(0, 8);
  } catch {
    return null;
  }
}

function canon(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

function isTooBroad(dir: string): boolean {
  const d = canon(dir);
  return d === canon(homedir()) || d === dirname(d);
}

/**
 * Identify the project for a working directory.
 * id = hash of the normalized origin URL (clones/worktrees share memory), else hash of the real path.
 * Returns null when there is no sensible project (home dir, filesystem root).
 */
export function detectProject(dir: string): ProjectInfo | null {
  let start: string;
  try {
    // .native returns the real on-disk casing on macOS/Windows, so one folder opened via two spellings is one project
    start = realpathSync.native(dir);
  } catch {
    return null;
  }
  const gitRoot = findGitRoot(start);
  const root = gitRoot ?? start;
  if (!gitRoot && isTooBroad(root)) return null;
  if (gitRoot && isTooBroad(gitRoot)) return null;
  const remote = gitRoot ? readRemote(gitRoot) : null;
  const id = remote ? sha('remote:' + normalizeRemote(remote)) : sha('path:' + root);
  return { id, name: basename(root), root, remote };
}

/** Insert or refresh the project row. Moves are handled by updating root. */
export function registerProject(db: DB, p: ProjectInfo): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO projects(id, name, root, remote, created_at, last_seen) VALUES(?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, root=excluded.root, remote=excluded.remote, last_seen=excluded.last_seen`,
  ).run(p.id, p.name, p.root, p.remote, now, now);
}
