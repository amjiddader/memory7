import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { capture } from '../capture/index.js';
import { loadConfig, memoryHome, openDb } from '../core/db.js';
import { Engine } from '../core/engine.js';
import { gc } from '../core/gc.js';
import { formatLine, projectNames } from '../core/search.js';
import { exportAll, importFile } from '../core/portable.js';
import { syncFile } from '../core/sync.js';
import { MEM_TYPES } from '../core/types.js';
import type { MemType, Scope, SearchScope } from '../core/types.js';
import { ALL_IDES, detectIdes, hasGlobalBin, init, installedIn, uninstall, which } from '../ide/init.js';
import type { IdeId, Line } from '../ide/init.js';
import { RULES } from '../ide/rules.js';
import { VERSION } from '../version.js';

const HELP = `memory7 ${VERSION}: fast local memory for AI coding tools

Usage:
  memory7                         start the MCP server (when launched by an IDE over stdio)
  memory7 init [--ide a,b|all] [--project] [--no-hooks] [--dry-run]
                                  --project also creates .memory/ + MEMORY.md in this repo (shared via git)
  memory7 uninstall [--ide a,b|all] [--project] [--dry-run]
  memory7 doctor                  check Node, SQLite, database and IDE setup
  memory7 rules                   print the rule text for pasting into any IDE's instructions

Memory:
  memory7 context [--budget N]    session digest
  memory7 search <query> [--scope project|global|all|any-project] [--type T] [--limit N]
  memory7 add <text> [--global] [--key K] [--type T] [--tags a,b]
  memory7 ls [--scope S] [--type T]
  memory7 rm <id|key>             soft delete        memory7 undo <id>   revert last change
  memory7 pin <id>                memory7 unpin <id>
  memory7 capture [--force]       re-detect stack/commands from project files
  memory7 sync                    pull/push .memory/memory.jsonl now (normally automatic)
  memory7 private <id> | unprivate <id>   keep a memory out of the repo / share it again
  memory7 verify <id>             re-confirm a memory against the current code
  memory7 check [--strict]        list memories whose files changed or vanished
  memory7 export                  personal backup as JSONL on stdout
  memory7 import <file>           restore a backup
  memory7 gc                      merge duplicates, archive stale notes
  memory7 projects

IDEs: ${ALL_IDES.join(', ')}
Types: ${MEM_TYPES.join(', ')}
Data: ${memoryHome()}   (override with MEMORY7_HOME)`;

const out = (s: string) => process.stdout.write(s.endsWith('\n') ? s : s + '\n');
const err = (s: string) => process.stderr.write(s.endsWith('\n') ? s : s + '\n');

