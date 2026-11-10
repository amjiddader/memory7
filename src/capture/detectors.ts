import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MemType } from '../core/types.js';

export interface Fact {
  key: string;
  type: MemType;
  content: string;
}

export interface Detected {
  /** merged into one `stack` memory */
  stack: string[];
  facts: Fact[];
}

/** Files whose (mtime,size) decide whether detection needs to run again. */
export const WATCHED = [
  'package.json', '.nvmrc', '.node-version', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'bun.lockb', 'bun.lock',
  'pnpm-workspace.yaml', 'turbo.json', 'nx.json', 'lerna.json', 'tsconfig.json', 'pyproject.toml', 'requirements.txt',
  'uv.lock', 'poetry.lock', 'Pipfile.lock', '.python-version', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle',
  'build.gradle.kts', 'Gemfile', 'composer.json', 'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml',
  'compose.yaml', '.env.example', '.env.sample', 'Makefile', 'justfile', '.gitlab-ci.yml', 'Jenkinsfile',
  '.circleci/config.yml', '.github/workflows',
];

function read(root: string, f: string, max = 200_000): string | null {
  try {
    const p = join(root, f);
    if (statSync(p).size > max) return null;
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}
const has = (root: string, f: string) => existsSync(join(root, f));
const one = (s: string, max = 70) => (s.length > max ? s.slice(0, max - 1) + '…' : s);

const NODE_LABELS: Array<[string, string]> = [
  ['next', 'Next.js'], ['nuxt', 'Nuxt'], ['@remix-run/react', 'Remix'], ['astro', 'Astro'], ['@sveltejs/kit', 'SvelteKit'],
  ['svelte', 'Svelte'], ['@angular/core', 'Angular'], ['vue', 'Vue'], ['react-native', 'React Native'], ['react', 'React'],
  ['solid-js', 'Solid'], ['electron', 'Electron'], ['@nestjs/core', 'NestJS'], ['fastify', 'Fastify'], ['hono', 'Hono'],
  ['express', 'Express'], ['koa', 'Koa'], ['@trpc/server', 'tRPC'], ['graphql', 'GraphQL'],
  ['prisma', 'Prisma'], ['@prisma/client', 'Prisma'], ['drizzle-orm', 'Drizzle'], ['typeorm', 'TypeORM'], ['sequelize', 'Sequelize'],
  ['mongoose', 'Mongoose'], ['knex', 'Knex'], ['pg', 'Postgres'], ['mysql2', 'MySQL'], ['better-sqlite3', 'SQLite'], ['redis', 'Redis'],
  ['ioredis', 'Redis'], ['@supabase/supabase-js', 'Supabase'], ['firebase', 'Firebase'],
  ['vitest', 'Vitest'], ['jest', 'Jest'], ['mocha', 'Mocha'], ['@playwright/test', 'Playwright'], ['cypress', 'Cypress'],
  ['tailwindcss', 'Tailwind'], ['@mui/material', 'MUI'], ['zod', 'Zod'], ['zustand', 'Zustand'], ['@reduxjs/toolkit', 'Redux Toolkit'],
  ['@tanstack/react-query', 'TanStack Query'], ['vite', 'Vite'], ['webpack', 'Webpack'], ['tsup', 'tsup'], ['turbo', 'Turborepo'],
  ['eslint', 'ESLint'], ['@biomejs/biome', 'Biome'], ['prettier', 'Prettier'],
];

function nodeRun(pm: string, script: string): string {
  if (pm === 'npm') return script === 'test' || script === 'start' ? `npm ${script}` : `npm run ${script}`;
  return `${pm} ${script}`;
}

function detectNode(root: string, out: Detected): void {
  const raw = read(root, 'package.json');
  if (raw === null) return;
  let pkg: Record<string, any>;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return;
  }
  const deps: Record<string, string> = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

  let pm = 'npm';
  const declared = typeof pkg.packageManager === 'string' ? /^(\w+)@/.exec(pkg.packageManager)?.[1] : undefined;
  if (declared) pm = declared;
  else if (has(root, 'pnpm-lock.yaml')) pm = 'pnpm';
  else if (has(root, 'yarn.lock')) pm = 'yarn';
  else if (has(root, 'bun.lockb') || has(root, 'bun.lock')) pm = 'bun';
  out.facts.push({ key: 'pkg-manager', type: 'stack', content: `Package manager: ${pm}` });

  const isTs = 'typescript' in deps || has(root, 'tsconfig.json');
  out.stack.push(isTs ? 'TypeScript' : 'JavaScript');
  const seen = new Set<string>();
  for (const [dep, label] of NODE_LABELS) {
    if (dep in deps && !seen.has(label)) {
      seen.add(label);
      out.stack.push(label);
    }
  }

  const scripts: Record<string, string> = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const cmd = (key: string, label: string, names: string[]) => {
    const name = names.find((n) => typeof scripts[n] === 'string');
    if (!name) return;
    out.facts.push({ key, type: 'command', content: `${label}: \`${nodeRun(pm, name)}\` → \`${one(String(scripts[name]))}\`` });
  };
  cmd('test-cmd', 'Test', ['test']);
  cmd('dev-cmd', 'Dev server', ['dev', 'start']);
  cmd('build-cmd', 'Build', ['build']);
  cmd('lint-cmd', 'Lint', ['lint']);

  const nv =
    read(root, '.nvmrc')?.trim() ?? read(root, '.node-version')?.trim() ?? (typeof pkg.engines?.node === 'string' ? pkg.engines.node : undefined);
  if (nv) out.facts.push({ key: 'node-version', type: 'stack', content: `Node ${one(nv.replace(/^v/, ''), 30)}` });

  const mono = [
    pkg.workspaces ? 'workspaces' : '',
    has(root, 'pnpm-workspace.yaml') ? 'pnpm workspaces' : '',
    has(root, 'turbo.json') ? 'turbo' : '',
    has(root, 'nx.json') ? 'nx' : '',
    has(root, 'lerna.json') ? 'lerna' : '',
  ].filter(Boolean);
  if (mono.length) out.facts.push({ key: 'monorepo', type: 'stack', content: `Monorepo (${[...new Set(mono)].join(', ')})` });
}

