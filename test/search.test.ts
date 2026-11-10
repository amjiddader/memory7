import { afterEach, describe, expect, it } from 'vitest';
import { queryTerms } from '../src/core/search.js';
import { cleanup, engineFor, makeProject } from './helpers.js';

const dirs: string[] = [];
afterEach(() => cleanup(...dirs.splice(0)));
const proj = () => {
  const d = makeProject();
  dirs.push(d);
  return d;
};

describe('queryTerms', () => {
  it('drops stopwords and keeps dotted/hyphenated tech terms', () => {
    expect(queryTerms('What is the Node.js version I use?')).toEqual(['node.js', 'version']);
    expect(queryTerms('the a is')).toEqual([]);
  });
});

describe('search', () => {
  it('finds "Ubuntu" from the query "OS" through synonym expansion', () => {
    const e = engineFor(proj());
    e.save({ content: 'User uses Ubuntu 24.04', scope: 'global' });
    expect(e.search('os').hits.map((h) => h.memory.content)).toEqual(['User uses Ubuntu 24.04']);
    expect(e.search('which operating system').hits).toHaveLength(1);
  });

  it('prefix and stemming: "tests" finds "testing"', () => {
    const e = engineFor(proj());
    e.save({ content: 'Prefers testing with vitest' });
    expect(e.search('tests').hits.length).toBe(1);
  });

  it('tolerates typos through the trigram fallback', () => {
    const e = engineFor(proj());
    e.save({ content: 'Database is PostgreSQL 16' });
    expect(e.search('postgress').hits.length).toBe(1);
    expect(e.search('kubernetes').hits.length).toBe(0);
  });

  it('prefers memories that match every term (AND before OR)', () => {
    const e = engineFor(proj());
    e.save({ content: 'Frontend is built with React and Vite' });
    e.save({ content: 'Backend is Express' });
    const hits = e.search('react vite frontend').hits;
    expect(hits[0]!.memory.content).toMatch(/React and Vite/);
  });

  it('respects scope filters', () => {
    const a = proj();
    const e = engineFor(a);
    e.save({ content: 'Global pref: dark theme', scope: 'global' });
    e.save({ content: 'Project note: dark launch flag is FOO', scope: 'project' });
    expect(e.search('dark', 'global').hits).toHaveLength(1);
    expect(e.search('dark', 'project').hits).toHaveLength(1);
    expect(e.search('dark', 'all').hits).toHaveLength(2);
    // another project only shows with any-project
    e.setProject({ id: 'zzz', name: 'zzz', root: proj(), remote: null });
    expect(e.search('dark', 'all').hits).toHaveLength(1);
    const any = e.search('dark', 'any-project');
    expect(any.hits).toHaveLength(2);
    expect(any.text).toContain('p:');
  });

  it('ranks pinned and frequently used memories higher', () => {
    const e = engineFor(proj());
    const a = e.save({ content: 'Lint with eslint config A' });
    const b = e.save({ content: 'Lint with biome config B' });
    e.store.pin(b.id!, true);
    expect(e.search('lint').hits[0]!.memory.id).toBe(b.id);
    e.store.pin(b.id!, false);
    for (let i = 0; i < 20; i++) e.store.touch([a.id!]), e.store.flush();
    expect(e.search('lint').hits[0]!.memory.id).toBe(a.id);
  });

  it('does not throw on FTS syntax characters', () => {
    const e = engineFor(proj());
    e.save({ content: 'Uses "quoted" things (and) parens*' });
    for (const q of ['"', '(', 'a AND', 'NEAR(', '*', 'x:y', '-', 'OR OR', "it's"]) expect(() => e.search(q)).not.toThrow();
  });

  it('counts hits asynchronously and keeps the digest read-only', () => {
    const e = engineFor(proj());
    const a = e.save({ content: 'Prefers pnpm', scope: 'global' });
    e.context();
    expect(e.store.get(a.id!)!.hit_count).toBe(0);
    e.search('pnpm');
    e.store.flush();
    expect(e.store.get(a.id!)!.hit_count).toBe(1);
  });

  it('returns compact one-line results', () => {
    const e = engineFor(proj());
    e.save({ content: 'Prefers pnpm over npm', scope: 'global' });
    expect(e.search('pnpm').text).toMatch(/^#\d+ \[pref\|g\] \{pkg-manager\} Prefers pnpm over npm$/);
  });
});
