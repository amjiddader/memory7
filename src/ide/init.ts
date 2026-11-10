import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { enableSync } from '../core/sync.js';
import { MEMORY_MD_HEADER, memoryMdBlock, projectBlock, projectRules } from './project-files.js';
import { MARK_END, MARK_START, RULES, markedBlock } from './rules.js';

export type IdeId = 'claude' | 'kiro' | 'vscode' | 'cursor' | 'opencode';
export const ALL_IDES: IdeId[] = ['claude', 'kiro', 'vscode', 'cursor', 'opencode'];

export interface InitOpts {
  ides: IdeId[] | 'auto';
  /** also write project-level files (Kiro hooks, Cursor rule, AGENTS.md block) into `cwd` */
  project: boolean;
  /** install hooks (Claude Code, Kiro). Default true */
  hooks: boolean;
  dryRun: boolean;
  cwd: string;
}

export interface Line {
  ide: IdeId | 'all';
  ok: boolean;
  msg: string;
  /** shown with "!" but not a failure: the user has a manual step to do */
  warn?: boolean;
}

const TOOLS = ['memory_context', 'memory_search', 'memory_save'];

// ---------------------------------------------------------------- environment helpers

export function which(bin: string): string | null {
  const exts = platform() === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const e of exts) {
      const p = join(dir, bin + e);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

const home = () => homedir();
const xdgConfig = () => process.env.XDG_CONFIG_HOME || join(home(), '.config');

function vscodeUserDir(): string {
  switch (platform()) {
    case 'darwin':
      return join(home(), 'Library', 'Application Support', 'Code', 'User');
    case 'win32':
      return join(process.env.APPDATA || join(home(), 'AppData', 'Roaming'), 'Code', 'User');
    default:
      return join(xdgConfig(), 'Code', 'User');
  }
}

/** True when memory7 is installed globally, so configs can point at it instead of paying npx startup on every launch. */
export function hasGlobalBin(): boolean {
  if (process.env.MEMORY7_FORCE_NPX) return false;
  return which('memory7') !== null;
}

/** [command, ...args] that starts the MCP server. */
export function serverCommand(): string[] {
  const base = hasGlobalBin() ? ['memory7', 'serve'] : ['npx', '-y', 'memory7'];
  return platform() === 'win32' ? ['cmd', '/c', ...base] : base;
}

/** Shell command prefix for hooks. */
function hookBin(): string {
  return hasGlobalBin() ? 'memory7' : 'npx -y memory7';
}

export function detectIdes(): IdeId[] {
  const found: IdeId[] = [];
  if (which('claude') || existsSync(join(home(), '.claude'))) found.push('claude');
  if (which('kiro') || which('kiro-cli') || existsSync(join(home(), '.kiro'))) found.push('kiro');
  if (which('code') || existsSync(vscodeUserDir())) found.push('vscode');
  if (which('cursor') || existsSync(join(home(), '.cursor'))) found.push('cursor');
  if (which('opencode') || existsSync(join(xdgConfig(), 'opencode'))) found.push('opencode');
  return found;
}

// ---------------------------------------------------------------- safe file edits

class Edits {
  readonly lines: Line[] = [];
  constructor(private dry: boolean) {}

  note(ide: Line['ide'], msg: string, ok = true, warn = false): void {
    this.lines.push({ ide, ok, msg, ...(warn ? { warn } : {}) });
  }

  private backup(path: string): void {
    const bak = path + '.memory7.bak';
    if (existsSync(path) && !existsSync(bak)) copyFileSync(path, bak);
  }

  writeText(path: string, text: string): void {
    if (this.dry) return;
    mkdirSync(dirname(path), { recursive: true });
    this.backup(path);
    const tmp = `${path}.memory7.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  }

  /** Edit a JSON file in place. `fn` returns true when it changed something. Refuses files with comments. */
  editJson(ide: Line['ide'], path: string, label: string, fn: (obj: Record<string, any>) => boolean, snippet: string): void {
    let obj: Record<string, any> = {};
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf8');
      if (raw.trim()) {
        try {
          obj = JSON.parse(raw);
        } catch {
          this.note(ide, `${path} is not plain JSON (comments or syntax error). Left untouched. Add this to it:\n${snippet}`, false);
          return;
        }
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
          this.note(ide, `${path} has unexpected content. Left untouched.`, false);
          return;
        }
      }
    }
    const existed = existsSync(path);
    if (!fn(obj)) {
      if (existed) this.note(ide, `${label}: already up to date`);
      return;
    }
    this.writeText(path, JSON.stringify(obj, null, 2) + '\n');
    this.note(ide, `${label}: ${this.dry ? 'would update' : 'updated'} ${path}`);
  }

  upsertBlock(ide: Line['ide'], path: string, label: string, block = markedBlock(), header = ''): void {
    const cur = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const re = new RegExp(`${esc(MARK_START)}[\\s\\S]*?${esc(MARK_END)}`);
    const next = re.test(cur)
      ? cur.replace(re, () => block)
      : cur
        ? (cur.endsWith('\n') ? cur : cur + '\n') + '\n' + block + '\n'
        : header + block + '\n';
    if (next === cur) {
      this.note(ide, `${label}: already up to date`);
      return;
    }
    this.writeText(path, next);
    this.note(ide, `${label}: ${this.dry ? 'would write' : 'wrote'} ${path}`);
  }

  removeBlock(ide: Line['ide'], path: string, label: string): void {
    if (!existsSync(path)) return;
    const cur = readFileSync(path, 'utf8');
    const re = new RegExp(`\\n?${esc(MARK_START)}[\\s\\S]*?${esc(MARK_END)}\\n?`);
    if (!re.test(cur)) return;
    const next = cur.replace(re, '\n').replace(/^\n+/, '');
    if (this.dry) {
      this.note(ide, `${label}: would remove block from ${path}`);
      return;
    }
    if (!next.trim()) rmSync(path);
    else this.writeText(path, next);
    this.note(ide, `${label}: removed block from ${path}`);
  }

  removeFile(ide: Line['ide'], path: string, label: string): void {
    if (!existsSync(path)) return;
    if (!this.dry) rmSync(path);
    this.note(ide, `${label}: ${this.dry ? 'would remove' : 'removed'} ${path}`);
  }
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function setKey(obj: Record<string, any>, path: string[], value: unknown): boolean {
  let cur = obj;
  for (const p of path.slice(0, -1)) {
    if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  const last = path[path.length - 1]!;
  if (same(cur[last], value)) return false;
  cur[last] = value;
  return true;
}

function delKey(obj: Record<string, any>, path: string[]): boolean {
  let cur: any = obj;
  for (const p of path.slice(0, -1)) {
    cur = cur?.[p];
    if (!cur || typeof cur !== 'object') return false;
  }
  const last = path[path.length - 1]!;
  if (!(last in cur)) return false;
  delete cur[last];
  return true;
}

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'], shell: platform() === 'win32' });
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
  } catch (e) {
    return { ok: false, out: (e as Error).message };
  }
}

const useCli = () => !process.env.MEMORY7_NO_CLI;

// ---------------------------------------------------------------- per IDE

function claude(e: Edits, o: InitOpts, undo: boolean): void {
  const cmd = serverCommand();
  const settings = join(home(), '.claude', 'settings.json');
  const entry = { type: 'stdio', command: cmd[0]!, args: cmd.slice(1), env: {} };

  if (undo) {
    if (useCli() && which('claude')) {
      if (!o.dryRun) run('claude', ['mcp', 'remove', '--scope', 'user', 'memory7']);
      e.note('claude', 'MCP server: removed via claude CLI');
    }
    e.editJson('claude', join(home(), '.claude.json'), 'MCP server', (j) => delKey(j, ['mcpServers', 'memory7']), '');
  } else if (useCli() && which('claude')) {
    if (o.dryRun) e.note('claude', 'MCP server: would run claude mcp add --scope user');
    else {
      run('claude', ['mcp', 'remove', '--scope', 'user', 'memory7']); // idempotent re-add
      const r = run('claude', ['mcp', 'add', '--scope', 'user', 'memory7', '--', ...cmd]);
      e.note('claude', r.ok ? 'MCP server: registered via claude CLI (user scope)' : `MCP server: claude CLI failed: ${r.out}`, r.ok);
    }
  } else {
    e.editJson(
      'claude',
      join(home(), '.claude.json'),
      'MCP server',
      (j) => setKey(j, ['mcpServers', 'memory7'], entry),
      JSON.stringify({ mcpServers: { memory7: entry } }, null, 2),
    );
  }

  const bin = hookBin();
  const isOurs = (c: unknown) => typeof c === 'string' && /memory7\b/.test(c) && /(context --hook|prompt-hook|edit-hook)/.test(c);
  // runs after every file edit, so it is only worth installing when startup is cheap (global binary, not npx)
  const editHook = hasGlobalBin();
  e.editJson(
    'claude',
    settings,
    undo ? 'permissions/hooks' : 'permissions' + (o.hooks ? ' + hooks' : ''),
    (j) => {
      let changed = false;
      // permissions: let the three safe tools run without a prompt on every call (delete still asks)
      const allow: string[] = Array.isArray(j.permissions?.allow) ? [...j.permissions.allow] : [];
      const mine = TOOLS.map((t) => `mcp__memory7__${t}`);
      const rest = allow.filter((a) => !a.startsWith('mcp__memory7__'));
      const nextAllow = undo ? rest : [...rest, ...mine];
      if (!same(allow, nextAllow)) {
        j.permissions = { ...(j.permissions ?? {}), allow: nextAllow };
        if (!nextAllow.length) delete j.permissions.allow;
        changed = true;
      }
      // hooks
      const hooks: Record<string, any[]> = j.hooks && typeof j.hooks === 'object' ? j.hooks : {};
      const strip = (event: string) => {
        const groups = Array.isArray(hooks[event]) ? hooks[event]! : [];
        return groups
          .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h: any) => !isOurs(h?.command)) }))
          .filter((g) => g.hooks.length);
      };
      for (const [event, command, matcher] of [
        ['SessionStart', `${bin} context --hook`, 'startup|resume|clear|compact'],
        ['UserPromptSubmit', `${bin} prompt-hook`, undefined],
        ['PostToolUse', `${bin} edit-hook`, 'Edit|Write|MultiEdit'],
      ] as const) {
        const before = hooks[event];
        const groups = strip(event);
        if (!undo && o.hooks && (event !== 'PostToolUse' || editHook)) groups.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] });
        if (groups.length) hooks[event] = groups;
        else delete hooks[event];
        if (!same(before, hooks[event])) changed = true;
      }
      if (Object.keys(hooks).length) j.hooks = hooks;
      else if ('hooks' in j) {
        delete j.hooks;
        changed = true;
      }
      return changed;
    },
    '',
  );

  const md = join(home(), '.claude', 'CLAUDE.md');
  if (undo) e.removeBlock('claude', md, 'rules');
  else e.upsertBlock('claude', md, 'rules');
  if (o.project) {
    const proj = join(o.cwd, 'CLAUDE.md');
    if (undo) e.removeBlock('claude', proj, 'project rules (CLAUDE.md)');
    else e.upsertBlock('claude', proj, 'project rules (CLAUDE.md)', projectBlock());
  }
}

function kiro(e: Edits, o: InitOpts, undo: boolean): void {
  const cmd = serverCommand();
  const entry = { command: cmd[0]!, args: cmd.slice(1), disabled: false, autoApprove: TOOLS };
  e.editJson(
    'kiro',
    join(home(), '.kiro', 'settings', 'mcp.json'),
    'MCP server',
    (j) => (undo ? delKey(j, ['mcpServers', 'memory7']) : setKey(j, ['mcpServers', 'memory7'], entry)),
    JSON.stringify({ mcpServers: { memory7: entry } }, null, 2),
  );

  const steer = join(home(), '.kiro', 'steering', 'memory7.md');
  if (undo) e.removeFile('kiro', steer, 'steering');
  else {
    const body = `# memory7\n\n${RULES}\n`;
    if (existsSync(steer) && readFileSync(steer, 'utf8') === body) e.note('kiro', 'steering: already up to date');
    else {
      e.writeText(steer, body);
      e.note('kiro', `steering: ${o.dryRun ? 'would write' : 'wrote'} ${steer}`);
    }
  }

  if (o.project) {
    const psteer = join(o.cwd, '.kiro', 'steering', 'memory7.md');
    if (undo) e.removeFile('kiro', psteer, 'project steering');
    else {
      e.writeText(psteer, `# memory7\n\n${projectRules()}\n`);
      e.note('kiro', `project steering: ${o.dryRun ? 'would write' : 'wrote'} ${psteer}`);
    }
    const hook = join(o.cwd, '.kiro', 'hooks', 'memory7.json');
    if (undo || !o.hooks) e.removeFile('kiro', hook, 'hooks');
    else {
      const bin = hookBin();
      const body =
        JSON.stringify(
          {
            version: 'v1',
            hooks: [
              { name: 'memory7 digest', trigger: 'SessionStart', action: { type: 'command', command: `${bin} context --hook` } },
              { name: 'memory7 remember', trigger: 'UserPromptSubmit', action: { type: 'command', command: `${bin} prompt-hook` } },
            ],
          },
          null,
          2,
        ) + '\n';
      e.writeText(hook, body);
      e.note('kiro', `hooks: ${o.dryRun ? 'would write' : 'wrote'} ${hook}`);
    }
  }
}

function vscode(e: Edits, o: InitOpts, undo: boolean): void {
  const cmd = serverCommand();
  const entry = { type: 'stdio', command: cmd[0]!, args: cmd.slice(1) };
  e.editJson(
    'vscode',
    join(vscodeUserDir(), 'mcp.json'),
    'MCP server',
    (j) => (undo ? delKey(j, ['servers', 'memory7']) : setKey(j, ['servers', 'memory7'], entry)),
    JSON.stringify({ servers: { memory7: entry } }, null, 2),
  );
  if (o.project) {
    const agents = join(o.cwd, 'AGENTS.md');
    if (undo) e.removeBlock('vscode', agents, 'rules');
    else e.upsertBlock('vscode', agents, 'project rules (AGENTS.md)', projectBlock());
  }
}

function cursor(e: Edits, o: InitOpts, undo: boolean): void {
  const cmd = serverCommand();
  const entry = { command: cmd[0]!, args: cmd.slice(1) };
  e.editJson(
    'cursor',
    join(home(), '.cursor', 'mcp.json'),
    'MCP server',
    (j) => (undo ? delKey(j, ['mcpServers', 'memory7']) : setKey(j, ['mcpServers', 'memory7'], entry)),
    JSON.stringify({ mcpServers: { memory7: entry } }, null, 2),
  );
  if (o.project) {
    const rule = join(o.cwd, '.cursor', 'rules', 'memory7.mdc');
    if (undo) e.removeFile('cursor', rule, 'rules');
    else {
      e.writeText(rule, `---\ndescription: memory7 persistent memory\nalwaysApply: true\n---\n\n${projectRules()}\n`);
      e.note('cursor', `rules: ${o.dryRun ? 'would write' : 'wrote'} ${rule}`);
    }
  }
}

function opencode(e: Edits, o: InitOpts, undo: boolean): void {
  const cmd = serverCommand();
  if (undo) {
    e.note('opencode', 'MCP server: remove "memory7" from your opencode config (or via /mcps in OpenCode)');
  } else if (useCli() && which('opencode')) {
    if (o.dryRun) e.note('opencode', 'MCP server: would run opencode mcp add memory7 --global');
    else {
      const r = run('opencode', ['mcp', 'add', 'memory7', '--global', '--', ...cmd]);
      e.note('opencode', r.ok ? 'MCP server: registered via opencode CLI' : `MCP server: opencode CLI failed (${r.out.split('\n')[0]}). Add it manually, see README`, r.ok);
    }
  } else {
    e.note(
      'opencode',
      `MCP server: opencode CLI not found. Add to your opencode config:\n${JSON.stringify({ mcp: { servers: { memory7: { type: 'local', command: cmd } } } }, null, 2)}\n(older OpenCode versions use { "mcp": { "memory7": { "type": "local", "command": [...] } } })`,
      true,
      true,
    );
  }
  const md = join(xdgConfig(), 'opencode', 'AGENTS.md');
  if (undo) e.removeBlock('opencode', md, 'rules');
  else e.upsertBlock('opencode', md, 'rules');
  if (o.project) {
    const agents = join(o.cwd, 'AGENTS.md');
    if (undo) e.removeBlock('opencode', agents, 'project rules (AGENTS.md)');
    else e.upsertBlock('opencode', agents, 'project rules (AGENTS.md)', projectBlock());
  }
}

const IDE_FN: Record<IdeId, (e: Edits, o: InitOpts, undo: boolean) => void> = { claude, kiro, vscode, cursor, opencode };

function resolveIdes(o: InitOpts): IdeId[] {
  return o.ides === 'auto' ? detectIdes() : o.ides;
}

/** Files shared through git: the .memory/ folder (data) and MEMORY.md (setup + update rules). */
function scaffoldProject(e: Edits, o: InitOpts, undo: boolean): void {
  const md = join(o.cwd, 'MEMORY.md');
  if (undo) {
    e.removeBlock('all', md, 'MEMORY.md');
    e.note('all', `kept ${join(o.cwd, '.memory')} (your shared memories). Delete the folder yourself if you want them gone.`);
    return;
  }
  e.upsertBlock('all', md, 'MEMORY.md', memoryMdBlock(), MEMORY_MD_HEADER);
  if (o.dryRun) {
    e.note('all', `.memory/: would create ${join(o.cwd, '.memory')}`);
    return;
  }
  const dir = join(o.cwd, '.memory');
  const had = existsSync(dir);
  const made = enableSync({ id: '', name: '', root: o.cwd, remote: null });
  e.note('all', had && !made.length ? '.memory/: already set up' : `.memory/: created ${made.join(', ') || dir}`);
}

export function init(o: InitOpts): Line[] {
  const e = new Edits(o.dryRun);
  const ides = resolveIdes(o);
  if (!ides.length) e.note('all', 'no supported IDE detected. Use --ide claude|kiro|vscode|cursor|opencode', false);
  for (const ide of ides) IDE_FN[ide](e, o, false);
  if (o.project) scaffoldProject(e, o, false);
  return e.lines;
}

export function uninstall(o: InitOpts): Line[] {
  const e = new Edits(o.dryRun);
  for (const ide of o.ides === 'auto' ? ALL_IDES : o.ides) IDE_FN[ide](e, { ...o, project: o.project }, true);
  if (o.project) scaffoldProject(e, o, true);
  return e.lines;
}

/** Which IDEs already point at memory7. Used by `doctor`. */
export function installedIn(): IdeId[] {
  const has = (p: string, key: string) => {
    try {
      return Boolean(JSON.parse(readFileSync(p, 'utf8'))?.[key]?.memory7);
    } catch {
      return false;
    }
  };
  const out: IdeId[] = [];
  if (has(join(home(), '.claude.json'), 'mcpServers')) out.push('claude');
  if (has(join(home(), '.kiro', 'settings', 'mcp.json'), 'mcpServers')) out.push('kiro');
  if (has(join(vscodeUserDir(), 'mcp.json'), 'servers')) out.push('vscode');
  if (has(join(home(), '.cursor', 'mcp.json'), 'mcpServers')) out.push('cursor');
  return out;
}