const PY_LABELS: Array<[string, string]> = [
  ['django', 'Django'], ['fastapi', 'FastAPI'], ['flask', 'Flask'], ['sqlalchemy', 'SQLAlchemy'], ['pydantic', 'Pydantic'],
  ['celery', 'Celery'], ['pandas', 'pandas'], ['numpy', 'NumPy'], ['torch', 'PyTorch'], ['tensorflow', 'TensorFlow'],
  ['pytest', 'pytest'], ['ruff', 'Ruff'], ['black', 'Black'], ['mypy', 'mypy'],
];

function detectPython(root: string, out: Detected): void {
  const py = read(root, 'pyproject.toml');
  const req = read(root, 'requirements.txt');
  if (py === null && req === null) return;
  const text = ((py ?? '') + '\n' + (req ?? '')).toLowerCase();
  out.stack.push('Python');
  for (const [dep, label] of PY_LABELS) {
    if (new RegExp(`(^|[\\s"'\\[,])${dep}([\\s"'=<>~!\\[,;]|$)`, 'm').test(text)) out.stack.push(label);
  }
  const mgr = has(root, 'uv.lock') ? 'uv' : has(root, 'poetry.lock') || /\[tool\.poetry\]/.test(py ?? '') ? 'poetry' : has(root, 'Pipfile.lock') ? 'pipenv' : 'pip';
  out.facts.push({ key: 'pkg-manager', type: 'stack', content: `Package manager: ${mgr}` });
  const ver = /requires-python\s*=\s*["']([^"']+)["']/.exec(py ?? '')?.[1] ?? read(root, '.python-version')?.trim();
  if (ver) out.facts.push({ key: 'python-version', type: 'stack', content: `Python ${one(ver, 30)}` });
  const run = mgr === 'uv' ? 'uv run ' : mgr === 'poetry' ? 'poetry run ' : '';
  if (/pytest/.test(text)) out.facts.push({ key: 'test-cmd', type: 'command', content: `Test: \`${run}pytest\`` });
}

