import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALL_IDES, init, uninstall } from '../src/ide/init.js';
import type { InitOpts } from '../src/ide/init.js';
import { cleanup, tmp } from './helpers.js';

const WIN = process.platform === 'win32';
let home: string;
let cwd: string;
const KEYS = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'MEMORY7_NO_CLI', 'MEMORY7_FORCE_NPX', 'APPDATA', 'PATH'];
const saved: Record<string, string | undefined> = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  home = tmp('home-');
  cwd = tmp('cwd-');
  process.env.HOME = home;
  process.env.USERPROFILE = home; // os.homedir() reads this on Windows
  process.env.XDG_CONFIG_HOME = join(home, '.config');
  process.env.MEMORY7_NO_CLI = '1'; // never shell out to real claude/opencode in tests
  process.env.MEMORY7_FORCE_NPX = '1';
  process.env.APPDATA = join(home, 'AppData', 'Roaming');
  // hard guard: these tests write config files, so they must never resolve to a real home directory
  if (homedir() !== home) throw new Error(`refusing to run: homedir() is ${homedir()}, expected sandbox ${home}`);
});
afterEach(() => {
  // restore key by key: replacing process.env with a plain object would detach it from the native environment
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  cleanup(home, cwd);
});

const opts = (o: Partial<InitOpts> = {}): InitOpts => ({ ides: ALL_IDES, project: false, hooks: true, dryRun: false, cwd, ...o });
const json = (...p: string[]) => JSON.parse(readFileSync(join(home, ...p), 'utf8'));
// how each platform launches the server: Windows needs cmd /c for npx and for npm shims
const NPX = WIN ? { command: 'cmd', args: ['/c', 'npx', '-y', 'memory7'] } : { command: 'npx', args: ['-y', 'memory7'] };
const GLOBAL_BIN = WIN ? { command: 'cmd', args: ['/c', 'memory7', 'serve'] } : { command: 'memory7', args: ['serve'] };
// where VS Code keeps the user-level mcp.json
const VSCODE = (): string[] => (platform() === 'darwin' ? ['Library', 'Application Support', 'Code', 'User'] : WIN ? ['AppData', 'Roaming', 'Code', 'User'] : ['.config', 'Code', 'User']);

