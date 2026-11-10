import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, engineFor, makeProject, write } from './helpers.js';

const dirs: string[] = [];
afterEach(() => cleanup(...dirs.splice(0)));
const proj = (files: Record<string, string> = {}) => {
  const d = makeProject(files);
  dirs.push(d);
  return d;
};

describe('save', () => {
  it('creates, infers scope/type/key and reports compactly', () => {
    const e = engineFor(proj());
    const r = e.save({ content: 'User uses Ubuntu 24.04' });
    expect(r.status).toBe('created');
    expect(r.message).toMatch(/^saved #\d+ \[env\|g\] \{os\}$/);
    const m = e.store.get(r.id!)!;
    expect(m.scope).toBe('global');
    expect(m.project_id).toBeNull();
  });

  it('keyed upsert replaces the old value and records history', () => {
    const e = engineFor(proj());
    const a = e.save({ content: 'User uses Ubuntu 24.04' });
    const b = e.save({ content: 'I switched to Fedora 41' });
    expect(b.status).toBe('updated');
    expect(b.id).toBe(a.id);
    expect(b.message).toContain('was: "User uses Ubuntu 24.04"');
    expect(e.store.get(a.id!)!.content).toBe('I switched to Fedora 41');
    const h = e.db.prepare('SELECT op FROM history WHERE memory_id=? ORDER BY id').all(a.id!) as Array<{ op: string }>;
    expect(h.map((x) => x.op)).toEqual(['create', 'update']);
  });

  it('does not read "deploy to ubuntu" as the user OS (needs first-person wording)', () => {
    const e = engineFor(proj());
    const r = e.save({ content: 'CI deploys to an ubuntu runner' });
    expect(e.store.get(r.id!)!.key).not.toBe('os');
  });

  it('skips exact and near duplicates', () => {
    const e = engineFor(proj());
    const a = e.save({ content: 'Use named exports everywhere', type: 'convention' });
    const b = e.save({ content: 'use named exports everywhere!' });
    expect(b.status).toBe('skipped');
    expect(b.id).toBe(a.id);
    expect(e.store.list({ scope: 'all', projectId: e.project!.id }).length).toBe(1);
  });

  it('hints at similar-but-different memories and updates them with replace', () => {
    const e = engineFor(proj());
    const a = e.save({ content: 'API tests run with vitest against a local postgres container' });
    const b = e.save({ content: 'API tests run with vitest against a local sqlite database' });
    expect(b.status).toBe('created');
    expect(b.message).toContain(`similar: #${a.id}`);
    const c = e.save({ content: 'API tests run with vitest against an in-memory database', replace: true });
    expect(c.status).toBe('updated');
  });

  it('rejects secrets, empty and oversized content', () => {
    const e = engineFor(proj());
    expect(e.save({ content: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789ab' }).status).toBe('rejected');
    expect(e.save({ content: 'password = hunter2hunter2' }).status).toBe('rejected');
    expect(e.save({ content: '   ' }).status).toBe('rejected');
    expect(e.save({ content: 'x'.repeat(501) }).message).toMatch(/max 500/);
  });

  it('rejects unknown types', () => {
    const e = engineFor(proj());
    expect(e.save({ content: 'hello world', type: 'bogus' as never }).status).toBe('rejected');
  });

  it('falls back to global when no project is detected', () => {
    const e = engineFor(null);
    const r = e.save({ content: 'We chose Drizzle', scope: 'project' });
    expect(r.message).toContain('no project detected');
    expect(e.store.get(r.id!)!.scope).toBe('global');
  });

  it('keeps project memories separate per project, keyed memories do not collide', () => {
    const a = proj();
    const e = engineFor(a);
    e.save({ content: 'Test command is `pnpm test`', key: 'test-cmd' });
    const b = proj();
    e.setProject({ id: 'other', name: 'other', root: b, remote: null });
    const r = e.save({ content: 'Test command is `npm test`', key: 'test-cmd' });
    expect(r.status).toBe('created');
  });

  it('batch-saves via separate calls and respects explicit id updates', () => {
    const e = engineFor(proj());
    const a = e.save({ content: 'Remember the staging URL lives in the wiki' });
    const b = e.save({ content: 'Staging URL moved to the new wiki', id: a.id });
    expect(b.status).toBe('updated');
    expect(e.save({ content: 'x y', id: 9999 }).status).toBe('rejected');
  });
});

describe('delete / undo / pin', () => {
  it('soft deletes, hides from search, and undo restores', () => {
    const e = engineFor(proj());
    const a = e.save({ content: 'Prefers tabs over spaces', scope: 'global' });
    expect(e.store.delete([a.id!])).toEqual([a.id]);
    expect(e.search('tabs').hits).toHaveLength(0);
    expect(e.store.undo(a.id!)).toMatch(/restored/);
    expect(e.search('tabs').hits).toHaveLength(1);
  });

  it('undo of an update reverts the content', () => {
    const e = engineFor(proj());
    const a = e.save({ content: 'User uses Ubuntu' });
    e.save({ content: 'I switched to Fedora' });
    expect(e.store.undo(a.id!)).toMatch(/reverted/);
    expect(e.store.get(a.id!)!.content).toBe('User uses Ubuntu');
    expect(e.search('ubuntu').hits).toHaveLength(1); // FTS index followed the revert
    const fts = (q: string) => e.db.prepare('SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?').all(q);
    expect(fts('fedora')).toHaveLength(0); // index no longer contains the reverted text
    expect(fts('ubuntu')).toHaveLength(1);
  });

  it('a deleted key can be reused, and restore then reports the conflict', () => {
    const e = engineFor(proj());
    const a = e.save({ content: 'User uses Ubuntu' });
    e.store.delete([a.id!]);
    const b = e.save({ content: 'User uses Arch Linux' });
    expect(b.status).toBe('created');
    expect(e.store.undo(a.id!)).toMatch(/cannot restore/);
  });

  it('pin toggles', () => {
    const e = engineFor(proj());
    const a = e.save({ content: 'Never force push to main', type: 'gotcha' });
    expect(e.store.pin(a.id!, true)).toBe(true);
    expect(e.store.get(a.id!)!.pinned).toBe(1);
  });
});

describe('anchors', () => {
  it('flags a memory ?stale after the anchored file changes', () => {
    const d = proj({ 'src/auth.ts': 'export const a = 1;' });
    const e = engineFor(d);
    e.save({ content: 'Auth logic lives in src/auth.ts', files: ['src/auth.ts'], key: 'auth-loc' });
    expect(e.search('auth').text).not.toContain('?stale');
    write(d, 'src/auth.ts', 'export const a = 2; // changed');
    expect(e.search('auth').text).toContain('?stale');
    // saving again with the same key refreshes the anchor
    e.save({ content: 'Auth logic lives in src/auth.ts (updated)', key: 'auth-loc' });
    expect(e.search('auth').text).not.toContain('?stale');
  });

  it('reports ?missing when the file is deleted and rejects paths outside the project', () => {
    const d = proj({ 'a.txt': 'x' });
    const e = engineFor(d);
    const r = e.save({ content: 'Notes about a.txt content', files: ['a.txt', '../../etc/passwd'] });
    expect(r.message).toContain('files not anchored: ../../etc/passwd');
    cleanup(d + '/a.txt');
    expect(e.search('notes').text).toContain('?missing');
  });
});
