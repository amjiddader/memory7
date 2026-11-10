import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openDb } from '../src/core/db.js';
import { Engine } from '../src/core/engine.js';
import { detectProject } from '../src/core/project.js';

export function tmp(prefix = 'memory7-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function write(dir: string, rel: string, content: string): void {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

/** A throwaway git-style project directory (fake .git is enough for identity). */
export function makeProject(files: Record<string, string> = {}, remote?: string): string {
  const dir = tmp('proj-');
  mkdirSync(join(dir, '.git'));
  write(dir, '.git/HEAD', 'ref: refs/heads/main\n');
  write(dir, '.git/config', remote ? `[remote "origin"]\n\turl = ${remote}\n` : '[core]\n');
  for (const [k, v] of Object.entries(files)) write(dir, k, v);
  return dir;
}

export function gitInit(dir: string, messages: string[]): void {
  const g = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  g('init', '-q');
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 't');
  for (const m of messages) g('commit', '-q', '--allow-empty', '-m', m);
}

export function engineFor(dir: string | null): Engine {
  const db = openDb(':memory:');
  const e = new Engine(db, null, {});
  if (dir) e.setProject(detectProject(dir));
  return e;
}

export const cleanup = (...dirs: string[]) => dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
