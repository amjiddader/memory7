import { afterEach, describe, expect, it } from 'vitest';
import { capture } from '../src/capture/index.js';
import { detect } from '../src/capture/detectors.js';
import { cleanup, engineFor, gitInit, makeProject, write } from './helpers.js';

const dirs: string[] = [];
afterEach(() => cleanup(...dirs.splice(0)));
const proj = (files: Record<string, string> = {}) => {
  const d = makeProject(files);
  dirs.push(d);
  return d;
};

const NODE = JSON.stringify({
  name: 'acme',
  packageManager: 'pnpm@9.1.0',
  scripts: { test: 'vitest run', dev: 'next dev', build: 'next build', lint: 'eslint .' },
  dependencies: { next: '15', react: '19', '@prisma/client': '5' },
  devDependencies: { typescript: '5', vitest: '2', tailwindcss: '4' },
});

describe('detectors', () => {
  it('reads a Node/Next project', () => {
    const d = proj({ 'package.json': NODE, 'tsconfig.json': '{}', '.nvmrc': 'v22.1.0\n', 'pnpm-lock.yaml': '' });
    const r = detect(d);
    const by = Object.fromEntries(r.facts.map((f) => [f.key, f.content]));
    expect(by.stack).toBe('Stack: TypeScript, Next.js, React, Prisma, Vitest, Tailwind');
    expect(by['pkg-manager']).toBe('Package manager: pnpm');
    expect(by['test-cmd']).toBe('Test: `pnpm test` → `vitest run`');
    expect(by['dev-cmd']).toContain('pnpm dev');
    expect(by['node-version']).toBe('Node 22.1.0');
  });

  it('uses npm conventions and lockfile detection', () => {
    const d = proj({ 'package.json': JSON.stringify({ scripts: { test: 'jest', build: 'tsc' } }), 'package-lock.json': '{}' });
    const by = Object.fromEntries(detect(d).facts.map((f) => [f.key, f.content]));
    expect(by['test-cmd']).toContain('`npm test`');
    expect(by['build-cmd']).toContain('`npm run build`');
  });

  it('reads Python, Rust, Go and infra files', () => {
    const d = proj({
      'pyproject.toml': '[project]\nrequires-python = ">=3.12"\ndependencies = ["fastapi", "pydantic"]\n[tool.pytest.ini_options]\n',
      'uv.lock': '',
      'Cargo.toml': '[package]\nedition = "2021"\n',
      'go.mod': 'module x\n\ngo 1.23\n',
      Dockerfile: 'FROM node:22-alpine\n',
      'docker-compose.yml': 'services:\n  web:\n    image: x\n  db:\n    image: postgres\n',
      '.github/workflows/ci.yml': 'name: ci',
      '.env.example': 'DATABASE_URL=postgres://user:secret@localhost/db\nSTRIPE_KEY=\n',
      Makefile: 'test:\n\tgo test\nbuild:\n\tgo build\n',
    });
    const by = Object.fromEntries(detect(d).facts.map((f) => [f.key, f.content]));
    expect(by.stack).toContain('Python, FastAPI, Pydantic');
    expect(by.stack).toContain('Rust');
    expect(by.stack).toContain('Go');
    expect(by['python-version']).toBe('Python >=3.12');
    expect(by['pkg-manager']).toBe('Package manager: uv');
    expect(by.container).toContain('node:22-alpine');
    expect(by.container).toContain('compose services: web, db');
    expect(by.ci).toContain('ci.yml');
    expect(by['env-vars']).toBe('Env vars (.env.example): DATABASE_URL, STRIPE_KEY');
    expect(by['env-vars']).not.toContain('secret'); // names only, never values
    expect(by['task-runner']).toContain('test, build');
  });

  it('survives broken manifests', () => {
    const d = proj({ 'package.json': '{not json', 'go.mod': '' });
    expect(() => detect(d)).not.toThrow();
  });
});