async function readStdinJson(timeoutMs = 400): Promise<Record<string, any>> {
  if (process.stdin.isTTY) return {};
  return new Promise((res) => {
    let buf = '';
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(t);
      process.stdin.pause();
      try {
        const v = JSON.parse(buf);
        res(v && typeof v === 'object' ? v : {});
      } catch {
        res({});
      }
    };
    const t = setTimeout(done, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

function parseIdes(v: string | undefined): IdeId[] | 'auto' {
  if (!v) return 'auto';
  if (v === 'all') return ALL_IDES;
  const list = v.split(',').map((s) => s.trim().toLowerCase());
  const bad = list.filter((s) => !(ALL_IDES as string[]).includes(s));
  if (bad.length) throw new Error(`unknown --ide ${bad.join(',')}. Use: ${ALL_IDES.join(', ')}, all`);
  return list as IdeId[];
}

function asType(v: string | undefined): MemType | undefined {
  if (!v) return undefined;
  if (!(MEM_TYPES as readonly string[]).includes(v)) throw new Error(`unknown type "${v}". Use: ${MEM_TYPES.join(', ')}`);
  return v as MemType;
}

function printLines(lines: Line[]): number {
  let bad = 0;
  for (const l of lines) {
    if (!l.ok) bad++;
    out(`${l.ok && !l.warn ? '✓' : '!'} ${l.ide === 'all' ? '' : l.ide + ': '}${l.msg}`);
  }
  return bad;
}

function open(): Engine {
  return Engine.open(process.cwd());
}

export async function runCli(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const { values: v, positionals: pos } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: false,
    options: {
      ide: { type: 'string' },
      project: { type: 'boolean' },
      hooks: { type: 'boolean' },
      'no-hooks': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      hook: { type: 'boolean' },
      budget: { type: 'string' },
      scope: { type: 'string' },
      type: { type: 'string' },
      limit: { type: 'string' },
      global: { type: 'boolean' },
      key: { type: 'string' },
      tags: { type: 'string' },
      force: { type: 'boolean' },
      strict: { type: 'boolean' },
      file: { type: 'string' },
    },
  });
  const str = (x: unknown) => (typeof x === 'string' ? x : undefined);

  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      out(HELP);
      return 0;
    case '--version':
    case '-v':
    case 'version':
      out(VERSION);
      return 0;

    case 'serve': {
      const { runServer } = await import('../server.js');
      await runServer();
      return -1; // keep running
    }

    case 'init':
    case 'uninstall': {
      const o = {
        ides: parseIdes(str(v.ide)),
        project: Boolean(v.project),
        hooks: !v['no-hooks'],
        dryRun: Boolean(v['dry-run']),
        cwd: process.cwd(),
      };
      const lines = cmd === 'init' ? init(o) : uninstall(o);
      const ides = o.ides === 'auto' ? detectIdes() : o.ides;
      const bad = printLines(lines);
      if (cmd === 'init' && !bad) {
        out(o.dryRun ? '\nDry run: nothing was changed.' : '\nDone. Restart your IDE(s). Check with: memory7 doctor');
        if (!o.project) out('Tip: run `memory7 init --project` inside a repo to share its memory with teammates through git (.memory/ + MEMORY.md).');
        else if (!o.dryRun) {
          out('\nCommit these so teammates get the same memory and setup instructions: .memory/  MEMORY.md  AGENTS.md / CLAUDE.md / .kiro / .cursor (whichever were written).');
          out('Review .memory/memory.jsonl before committing: memories are plain text in your git history. Keep one local with: memory7 private <id>');
          if (ides.includes('kiro')) out('Note: .kiro/hooks/memory7.json makes Kiro run memory7 for everyone who opens the repo; teammates need memory7 installed (see MEMORY.md).');
        }
      }
      return bad ? 1 : 0;
    }

    case 'context': {
      // hooks must never break the host session: swallow everything and exit 0
      try {
        const stdin = v.hook ? await readStdinJson() : {};
        const dir = typeof stdin.cwd === 'string' ? stdin.cwd : process.cwd();
        const e = Engine.open(dir);
        const budget = str(v.budget) ? Number(str(v.budget)) : undefined;
        out(e.context(budget && budget > 0 ? budget : undefined));
        e.close();
        return 0;
      } catch (e) {
        if (!v.hook) {
          err(`memory7: ${(e as Error).message}`);
          return 1;
        }
        return 0;
      }
    }

    case 'prompt-hook': {
      try {
        const stdin = await readStdinJson();
        const prompt = typeof stdin.prompt === 'string' ? stdin.prompt : '';
        const m = /^\s*(?:please\s+)?(?:remember|memorize)(?:\s+that)?\s*[:,]?\s+([\s\S]{3,600})$/i.exec(prompt);
        if (!m) return 0;
        const e = Engine.open(typeof stdin.cwd === 'string' ? stdin.cwd : process.cwd());
        const r = e.save({ content: m[1]!.trim() }, 'user');
        out(`memory7: ${r.message}`);
        e.close();
      } catch {
        /* never block the prompt */
      }
      return 0;
    }

    case 'search': {
      const q = pos.join(' ');
      if (!q) throw new Error('usage: memory7 search <query>');
      const e = open();
      const { text } = e.search(q, (str(v.scope) as SearchScope) ?? 'all', asType(str(v.type)), Number(str(v.limit) ?? 5));
      out(text);
      e.close();
      return 0;
    }

    case 'add': {
      const text = pos.join(' ');
      if (!text) throw new Error('usage: memory7 add <text> [--global] [--key K] [--type T]');
      const e = open();
      const r = e.save(
        { content: text, key: str(v.key), type: asType(str(v.type)), scope: v.global ? 'global' : (str(v.scope) as Scope | undefined), tags: str(v.tags) },
        'user',
      );
      out(r.message);
      e.close();
      return r.status === 'rejected' ? 1 : 0;
    }

    case 'ls': {
      const e = open();
      const scope = (str(v.scope) as SearchScope) ?? 'all';
      const rows = e.store.list({ scope, projectId: e.project?.id ?? null, type: asType(str(v.type)), limit: 500 });
      const names = projectNames(e.db);
      out(rows.length ? rows.map((m) => formatLine(m, e.project?.id ?? null, names)).join('\n') : 'no memories');
      e.close();
      return 0;
    }

    case 'rm': {
      const target = pos[0];
      if (!target) throw new Error('usage: memory7 rm <id|key>');
      const e = open();
      let id = /^\d+$/.test(target) ? Number(target) : undefined;
      if (id === undefined) {
        const k = target.toLowerCase();
        const m = (e.project && e.store.getByKey('project', e.project.id, k)) || e.store.getByKey('global', null, k);
        id = m?.id;
      }
      const done = id !== undefined ? e.store.delete([id], 'user') : [];
      out(done.length ? `deleted #${done[0]} (undo: memory7 undo ${done[0]})` : `no memory ${target}`);
      e.close();
      return done.length ? 0 : 1;
    }

    case 'undo': {
      const id = Number(pos[0]);
      if (!Number.isInteger(id)) throw new Error('usage: memory7 undo <id>');
      const e = open();
      out(e.store.undo(id));
      e.close();
      return 0;
    }

    case 'pin':
    case 'unpin': {
      const id = Number(pos[0]);
      if (!Number.isInteger(id)) throw new Error(`usage: memory7 ${cmd} <id>`);
      const e = open();
      const ok = e.store.pin(id, cmd === 'pin');
      out(ok ? `${cmd === 'pin' ? 'pinned' : 'unpinned'} #${id}` : `no memory #${id}`);
      e.close();
      return ok ? 0 : 1;
    }

    case 'capture': {
      const e = open();
      if (!e.project) throw new Error('no project here (run inside a repository)');
      const r = capture(e.store, e.project, Boolean(v.force));
      out(r.ran ? `captured: ${r.created} new, ${r.updated} updated, ${r.removed} removed` : 'up to date (use --force to re-run)');
      e.close();
      return 0;
    }

    case 'export': {
      const e = open();
      process.stdout.write(exportAll(e.store, e.project));
      e.close();
      return 0;
    }

    case 'import': {
      const file = pos[0];
      if (!file || !existsSync(file)) throw new Error('usage: memory7 import <file.jsonl>');
      const e = open();
      const r = importFile(e.store, e.project, resolve(file));
      out(`imported: ${r.created} new, ${r.updated} updated, ${r.skipped} skipped, ${r.rejected} rejected`);
      e.close();
      return 0;
    }

    case 'sync': {
      const e = open();
      if (!e.project) throw new Error('no project here (run inside a repository)');
      if (!e.syncOn) {
        out('sharing is off for this project: run `memory7 init --project` to create .memory/ (or sync is disabled in config / MEMORY7_NO_SYNC).');
        e.close();
        return 1;
      }
      const r = e.sync();
      if (!r) {
        err(`sync failed: ${e.lastSyncError ?? 'unknown error'}`);
        e.close();
        return 1;
      }
      out(`synced ${join('.memory', 'memory.jsonl')}: ${r.created} new, ${r.updated} updated, ${r.deleted} removed from teammates; ${r.wrote ? 'file updated' : 'file already current'}${r.rejected ? `; ${r.rejected} unreadable line(s)` : ''}`);
      if (r.skippedWrite) out(`! left the file untouched: ${r.skippedWrite}. Fix it (merge-conflict markers?) and run again.`);
      e.close();
      return r.skippedWrite ? 1 : 0;
    }

    case 'private':
    case 'unprivate': {
      const id = Number(pos[0]);
      if (!Number.isInteger(id)) throw new Error(`usage: memory7 ${cmd} <id>`);
      const e = open();
      out(e.store.setLocalOnly(id, cmd === 'private'));
      e.close();
      return 0;
    }

    case 'verify': {
      const id = Number(pos[0]);
      if (!Number.isInteger(id)) throw new Error('usage: memory7 verify <id>');
      const e = open();
      out(e.store.verify(e.ctx(), id));
      e.close();
      return 0;
    }

    case 'check': {
      const e = open();
      if (!e.project) throw new Error('no project here (run inside a repository)');
      const bad = e.checkStale();
      if (!bad.length) {
        out('all file-anchored memories match the code');
      } else {
        const names = projectNames(e.db);
        for (const b of bad) out(formatLine(b.memory, e.project.id, names, b.state));
        out(`\n${bad.length} memor${bad.length === 1 ? 'y' : 'ies'} out of date. Fix with memory_save id=N (via your AI), \`memory7 verify N\`, or \`memory7 rm N\`.`);
      }
      e.close();
      return bad.length && v.strict ? 1 : 0;
    }

    case 'edit-hook': {
      // Claude Code PostToolUse: after a file edit, tell the AI which memories depend on that file. Silent otherwise.
      try {
        const stdin = await readStdinJson();
        const input = (stdin.tool_input ?? {}) as Record<string, unknown>;
        const target = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : '';
        if (!target) return 0;
        const cwd = typeof stdin.cwd === 'string' ? stdin.cwd : process.cwd();
        const e = Engine.open(cwd);
        if (e.project) {
          const abs = resolve(cwd, target);
          let real = abs;
          try {
            real = join(realpathSync.native(dirname(abs)), basename(abs));
          } catch {
            /* new file in a new directory: use the path as given */
          }
          const rel = relative(e.project.root, real).split(sep).join('/');
          if (rel && !rel.startsWith('..')) {
            const hits = e.anchoredTo(rel);
            if (hits.length) {
              const list = hits.slice(0, 3).map((m) => `#${m.id} "${m.content.slice(0, 80)}"`).join('; ');
              const msg = `memory7: you edited ${rel}, which these memories depend on: ${list}. If they no longer match the code, fix with memory_save(id=N, content=...) or memory_delete; if still true, memory_save(id=N) with no content.`;
              out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg } }));
            }
          }
        }
        e.close();
      } catch {
        /* never block the edit */
      }
      return 0;
    }

    case 'gc': {
      const e = open();
      const r = gc(e.store);
      out(`gc: merged ${r.merged} duplicates, archived ${r.archived} stale notes, removed ${r.doneTodos} done todos`);
      e.close();
      return 0;
    }

    case 'projects': {
      const e = open();
      const rows = e.db
        .prepare(
          `SELECT p.name, p.root, COUNT(m.id) n FROM projects p
           LEFT JOIN memories m ON m.project_id = p.id AND m.deleted_at IS NULL GROUP BY p.id ORDER BY p.last_seen DESC`,
        )
        .all() as Array<{ name: string; root: string; n: number }>;
      out(rows.length ? rows.map((r) => `${r.name}  (${r.n})  ${r.root}`).join('\n') : 'no projects yet');
      e.close();
      return 0;
    }

    case 'doctor':
      return doctor();

    case 'rules':
      out(RULES);
      return 0;

    default:
      err(`unknown command "${cmd}"\n`);
      out(HELP);
      return 1;
  }
}

