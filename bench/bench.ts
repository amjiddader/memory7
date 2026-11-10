/**
 * Seeds 10k memories over 20 projects and reports latency. Run: npm run bench
 * Targets (PLAN.md): cold start < 150 ms, search p95 < 5 ms, digest < 10 ms.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/core/db.js';
import { buildDigest } from '../src/core/digest.js';
import { Engine } from '../src/core/engine.js';
import { search } from '../src/core/search.js';
import { MEM_TYPES } from '../src/core/types.js';

const N = Number(process.env.BENCH_N ?? 10_000);
const P = 20;
const words = 'auth cache queue worker billing invoice user session token redis postgres migration schema index route handler middleware logger metrics deploy docker compose vitest jest eslint prettier tailwind react next express fastify prisma drizzle webhook retry timeout pagination upload email cron feature flag rollout'.split(' ');
const pick = (i: number, k: number) => words[(i * 7 + k * 13) % words.length]!;

const dir = mkdtempSync(join(tmpdir(), 'm7bench-'));
const db = openDb(join(dir, 'bench.db'));
const e = new Engine(db, null, {});

// seed directly (bypasses dedupe so the corpus really has N rows)
const now = Date.now();
db.exec('BEGIN');
const ins = db.prepare('INSERT INTO memories(scope, project_id, key, type, content, source, created_at, updated_at, hit_count) VALUES(?,?,?,?,?,?,?,?,?)');
const proj = db.prepare('INSERT INTO projects(id,name,root,created_at,last_seen) VALUES(?,?,?,?,?)');
for (let p = 0; p < P; p++) proj.run(`p${p}`, `project-${p}`, `/tmp/p${p}`, now, now);
const t0 = performance.now();
for (let i = 0; i < N; i++) {
  const glob = i % 25 === 0;
  ins.run(
    glob ? 'global' : 'project',
    glob ? null : `p${i % P}`,
    null,
    MEM_TYPES[i % MEM_TYPES.length]!,
    `${pick(i, 1)} ${pick(i, 2)} uses ${pick(i, 3)} with ${pick(i, 4)} for ${pick(i, 5)} handling in module ${i}`,
    'ai',
    now - (i % 365) * 86_400_000,
    now - (i % 365) * 86_400_000,
    i % 11,
  );
}
db.exec('COMMIT');
const seedMs = performance.now() - t0;
e.setProject({ id: 'p3', name: 'project-3', root: dir, remote: null });

function time(fn: () => void, n: number): { p50: number; p95: number; max: number } {
  const a: number[] = [];
  for (let i = 0; i < 20; i++) fn(); // warm
  for (let i = 0; i < n; i++) {
    const s = performance.now();
    fn();
    a.push(performance.now() - s);
  }
  a.sort((x, y) => x - y);
  return { p50: a[Math.floor(n * 0.5)]!, p95: a[Math.floor(n * 0.95)]!, max: a[n - 1]! };
}
const fmt = (r: { p50: number; p95: number; max: number }) => `p50 ${r.p50.toFixed(2)} ms   p95 ${r.p95.toFixed(2)} ms   max ${r.max.toFixed(2)} ms`;

const queries = ['auth', 'redis cache', 'which database', 'os', 'eslint prettier', 'postgress', 'deploy docker compose', 'webhook retry timeout', 'zzzunknown'];
let qi = 0;
const rows: Array<[string, { p50: number; p95: number; max: number }, number?]> = [];
rows.push(['search (project+global)', time(() => search(db, { query: queries[qi++ % queries.length]!, scope: 'all', projectId: 'p3', projectRoot: dir, limit: 5 }), 300), 5]);
rows.push(['search (any-project)', time(() => search(db, { query: queries[qi++ % queries.length]!, scope: 'any-project', projectId: 'p3', projectRoot: dir, limit: 5 }), 300), 5]);
rows.push(['digest (400 tokens)', time(() => buildDigest({ store: e.store, project: e.project, budget: 400 }), 100), 10]);
let k = 0;
rows.push(['save (new, with dedupe)', time(() => { e.store.save(e.ctx(), { content: `Brand new bench fact number ${k++} about ${pick(k, 1)} caching strategy`, scope: 'project' }); }, 200), 5]);
rows.push(['save (duplicate → skipped)', time(() => { e.store.save(e.ctx(), { content: 'Brand new bench fact number 3 about caching strategy', scope: 'project' }); }, 200), 5]);

// cold start: spawn the built server and time until it answers `initialize`
async function coldStart(): Promise<number> {
  const s = performance.now();
  const child = spawn(process.execPath, [join(import.meta.dirname, '../dist/index.js')], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, MEMORY7_HOME: join(dir, 'cold') } });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('error', reject);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'b', version: '0' } } }) + '\n');
  });
  const ms = performance.now() - s;
  child.kill();
  return ms;
}
const colds: number[] = [];
for (let i = 0; i < 7; i++) colds.push(await coldStart());
colds.sort((a, b) => a - b);

console.log(`\ncorpus: ${N} memories, ${P} projects (seeded in ${seedMs.toFixed(0)} ms)`);
let fail = 0;
for (const [name, r, target] of rows) {
  const ok = target === undefined || r.p95 < target;
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(28)} ${fmt(r)}${target ? `   (target p95 < ${target} ms)` : ''}`);
}
const coldMed = colds[3]!;
const coldOk = coldMed < 150;
if (!coldOk) fail++;
console.log(`${coldOk ? '✓' : '✗'} ${'server cold start → initialize'.padEnd(28)} median ${coldMed.toFixed(0)} ms   min ${colds[0]!.toFixed(0)} ms   max ${colds[6]!.toFixed(0)} ms   (target < 150 ms)`);

e.close();
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