describe('capture', () => {
  it('stores auto memories, skips when nothing changed, and updates on change', () => {
    const d = proj({ 'package.json': NODE, 'pnpm-lock.yaml': '' });
    const e = engineFor(d);
    const first = capture(e.store, e.project!);
    expect(first.ran).toBe(true);
    expect(first.created).toBeGreaterThan(3);
    expect(capture(e.store, e.project!).ran).toBe(false);

    write(d, 'package.json', JSON.stringify({ scripts: { test: 'jest' }, dependencies: { express: '4' } }));
    const r = capture(e.store, e.project!);
    expect(r.ran).toBe(true);
    const text = e.store.list({ scope: 'project', projectId: e.project!.id }).map((m) => m.content).join('\n');
    expect(text).toContain('Test: `pnpm test` → `jest`');
    expect(text).toContain('Express');
    expect(text).not.toContain('Next.js');
    expect(r.removed).toBeGreaterThan(0); // dev/build/lint scripts are gone
    expect(text).not.toContain('Dev server');
  });

  it('never overwrites a key the user or AI has set', () => {
    const d = proj({ 'package.json': NODE, 'pnpm-lock.yaml': '' });
    const e = engineFor(d);
    e.save({ content: 'Run tests with `pnpm test:unit` (integration tests are separate)', key: 'test-cmd', type: 'command' });
    capture(e.store, e.project!);
    expect(e.store.getByKey('project', e.project!.id, 'test-cmd')!.content).toContain('test:unit');
    // and survives a forced re-run + removal pass
    capture(e.store, e.project!, true);
    expect(e.store.getByKey('project', e.project!.id, 'test-cmd')!.source).toBe('ai');
  });

  it('runs lazily from tool calls (throttled) so memory follows the code', () => {
    const d = proj({ 'package.json': JSON.stringify({ scripts: { test: 'jest' } }) });
    const e = engineFor(d);
    e.refresh(true);
    expect(e.search('test').text).toContain('jest');
    write(d, 'package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
    e.refresh(true);
    expect(e.search('test').text).toContain('vitest run');
  });
});

describe('digest', () => {
  it('is compact, sectioned and includes recent commits', () => {
    const d = proj({ 'package.json': NODE, 'pnpm-lock.yaml': '' });
    gitInit(d, ['feat: first', 'fix(api): pagination']);
    const e = engineFor(d);
    e.save({ content: 'User uses Ubuntu 24.04 with zsh' });
    e.save({ content: 'Use named exports; no default exports', type: 'convention' });
    const t = e.context();
    expect(t).toContain('# global');
    expect(t).toMatch(/# project .+ \(/);
    expect(t).toContain('[env] User uses Ubuntu 24.04 with zsh');
    expect(t).toContain('[conv] Use named exports');
    expect(t).toContain('recent: fix(api): pagination');
    expect(t).not.toContain('{'); // keys are noise in the digest
    expect(Math.ceil(t.length / 4)).toBeLessThan(400);
  });

  it('stays within the token budget and reports what it left out', () => {
    const e = engineFor(proj());
    const topics = ['logging', 'routing', 'caching', 'billing', 'search', 'uploads', 'emails', 'cron', 'queues', 'metrics'];
    for (let i = 0; i < 60; i++) e.save({ content: `Convention ${topics[i % 10]}${Math.floor(i / 10)}: wrap ${topics[(i + 3) % 10]} handlers in the shared ${topics[(i + 7) % 10]}${i} helper`, type: 'convention' });
    const t = e.context(200);
    expect(Math.ceil(t.length / 4)).toBeLessThan(260);
    expect(t).toMatch(/\+\d+ more: memory_search/);
  });

  it('shows pinned memories even when the budget is tight', () => {
    const e = engineFor(proj());
    for (let i = 0; i < 40; i++) e.save({ content: `Filler convention ${i} with some extra words to cost tokens`, type: 'convention' });
    const p = e.save({ content: 'NEVER run migrations against prod from a laptop', type: 'gotcha', pin: true });
    expect(e.context(120)).toContain(`#${p.id}`);
  });

  it('has a helpful empty state', () => {
    const e = engineFor(proj());
    expect(e.context()).toMatch(/no memories yet/);
  });

  it('does not list auto memory ids but lists user memory ids', () => {
    const d = proj({ 'package.json': NODE, 'pnpm-lock.yaml': '' });
    const e = engineFor(d);
    const r = e.save({ content: 'We chose Drizzle for edge support', type: 'decision' });
    const t = e.context();
    expect(t).toContain(`edge support #${r.id}`);
    expect(t).toMatch(/\[cmd\] Test: `pnpm test` → `vitest run`\n/);
  });

  it('flags stale anchored memories in the digest', () => {
    const d = proj({ 'src/a.ts': 'v1' });
    const e = engineFor(d);
    e.save({ content: 'Core logic lives in src/a.ts', files: ['src/a.ts'], type: 'note' });
    write(d, 'src/a.ts', 'v2 changed');
    expect(e.context()).toContain('?stale');
  });
});