function detectOthers(root: string, out: Detected): void {
  const cargo = read(root, 'Cargo.toml');
  if (cargo !== null) {
    out.stack.push('Rust');
    const ed = /edition\s*=\s*"(\d+)"/.exec(cargo)?.[1];
    if (ed) out.facts.push({ key: 'rust-edition', type: 'stack', content: `Rust edition ${ed}` });
    out.facts.push({ key: 'test-cmd', type: 'command', content: 'Test: `cargo test`' });
    out.facts.push({ key: 'build-cmd', type: 'command', content: 'Build: `cargo build`' });
  }
  const gomod = read(root, 'go.mod');
  if (gomod !== null) {
    out.stack.push('Go');
    const v = /^go\s+(\S+)/m.exec(gomod)?.[1];
    if (v) out.facts.push({ key: 'go-version', type: 'stack', content: `Go ${v}` });
    out.facts.push({ key: 'test-cmd', type: 'command', content: 'Test: `go test ./...`' });
    out.facts.push({ key: 'build-cmd', type: 'command', content: 'Build: `go build ./...`' });
  }
  if (has(root, 'pom.xml')) {
    out.stack.push('Java', 'Maven');
    out.facts.push({ key: 'test-cmd', type: 'command', content: 'Test: `mvn test`' });
  } else if (has(root, 'build.gradle') || has(root, 'build.gradle.kts')) {
    out.stack.push(has(root, 'build.gradle.kts') ? 'Kotlin/Java' : 'Java', 'Gradle');
    out.facts.push({ key: 'test-cmd', type: 'command', content: 'Test: `./gradlew test`' });
  }
  const gem = read(root, 'Gemfile');
  if (gem !== null) {
    out.stack.push('Ruby');
    if (/['"]rails['"]/.test(gem)) out.stack.push('Rails');
    if (/['"]rspec/.test(gem)) out.facts.push({ key: 'test-cmd', type: 'command', content: 'Test: `bundle exec rspec`' });
  }
  const composer = read(root, 'composer.json');
  if (composer !== null) {
    out.stack.push('PHP');
    if (/laravel\/framework/.test(composer)) out.stack.push('Laravel');
    else if (/symfony\//.test(composer)) out.stack.push('Symfony');
  }
}

function detectInfra(root: string, out: Detected): void {
  const parts: string[] = [];
  const docker = read(root, 'Dockerfile');
  if (docker !== null) {
    const base = /^FROM\s+(?:--\S+\s+)?(\S+)/im.exec(docker)?.[1];
    parts.push(base ? `Dockerfile (${one(base, 40)})` : 'Dockerfile');
  }
  for (const f of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const c = read(root, f);
    if (c === null) continue;
    const block = /^services:\s*\n((?:[ \t]+.*\n?|\s*\n)*)/m.exec(c)?.[1] ?? '';
    const names = [...block.matchAll(/^ {2}([A-Za-z0-9_.-]+):\s*$/gm)].map((m) => m[1]!).slice(0, 8);
    parts.push(names.length ? `compose services: ${names.join(', ')}` : 'compose');
    break;
  }
  if (parts.length) out.facts.push({ key: 'container', type: 'stack', content: `Containers: ${parts.join('; ')}` });

  const ci: string[] = [];
  try {
    const wf = readdirSync(join(root, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f)).slice(0, 6);
    if (wf.length) ci.push(`GitHub Actions (${wf.join(', ')})`);
  } catch {
    /* none */
  }
  if (has(root, '.gitlab-ci.yml')) ci.push('GitLab CI');
  if (has(root, 'Jenkinsfile')) ci.push('Jenkins');
  if (has(root, '.circleci/config.yml')) ci.push('CircleCI');
  if (ci.length) out.facts.push({ key: 'ci', type: 'stack', content: `CI: ${ci.join(', ')}` });

  for (const f of ['.env.example', '.env.sample']) {
    const env = read(root, f);
    if (env === null) continue;
    // names only; never values
    const names = [...env.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]!);
    if (names.length) out.facts.push({ key: 'env-vars', type: 'stack', content: `Env vars (${f}): ${[...new Set(names)].slice(0, 15).join(', ')}${names.length > 15 ? ', …' : ''}` });
    break;
  }

  const task = read(root, 'Makefile') ?? read(root, 'justfile');
  if (task !== null) {
    const targets = [...task.matchAll(/^([A-Za-z][A-Za-z0-9_-]*):(?!=)/gm)].map((m) => m[1]!).filter((t) => t !== 'PHONY');
    if (targets.length) out.facts.push({ key: 'task-runner', type: 'command', content: `${has(root, 'Makefile') ? 'make' : 'just'} targets: ${[...new Set(targets)].slice(0, 10).join(', ')}` });
  }
}

export function detect(root: string): Detected {
  const out: Detected = { stack: [], facts: [] };
  detectNode(root, out);
  detectPython(root, out);
  detectOthers(root, out);
  detectInfra(root, out);
  // later detectors win on duplicate keys (e.g. a Rust+Node repo): keep the first, drop repeats
  const seen = new Set<string>();
  out.facts = out.facts.filter((f) => (seen.has(f.key) ? false : (seen.add(f.key), true)));
  const stack = [...new Set(out.stack)].slice(0, 12);
  out.stack = stack;
  if (stack.length) out.facts.unshift({ key: 'stack', type: 'stack', content: `Stack: ${stack.join(', ')}` });
  return out;
}
