import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Engine } from './core/engine.js';
import { openDb } from './core/db.js';
import { detectProject } from './core/project.js';
import { formatLine, projectNames, queryTerms } from './core/search.js';
import { MEM_TYPES } from './core/types.js';
import type { Scope } from './core/types.js';
import type { SaveInput } from './core/store.js';
import { RULES } from './ide/rules.js';
import { VERSION } from './version.js';

const typeEnum = z.enum(MEM_TYPES);
const scopeEnum = z.enum(['global', 'project']);

const itemShape = {
  content: z.string().describe('One short fact, max 500 chars'),
  key: z.string().optional().describe('Stable subject (os, db, test-cmd): same key replaces the old value'),
  type: typeEnum.optional(),
  scope: scopeEnum.optional().describe('global=about the user, project=this codebase; inferred if omitted'),
  files: z.array(z.string()).optional().describe('Project files this depends on; flagged ?stale when they change'),
};

// batch items stay minimal: every field here is repeated in the schema sent each session
const batchItem = z.object({ content: z.string(), key: z.string().optional(), type: typeEnum.optional(), scope: scopeEnum.optional() });

type Item = {
  content: string;
  key?: string;
  type?: SaveInput['type'];
  scope?: Scope;
  files?: string[];
};

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

/** Find the workspace: explicit env, then MCP roots, then the process cwd. */
async function resolveProject(server: McpServer) {
  const env = process.env.MEMORY7_PROJECT;
  if (env) {
    const p = detectProject(env);
    if (p) return p;
  }
  try {
    if (server.server.getClientCapabilities()?.roots) {
      const r = await server.server.listRoots(undefined, { timeout: 1500 });
      for (const root of r.roots) {
        if (!root.uri.startsWith('file://')) continue;
        const p = detectProject(fileURLToPath(root.uri));
        if (p) return p;
      }
    }
  } catch {
    /* client does not answer roots/list: fall through to cwd */
  }
  return detectProject(process.cwd());
}

export function createServer(engine: Engine, opts: { lazyProject?: boolean } = {}): McpServer {
  const server = new McpServer({ name: 'memory7', version: VERSION }, { instructions: RULES });

  let projectReady: Promise<void> | null = null;
  const ready = (): Promise<void> => {
    if (!opts.lazyProject) return Promise.resolve();
    projectReady ??= resolveProject(server).then((p) => engine.setProject(p));
    return projectReady;
  };

  const guard = (fn: () => string | Promise<string>) => async () => {
    try {
      await ready();
      return text(await fn());
    } catch (e) {
      return fail(`memory7 error: ${(e as Error).message}`);
    }
  };

  server.registerTool(
    'memory_context',
    {
      description: 'Digest of global + project memory. Call once at session start.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guard(() => engine.context()),
  );

  server.registerTool(
    'memory_search',
    {
      description: 'Search memories. Use before asking the user something they may have told you.',
      inputSchema: {
        query: z.string().min(1),
        scope: z.enum(['project', 'global', 'all', 'any-project']).optional().describe('default all (global + this project)'),
        type: typeEnum.optional(),
        limit: z.number().int().min(1).max(20).optional().describe('default 5'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      try {
        await ready();
        return text(engine.search(a.query, a.scope ?? 'all', a.type, a.limit ?? 5).text);
      } catch (e) {
        return fail(`memory7 error: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'memory_save',
    {
      description: 'Save or update a memory. Same key or id updates; duplicates are skipped.',
      inputSchema: {
        ...itemShape,
        content: z.string().optional().describe('One short fact, max 500 chars (omit when using items)'),
        id: z.number().int().optional().describe('Update this memory; with no content, re-confirms it against current code'),
        replace: z.boolean().optional().describe('Update a similar memory instead of adding'),
        items: z.array(batchItem).max(20).optional().describe('Batch of memories instead of content'),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a) => {
      try {
        await ready();
        const { items, content, ...single } = a as Omit<Item, 'content'> & { content?: string; items?: Item[]; id?: number; replace?: boolean };
        if (a.id !== undefined && !content && !items?.length) return text(engine.store.verify(engine.ctx(), a.id));
        const batch: Array<SaveInput> = [];
        if (content) batch.push({ content, ...single });
        for (const it of items ?? []) batch.push(it);
        if (!batch.length) return fail('memory7 error: provide content or items');
        const out = batch.map((b) => engine.save(b, 'ai').message);
        return text(out.join('\n'));
      } catch (e) {
        return fail(`memory7 error: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'memory_delete',
    {
      description: 'Delete by ids, key, or a query matching exactly one. Undoable.',
      inputSchema: {
        ids: z.array(z.number().int()).optional(),
        key: z.string().optional(),
        query: z.string().optional(),
        scope: scopeEnum.optional().describe('for key; default project then global'),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (a) => {
      try {
        await ready();
        const pid = engine.project?.id ?? null;
        let ids: number[] = a.ids ?? [];
        if (!ids.length && a.key) {
          const k = a.key.trim().toLowerCase();
          const m =
            a.scope === 'global'
              ? engine.store.getByKey('global', null, k)
              : (pid && engine.store.getByKey('project', pid, k)) || (a.scope ? undefined : engine.store.getByKey('global', null, k));
          if (!m) return text(`no memory with key ${a.key}`);
          ids = [m.id];
        }
        if (!ids.length && a.query) {
          if (!queryTerms(a.query).length) return fail('memory7 error: query has no searchable words, pass ids');
          const { hits } = engine.search(a.query, 'all', undefined, 5);
          const exact = hits.filter((h) => h.cov === 1);
          if (exact.length !== 1) {
            const names = projectNames(engine.db);
            const list = hits.map((h) => formatLine(h.memory, pid, names, h.state)).join('\n');
            return text(`${hits.length ? 'not unique, pass ids:\n' + list : 'no matches'}`);
          }
          ids = [exact[0]!.memory.id];
        }
        if (!ids.length) return fail('memory7 error: provide ids, key or query');
        const done = engine.store.delete(ids, 'ai');
        if (!done.length) return text('nothing deleted (unknown ids)');
        return text(`deleted ${done.map((i) => '#' + i).join(' ')} (undo: memory7 undo ${done[0]})`);
      } catch (e) {
        return fail(`memory7 error: ${(e as Error).message}`);
      }
    },
  );

  server.registerResource(
    'context',
    'memory7://context',
    { title: 'Memory digest', description: 'Global + current-project memory digest', mimeType: 'text/plain' },
    async (uri) => {
      await ready();
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: engine.context() }] };
    },
  );

  server.registerPrompt(
    'remember',
    {
      description: 'Save something to memory right now',
      argsSchema: { text: z.string().describe('What to remember') },
    },
    async ({ text: t }) => {
      await ready();
      const r = engine.save({ content: t }, 'user');
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `memory7: ${r.message}. Acknowledge in a few words.` } }] };
    },
  );

  return server;
}

export async function runServer(): Promise<void> {
  const engine = new Engine(openDb());
  const server = createServer(engine, { lazyProject: true });

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    try {
      engine.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);

  await server.connect(new StdioServerTransport());
  setImmediate(() => engine.maintenance());
}
