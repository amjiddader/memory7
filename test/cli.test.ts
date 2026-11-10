import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, makeProject, tmp } from './helpers.js';

const ROOT = join(import.meta.dirname, '..');
const BIN = join(ROOT, 'dist/index.js');
let home: string;
let project: string;
let neutral: string;

beforeAll(() => {
  home = tmp('clihome-');
  neutral = tmp('cliwork-');
  project = makeProject({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) });
});
afterAll(() => cleanup(home, neutral, project));

const env = () => ({ ...process.env, HOME: home, USERPROFILE: home, MEMORY7_HOME: join(home, '.memory7'), MEMORY7_NO_CLI: '1' });
function run(args: string[], opts: { input?: string; cwd?: string } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: env(), cwd: opts.cwd ?? project, input: opts.input ?? '', timeout: 15000 });
  return { out: r.stdout, err: r.stderr, code: r.status };
}

describe('hooks (as Claude Code / Kiro invoke them)', () => {
  it('prompt-hook saves "remember ..." prompts and stays silent otherwise', () => {
    const hit = run(['prompt-hook'], { input: JSON.stringify({ prompt: 'Remember that I use Ubuntu 24.04', cwd: project }), cwd: neutral });
    expect(hit.code).toBe(0);
    expect(hit.out).toMatch(/^memory7: saved #\d+ \[env\|g\] \{os\}/);
    for (const prompt of ['fix the login bug', 'can you remember how this works?', 'please do not forget the tests', '']) {
      const miss = run(['prompt-hook'], { input: JSON.stringify({ prompt, cwd: project }) });
      expect(miss.out).toBe('');
      expect(miss.code).toBe(0);
    }
  });

  it('context --hook prints the digest for the cwd given on stdin, regardless of process cwd', () => {
    const r = run(['context', '--hook'], { input: JSON.stringify({ cwd: project, session_id: 's' }), cwd: neutral });
    expect(r.code).toBe(0);
    expect(r.out).toContain('[env] Remember that I use Ubuntu 24.04'.replace('Remember that ', '')); // saved above (without the "remember" prefix)
    expect(r.out).toContain('# project');
    expect(r.out).toContain('Test: `npm test`');
  });

  it('hooks never fail the host: garbage stdin, no project, unwritable data dir', () => {
    expect(run(['context', '--hook'], { input: 'not json' , cwd: neutral }).code).toBe(0);
    expect(run(['prompt-hook'], { input: '{{{' }).code).toBe(0);
    // a data dir that cannot be created on any OS: a path beneath a regular file
    const blocker = join(neutral, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const bad = spawnSync(process.execPath, [BIN, 'context', '--hook'], { encoding: 'utf8', env: { ...env(), MEMORY7_HOME: join(blocker, 'sub') }, input: '{}', cwd: project });
    expect(bad.status).toBe(0);
  });

  it('hook startup is fast (no MCP SDK loaded)', () => {
    run(['context', '--hook'], { input: '{}' }); // warm
    const t = performance.now();
    for (let i = 0; i < 5; i++) run(['context', '--hook'], { input: '{}' });
    const per = (performance.now() - t) / 5;
    console.log(`context --hook ≈ ${per.toFixed(0)} ms per call (process spawn included)`);
    expect(per).toBeLessThan(process.env.CI ? 1500 : 400); // CI runners (especially Windows) have slow process spawn
  });
});

describe('cli commands', () => {
  it('add / search / ls / rm / undo / pin / export / import / gc / projects', () => {
    expect(run(['add', 'Prefer pnpm for installs', '--key', 'pm']).out).toMatch(/saved #\d+/);
    expect(run(['search', 'installs']).out).toContain('Prefer pnpm');
    expect(run(['ls']).out).toContain('{pm}');
    const id = /#(\d+)/.exec(run(['ls', '--type', 'preference']).out)?.[1] ?? /#(\d+)/.exec(run(['ls']).out)![1]!;
    expect(run(['pin', id]).out).toMatch(/pinned/);
    expect(run(['rm', 'pm']).out).toMatch(/^deleted/);
    expect(run(['search', 'installs']).out).toBe('no matches\n');
    expect(run(['undo', id]).out).toMatch(/restored|removed/);
    const dump = run(['export']).out;
    expect(dump.split('\n').filter(Boolean).every((l) => JSON.parse(l).content)).toBe(true);
    expect(run(['gc']).out).toMatch(/^gc: merged/);
    expect(run(['projects']).out).toContain('(');
    expect(run(['add', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789ab']).code).toBe(1);
    expect(run(['rm', 'nonexistent-key']).code).toBe(1);
  });

  it('init --dry-run and doctor work; unknown command and ide exit non-zero', () => {
    expect(run(['init', '--ide', 'kiro', '--dry-run']).out).toContain('Dry run: nothing was changed');
    const d = run(['doctor']);
    expect(d.out).toContain('✓ SQLite with FTS5');
    expect(d.out).toContain('✓ database');
    expect(run(['init', '--ide', 'emacs']).code).toBe(1);
    expect(run(['bogus']).code).toBe(1);
    expect(run(['--version']).out.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(run(['--help']).out).toContain('memory7 init');
  });

  it('no args on a TTY-less stdin starts the server; with args it never does', () => {
    const r = spawnSync(process.execPath, [BIN], { encoding: 'utf8', env: env(), cwd: project, input: '', timeout: 10000 });
    expect(r.status).toBe(0); // stdin closed -> clean shutdown
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });
});

/** Two people, two home directories, one git repo: the clone-and-go workflow. */
describe('shared memory through git (real binary, real git)', () => {
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: 'pipe' });
  const as = (homeDir: string, cwd: string, args: string[], input = '') =>
    spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd, input, timeout: 15000, env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, MEMORY7_HOME: join(homeDir, '.memory7'), MEMORY7_NO_CLI: '1', MEMORY7_FORCE_NPX: '1' } });

  it('alice shares, bob clones and finds it with no setup step, bob replies, alice pulls', () => {
    const base = tmp('team-');
    const aliceHome = join(base, 'alice-home');
    const bobHome = join(base, 'bob-home');
    const alice = join(base, 'alice-repo');
    const bob = join(base, 'bob-repo');
    mkdirSync(alice, { recursive: true });
    git(alice, 'init', '-q', '-b', 'main');
    git(alice, 'config', 'user.email', 'a@a.a');
    git(alice, 'config', 'user.name', 'alice');
    writeFileSync(join(alice, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    mkdirSync(join(alice, 'src'));
    writeFileSync(join(alice, 'src', 'billing.ts'), 'export const rate = 1;\n');

    // alice enables sharing and works with her AI (CLI stands in for MCP calls)
    const init = as(aliceHome, alice, ['init', '--project', '--ide', 'claude,kiro,cursor,vscode']);
    expect(init.status).toBe(0);
    for (const f of ['MEMORY.md', 'CLAUDE.md', 'AGENTS.md', '.memory/memory.jsonl', '.memory/.gitattributes', '.kiro/steering/memory7.md', '.cursor/rules/memory7.mdc']) {
      expect(existsSync(join(alice, f)), f).toBe(true);
    }
    expect(readFileSync(join(alice, 'MEMORY.md'), 'utf8')).toMatch(/npm install -g memory7[\s\S]*memory7 init[\s\S]*When to update memory/);
    expect(as(aliceHome, alice, ['add', 'Never run db:reset against staging, it wipes shared QA data', '--type', 'gotcha']).status).toBe(0);
    expect(as(aliceHome, alice, ['add', 'Billing rate math lives in src/billing.ts']).status).toBe(0);
    as(aliceHome, alice, ['add', 'I like my answers concise', '--global']);
    expect(readFileSync(join(alice, '.memory', 'memory.jsonl'), 'utf8')).toContain('db:reset');
    expect(readFileSync(join(alice, '.memory', 'memory.jsonl'), 'utf8')).not.toContain('concise'); // personal stays personal
    git(alice, 'add', '-A');
    git(alice, 'commit', '-qm', 'project with shared memory');

    // bob clones; he has never seen this project
    git(base, 'clone', '-q', alice, bob);
    git(bob, 'config', 'user.email', 'b@b.b');
    git(bob, 'config', 'user.name', 'bob');
    const found = as(bobHome, bob, ['search', 'staging']);
    expect(found.stdout).toContain('Never run db:reset against staging');
    const digest = as(bobHome, bob, ['context']).stdout;
    expect(digest).toContain('db:reset');
    expect(digest).not.toContain('concise');

    // bob adds a memory and commits; alice pulls and sees it without running anything
    expect(as(bobHome, bob, ['add', 'Use named exports; default exports break our codegen', '--type', 'convention']).status).toBe(0);
    git(bob, 'add', '-A');
    git(bob, 'commit', '-qm', 'bob memory');
    git(alice, 'pull', '-q', bob, 'main');
    expect(as(aliceHome, alice, ['search', 'exports']).stdout).toContain('codegen');

    // alice changes the code a memory points at: stale for her, and for bob after he pulls
    writeFileSync(join(alice, 'src', 'billing.ts'), 'export const rate = 2; // rewritten\n');
    expect(as(aliceHome, alice, ['check']).stdout).toContain('?stale');
    expect(as(aliceHome, alice, ['check', '--strict']).status).toBe(1);
    expect(as(aliceHome, alice, ['context']).stdout).toMatch(/stale: #\d+/);
    git(alice, 'commit', '-qam', 'rewrite billing');
    git(bob, 'pull', '-q', alice, 'main');
    expect(as(bobHome, bob, ['check']).stdout).toContain('billing');

    // alice deletes a memory; the deletion reaches bob
    const id = /#(\d+) .*db:reset/.exec(as(aliceHome, alice, ['ls']).stdout)![1]!;
    expect(as(aliceHome, alice, ['rm', id]).status).toBe(0);
    git(alice, 'commit', '-qam', 'drop gotcha');
    git(bob, 'pull', '-q', alice, 'main');
    expect(as(bobHome, bob, ['search', 'staging']).stdout).toBe('no matches\n');
    cleanup(base);
  });

  it('edit-hook names the memories that depend on the file you just edited, and is silent otherwise', () => {
    const base = tmp('edit-');
    const home2 = join(base, 'h');
    const repo = join(base, 'r');
    mkdirSync(join(repo, 'src'), { recursive: true });
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'src', 'auth.ts'), 'v1\n');
    writeFileSync(join(repo, 'src', 'other.ts'), 'v1\n');
    as(home2, repo, ['add', 'Auth is session based, see src/auth.ts']);
    const hook = (file: string) => as(home2, repo, ['edit-hook'], JSON.stringify({ cwd: repo, tool_name: 'Edit', tool_input: { file_path: file } }));

    const hit = hook(join(repo, 'src', 'auth.ts'));
    expect(hit.status).toBe(0);
    const out = JSON.parse(hit.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput.additionalContext).toMatch(/src\/auth\.ts.*#\d+ "Auth is session based/);
    expect(hook(join(repo, 'src', 'other.ts')).stdout).toBe('');
    expect(hook('/etc/hosts').stdout).toBe('');
    expect(as(home2, repo, ['edit-hook'], 'garbage').status).toBe(0);
    cleanup(base);
  });
});