describe('init', () => {
  it('dry run changes nothing', () => {
    const lines = init(opts({ dryRun: true }));
    expect(lines.length).toBeGreaterThan(3);
    expect(existsSync(join(home, '.kiro'))).toBe(false);
    expect(existsSync(join(home, '.claude.json'))).toBe(false);
  });

  it('configures Claude Code: MCP server, permissions, hooks, rules', () => {
    init(opts({ ides: ['claude'] }));
    expect(json('.claude.json').mcpServers.memory7).toMatchObject({ type: 'stdio', ...NPX });
    const s = json('.claude', 'settings.json');
    expect(s.permissions.allow).toEqual(['mcp__memory7__memory_context', 'mcp__memory7__memory_search', 'mcp__memory7__memory_save']);
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe('npx -y memory7 context --hook');
    expect(s.hooks.UserPromptSubmit[0].hooks[0].command).toBe('npx -y memory7 prompt-hook');
    expect(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8')).toContain('<!-- memory7:start -->');
  });

  it('configures Kiro with autoApprove and steering; project hooks only with --project', () => {
    init(opts({ ides: ['kiro'] }));
    expect(json('.kiro', 'settings', 'mcp.json').mcpServers.memory7).toMatchObject({ ...NPX, autoApprove: ['memory_context', 'memory_search', 'memory_save'] });
    expect(readFileSync(join(home, '.kiro', 'steering', 'memory7.md'), 'utf8')).toContain('memory_save');
    expect(existsSync(join(cwd, '.kiro', 'hooks', 'memory7.json'))).toBe(false);
    init(opts({ ides: ['kiro'], project: true }));
    const h = JSON.parse(readFileSync(join(cwd, '.kiro', 'hooks', 'memory7.json'), 'utf8'));
    expect(h.version).toBe('v1');
    expect(h.hooks.map((x: { trigger: string }) => x.trigger)).toEqual(['SessionStart', 'UserPromptSubmit']);
  });

  it('configures VS Code (servers key), Cursor (mcpServers) and project rule files', () => {
    init(opts({ ides: ['vscode', 'cursor', 'opencode'], project: true }));
    expect(json(...VSCODE(), 'mcp.json').servers.memory7).toMatchObject({ type: 'stdio', ...NPX });
    expect(json('.cursor', 'mcp.json').mcpServers.memory7).toMatchObject(NPX);
    expect(readFileSync(join(cwd, '.cursor', 'rules', 'memory7.mdc'), 'utf8')).toContain('alwaysApply: true');
    expect(readFileSync(join(cwd, 'AGENTS.md'), 'utf8')).toContain('memory_context');
    expect(readFileSync(join(home, '.config', 'opencode', 'AGENTS.md'), 'utf8')).toContain('memory7:start');
  });

  it('--project scaffolds .memory/, MEMORY.md and per-IDE project rules; uninstall keeps the shared data', () => {
    init(opts({ project: true }));
    for (const f of ['.memory/memory.jsonl', '.memory/.gitattributes', '.memory/.gitignore', 'MEMORY.md', 'CLAUDE.md', 'AGENTS.md', '.kiro/steering/memory7.md', '.kiro/hooks/memory7.json', '.cursor/rules/memory7.mdc']) {
      expect(existsSync(join(cwd, f)), f).toBe(true);
    }
    expect(readFileSync(join(cwd, '.memory', '.gitattributes'), 'utf8')).toBe('memory.jsonl text eol=lf merge=union\n');
    const md = readFileSync(join(cwd, 'MEMORY.md'), 'utf8');
    expect(md).toMatch(/^<!-- memory7:start -->\n# Project memory \(memory7\)/);
    expect(md).toContain('npm install -g memory7');
    expect(md).toContain('PowerShell');
    expect(md).toContain('memory_save id=N');
    for (const f of ['CLAUDE.md', 'AGENTS.md', '.kiro/steering/memory7.md', '.cursor/rules/memory7.mdc']) {
      expect(readFileSync(join(cwd, f), 'utf8'), f).toContain('Setup and update triggers: MEMORY.md');
    }

    // text the user wrote around the block survives a re-run
    writeFileSync(join(cwd, 'MEMORY.md'), readFileSync(join(cwd, 'MEMORY.md'), 'utf8') + '\n## Our own notes\nkeep me\n');
    writeFileSync(join(cwd, '.memory', 'memory.jsonl'), '{"ident":"x","updated":1,"type":"note","content":"precious"}\n');
    init(opts({ project: true }));
    expect(readFileSync(join(cwd, 'MEMORY.md'), 'utf8')).toContain('keep me');
    expect(readFileSync(join(cwd, 'MEMORY.md'), 'utf8').match(/memory7:start/g)).toHaveLength(1);

    uninstall(opts({ project: true }));
    expect(existsSync(join(cwd, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(false);
    expect(readFileSync(join(cwd, 'MEMORY.md'), 'utf8')).toContain('keep me');
    expect(readFileSync(join(cwd, 'MEMORY.md'), 'utf8')).not.toContain('memory7:start');
    expect(readFileSync(join(cwd, '.memory', 'memory.jsonl'), 'utf8')).toContain('precious'); // data is never deleted
  });

  it('installs the edit trigger only when memory7 is a global binary (npx would add ~1s to every edit)', () => {
    init(opts({ ides: ['claude'] }));
    expect(json('.claude', 'settings.json').hooks.PostToolUse).toBeUndefined();
    const bin = tmp('bin-');
    writeFileSync(join(bin, WIN ? 'memory7.cmd' : 'memory7'), '#!/bin/sh\n', { mode: 0o755 });
    delete process.env.MEMORY7_FORCE_NPX;
    process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
    init(opts({ ides: ['claude'] }));
    const post = json('.claude', 'settings.json').hooks.PostToolUse;
    expect(post[0].matcher).toBe('Edit|Write|MultiEdit');
    expect(post[0].hooks[0].command).toBe('memory7 edit-hook');
    uninstall(opts({ ides: ['claude'] }));
    expect(existsSync(join(home, '.claude', 'settings.json')) ? json('.claude', 'settings.json').hooks : undefined).toBeUndefined();
    cleanup(bin);
  });

  it('is idempotent and updates the rules block in place (no duplicates)', () => {
    init(opts({ project: true }));
    const snap = (p: string) => readFileSync(p, 'utf8');
    const before = [join(home, '.claude.json'), join(home, '.claude', 'settings.json'), join(cwd, 'AGENTS.md'), join(home, '.claude', 'CLAUDE.md')].map(snap);
    const second = init(opts({ project: true }));
    const after = [join(home, '.claude.json'), join(home, '.claude', 'settings.json'), join(cwd, 'AGENTS.md'), join(home, '.claude', 'CLAUDE.md')].map(snap);
    expect(after).toEqual(before);
    expect(second.filter((l) => /already up to date/.test(l.msg)).length).toBeGreaterThan(3);
    expect(snap(join(cwd, 'AGENTS.md')).match(/memory7:start/g)).toHaveLength(1);
  });

  it('preserves existing settings, other MCP servers, other hooks, and user text around the block', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        model: 'opus',
        permissions: { allow: ['Bash(npm test)'], deny: ['Read(.env)'] },
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }], Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }] },
      }),
    );
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ numStartups: 7, mcpServers: { other: { command: 'x' } } }));
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# My rules\nBe nice.\n');
    init(opts({ ides: ['claude'] }));
    const s = json('.claude', 'settings.json');
    expect(s.model).toBe('opus');
    expect(s.permissions.deny).toEqual(['Read(.env)']);
    expect(s.permissions.allow[0]).toBe('Bash(npm test)');
    expect(s.hooks.Stop).toHaveLength(1);
    expect(s.hooks.SessionStart).toHaveLength(2); // user's own hook kept
    expect(json('.claude.json').numStartups).toBe(7);
    expect(json('.claude.json').mcpServers.other).toEqual({ command: 'x' });
    expect(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8')).toMatch(/^# My rules\nBe nice\.\n\n<!-- memory7:start -->/);
    expect(existsSync(join(home, '.claude', 'settings.json.memory7.bak'))).toBe(true);
  });

  it('refuses to rewrite JSON files containing comments, and says what to add', () => {
    const p = join(home, ...VSCODE(), 'mcp.json');
    mkdirSync(join(p, '..'), { recursive: true });
    const orig = '{\n  // my servers\n  "servers": {}\n}\n';
    writeFileSync(p, orig);
    const lines = init(opts({ ides: ['vscode'] }));
    expect(readFileSync(p, 'utf8')).toBe(orig);
    expect(lines.find((l) => !l.ok)!.msg).toContain('"memory7"');
  });

  it('a missing opencode CLI is a notice, not a failure', () => {
    const lines = init(opts({ ides: ['opencode'] }));
    expect(lines.some((l) => l.warn)).toBe(true);
    expect(lines.filter((l) => !l.ok)).toHaveLength(0);
  });

  it('--no-hooks skips hooks but keeps permissions', () => {
    init(opts({ ides: ['claude'], hooks: false }));
    const s = json('.claude', 'settings.json');
    expect(s.hooks).toBeUndefined();
    expect(s.permissions.allow).toHaveLength(3);
  });

  it('uses the global binary when memory7 is on PATH', () => {
    const bin = tmp('bin-');
    writeFileSync(join(bin, WIN ? 'memory7.cmd' : 'memory7'), '#!/bin/sh\n', { mode: 0o755 });
    delete process.env.MEMORY7_FORCE_NPX;
    process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
    init(opts({ ides: ['claude', 'kiro'] }));
    expect(json('.claude.json').mcpServers.memory7).toMatchObject(GLOBAL_BIN);
    expect(json('.claude', 'settings.json').hooks.SessionStart[0].hooks[0].command).toBe('memory7 context --hook');
    cleanup(bin);
  });
});

describe('uninstall', () => {
  it('removes everything it added and leaves the user\'s own config intact', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }] } }));
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# Mine\n');
    init(opts({ project: true }));
    uninstall(opts({ project: true }));

    const s = json('.claude', 'settings.json');
    expect(s).toEqual({ model: 'opus', permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }] } });
    expect(json('.claude.json')).toEqual({ mcpServers: { other: { command: 'x' } } });
    expect(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8').trim()).toBe('# Mine');
    expect(existsSync(join(home, '.kiro', 'steering', 'memory7.md'))).toBe(false);
    expect(json('.kiro', 'settings', 'mcp.json').mcpServers).toEqual({});
    expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(false); // file only held our block
    expect(existsSync(join(cwd, '.cursor', 'rules', 'memory7.mdc'))).toBe(false);
  });

  it('is a no-op when nothing is installed', () => {
    const lines = uninstall(opts());
    expect(lines.filter((l) => !l.ok)).toHaveLength(0);
    expect(existsSync(join(home, '.claude.json'))).toBe(false);
  });
});