function doctor(): number {
  let bad = 0;
  const ok = (m: string) => out(`✓ ${m}`);
  const fail = (m: string) => {
    bad++;
    out(`✗ ${m}`);
  };
  const [maj = 0, min = 0] = process.versions.node.split('.').map(Number);
  if (maj > 22 || (maj === 22 && min >= 13)) ok(`Node ${process.versions.node}`);
  else fail(`Node ${process.versions.node}: memory7 needs >= 22.13 (built-in node:sqlite)`);

  try {
    const db = openDb(':memory:');
    db.exec("CREATE VIRTUAL TABLE t USING fts5(a, tokenize='porter unicode61'); CREATE VIRTUAL TABLE t2 USING fts5(a, tokenize='trigram');");
    db.close();
    ok('SQLite with FTS5 + trigram');
  } catch (e) {
    fail(`SQLite/FTS5 unavailable: ${(e as Error).message}`);
  }

  try {
    const e = Engine.open(process.cwd());
    const qc = e.db.prepare('PRAGMA quick_check').get() as Record<string, string>;
    const res = Object.values(qc)[0];
    const n = (e.db.prepare('SELECT COUNT(*) c FROM memories WHERE deleted_at IS NULL').get() as { c: number }).c;
    if (res === 'ok') ok(`database ${memoryHome()}/memory7.db (${n} memories)`);
    else fail(`database integrity check: ${res}`);
    out(e.project ? `  project: ${e.project.name} (${e.project.id})` : '  project: none here (home dir or filesystem root)');
    if (e.project) {
      if (e.syncOn) {
        const f = syncFile(e.project);
        const n = existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0;
        ok(`shared memory: .memory/memory.jsonl (${n} lines)${e.lastSyncError ? ` ! ${e.lastSyncError}` : ''}`);
      } else {
        out('  shared memory: off (enable with: memory7 init --project)');
      }
    }
    e.close();
  } catch (e) {
    fail(`database: ${(e as Error).message}`);
  }

  const cfg = loadConfig();
  if (Object.keys(cfg).length) out(`  config: ${JSON.stringify(cfg)}`);

  const bin = which('memory7');
  if (bin && !hasGlobalBin()) out('  note: MEMORY7_FORCE_NPX is set');
  out(bin ? `✓ memory7 on PATH (${bin}): IDE hooks start fast` : '  memory7 not on PATH: IDEs will use npx (slower start). Faster: npm i -g memory7');

  const inst = installedIn();
  const found = detectIdes();
  for (const id of ALL_IDES) {
    if (inst.includes(id)) ok(`${id}: configured`);
    else if (id === 'opencode') out(`  ${id}: ${found.includes(id) ? 'detected, check with: opencode mcp list' : 'not detected'}`);
    else out(`  ${id}: ${found.includes(id) ? 'detected but not configured (run: memory7 init)' : 'not detected'}`);
  }
  return bad ? 1 : 0;
}
