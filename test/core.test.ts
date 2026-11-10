import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/core/db.js';
import { gc } from '../src/core/gc.js';
import { infer } from '../src/core/infer.js';
import { detectProject, normalizeRemote } from '../src/core/project.js';
import { findSecret } from '../src/core/secrets.js';
import { cleanup, engineFor, makeProject, tmp, write } from './helpers.js';

const dirs: string[] = [];
afterEach(() => cleanup(...dirs.splice(0)));
const mk = (files: Record<string, string> = {}, remote?: string) => {
  const d = makeProject(files, remote);
  dirs.push(d);
  return d;
};

describe('project identity', () => {
  it('normalizes remotes so https and ssh clones share an id', () => {
    expect(normalizeRemote('git@github.com:Acme/Web.git')).toBe('github.com/acme/web');
    expect(normalizeRemote('https://github.com/acme/web.git')).toBe('github.com/acme/web');
    expect(normalizeRemote('https://user:tok@github.com/acme/web')).toBe('github.com/acme/web');
    expect(normalizeRemote('ssh://git@host:2222/acme/web.git')).toBe('host/acme/web');
  });

  it('gives two clones with the same remote the same id, and different paths different ids otherwise', () => {
    const a = detectProject(mk({}, 'git@github.com:acme/web.git'))!;
    const b = detectProject(mk({}, 'https://github.com/acme/web.git'))!;
    expect(a.id).toBe(b.id);
    const c = detectProject(mk())!;
    const d = detectProject(mk())!;
    expect(c.id).not.toBe(d.id);
  });

  it('finds the git root from a subdirectory and refuses home / filesystem root', () => {
    const d = mk();
    mkdirSync(join(d, 'a/b'), { recursive: true });
    expect(detectProject(join(d, 'a/b'))!.root).toBe(d);
    expect(detectProject('/')).toBeNull();
    expect(detectProject(homedir())).toBeNull();
  });

  it('follows linked worktrees to the shared remote', () => {
    const main = mk({}, 'git@github.com:acme/web.git');
    const wt = tmp('wt-');
    dirs.push(wt);
    mkdirSync(join(main, '.git/worktrees/wt'), { recursive: true });
    write(main, '.git/worktrees/wt/commondir', '../..\n');
    write(main, '.git/worktrees/wt/HEAD', 'ref: refs/heads/feature\n');
    writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git/worktrees/wt')}\n`);
    expect(detectProject(wt)!.id).toBe(detectProject(main)!.id);
  });

  // creating symlinks needs elevated rights on Windows
  it.skipIf(process.platform === 'win32')('resolves symlinked directories to one project', () => {
    const d = mk();
    const link = join(tmp('lnk-'), 'link');
    dirs.push(join(link, '..'));
    symlinkSync(d, link);
    expect(detectProject(link)!.id).toBe(detectProject(d)!.id);
  });
});

describe('secrets', () => {
  it.each([
    'AKIAIOSFODNN7EXAMPLE',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789ab',
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
    'sk_live_abcdefghijklmnop1234',
    'xoxb-123456789012-abcdefghij',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk',
    '-----BEGIN RSA PRIVATE KEY-----',
    'postgres://admin:supersecret@db.example.com/app',
    'API_KEY=abcdef123456',
    'use token Zx9Qm2Lp7Vb4Nc8Rt1Yw6Hd3Kf5Js0GaEu',
  ])('detects %s', (s) => expect(findSecret(s)).not.toBeNull());

  it.each([
    'Uses pnpm and vitest',
    'Test command is `pnpm test -- --run`',
    'Commit 3f2a9c1d8b7e6f5a4c3b2a1d0e9f8a7b6c5d4e3f is the baseline',
    'Config at /home/user/projects/acme/src/lib/auth/session/handlers.ts',
    'Env var names: DATABASE_URL, STRIPE_SECRET_KEY (values in .env)',
    'password reset flow lives in src/auth',
  ])('allows %s', (s) => expect(findSecret(s)).toBeNull());
});

describe('inference', () => {
  it('maps common wording to scope/type/key', () => {
    expect(infer('User uses Ubuntu', {})).toMatchObject({ scope: 'global', type: 'environment', key: 'os' });
    expect(infer('I use zsh', {})).toMatchObject({ scope: 'global', key: 'shell' });
    expect(infer('I prefer concise answers', {})).toMatchObject({ scope: 'global', key: 'response-style' });
    expect(infer('We decided to use Drizzle instead of Prisma', {})).toMatchObject({ scope: 'project', type: 'decision' });
    expect(infer('Run tests with `pnpm test`', {})).toMatchObject({ scope: 'project', type: 'command', key: 'test-cmd' });
    expect(infer('Careful: migrations break if seed runs first', {})).toMatchObject({ type: 'gotcha' });
    expect(infer('TODO: rotate refresh tokens', {})).toMatchObject({ type: 'todo' });
    expect(infer('The database is Postgres', {})).toMatchObject({ key: 'db' });
  });

  it('explicit values always win', () => {
    expect(infer('User uses Ubuntu', { scope: 'project', type: 'note', key: 'custom' })).toMatchObject({ scope: 'project', type: 'note', key: 'custom' });
  });
});

describe('gc', () => {
  it('merges duplicates, archives old unused notes, removes done todos; undo works', () => {
    const e = engineFor(mk());
    const now = Date.now();
    const ins = (content: string, type: string, extra: Record<string, number> = {}) =>
      e.db
        .prepare('INSERT INTO memories(scope, project_id, type, content, source, created_at, updated_at, hit_count, pinned) VALUES(?,?,?,?,?,?,?,?,?)')
        .run('project', e.project!.id, type, content, 'ai', extra.t ?? now, extra.t ?? now, extra.hits ?? 0, extra.pin ?? 0);
    ins('Same fact twice', 'note');
    ins('same fact twice!', 'note');
    ins('Ancient note', 'note', { t: now - 400 * 86_400_000 });
    ins('Ancient but used', 'note', { t: now - 400 * 86_400_000, hits: 3 });
    ins('Ancient but pinned', 'note', { t: now - 400 * 86_400_000, pin: 1 });
    ins('[x] ship the thing', 'todo');
    ins('ship the other thing', 'todo');
    const r = gc(e.store, now);
    expect(r).toEqual({ merged: 1, archived: 1, doneTodos: 1 });
    const left = e.store.list({ scope: 'project', projectId: e.project!.id }).map((m) => m.content).sort();
    expect(left).toEqual(['Ancient but pinned', 'Ancient but used', 'Same fact twice', 'ship the other thing']);
    const archived = e.db.prepare("SELECT id FROM memories WHERE content='Ancient note'").get() as { id: number };
    expect(e.store.undo(archived.id)).toMatch(/restored/);
  });
});

describe('database', () => {
  it('migrates a fresh file and is reopenable (WAL, shared by two connections)', () => {
    const dir = tmp('db-');
    dirs.push(dir);
    const path = join(dir, 'x.db');
    const a = openDb(path);
    const b = openDb(path);
    a.prepare("INSERT INTO meta(k,v) VALUES('t','1')").run();
    expect((b.prepare("SELECT v FROM meta WHERE k='t'").get() as { v: string }).v).toBe('1');
    expect((a.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    a.close();
    b.close();
  });
});
