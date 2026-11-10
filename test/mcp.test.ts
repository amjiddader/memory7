import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, makeProject, tmp } from './helpers.js';

const ROOT = join(import.meta.dirname, '..');
const dirs: string[] = [];
let home: string;
let project: string;
let neutral: string;

beforeAll(() => {
  home = tmp('m7home-');
  neutral = tmp('m7neutral-'); // not a git repo, so cwd alone gives no project
  project = makeProject({
    'package.json': JSON.stringify({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '2' } }),
  });
  dirs.push(home, neutral, project);
});
afterAll(() => cleanup(...dirs));

async function connect(opts: { roots?: string[]; cwd?: string; args?: string[] } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'dist/index.js'), ...(opts.args ?? [])],
    cwd: opts.cwd ?? neutral,
    env: { ...process.env, HOME: home, USERPROFILE: home, MEMORY7_HOME: join(home, '.memory7') } as Record<string, string>,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (d) => (stderr += d));
  const client = new Client({ name: 'test', version: '0' }, { capabilities: opts.roots ? { roots: {} } : {} });
  if (opts.roots) {
    const roots = opts.roots;
    client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: roots.map((r) => ({ uri: pathToFileURL(r).href, name: 'ws' })) }));
  }
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: (r.content as Array<{ text: string }>)[0]!.text, isError: Boolean(r.isError) };
  };
  return { client, call, stderr: () => stderr };
}

describe('MCP server over stdio', () => {
  it('handshake: instructions, 4 tools, small schemas', async () => {
    const { client, stderr } = await connect();
    expect(client.getServerVersion()?.name).toBe('memory7');
    expect(client.getInstructions()).toContain('memory_context');
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(['memory_context', 'memory_delete', 'memory_save', 'memory_search']);
    const schemaTokens = Math.ceil(JSON.stringify(tools).length / 4);
    console.log(`tool schema + descriptions ≈ ${schemaTokens} tokens`);
    expect(schemaTokens).toBeLessThan(1400);
    expect(stderr()).toBe(''); // no warnings leaking to stderr
    await client.close();
  });

  it('save → search → context → delete round trip; memory persists across restarts', async () => {
    let s = await connect({ roots: [project] });
    expect((await s.call('memory_save', { content: 'User uses Ubuntu 24.04 with zsh' })).text).toMatch(/saved #\d+ \[env\|g\] \{os\}/);
    expect((await s.call('memory_save', { content: 'We chose Drizzle for edge support', type: 'decision' })).text).toMatch(/\[dec\|p\]/);
    expect((await s.call('memory_save', { content: 'I switched to Fedora' })).text).toMatch(/^updated #\d+ \{os\}/);
    const batch = await s.call('memory_save', {
      items: [{ content: 'Named exports only', type: 'convention' }, { content: 'Named exports only' }],
    });
    expect(batch.text.split('\n')[1]).toMatch(/^skipped: dup/);
    expect((await s.call('memory_search', { query: 'operating system' })).text).toContain('Fedora');
    const ctx = (await s.call('memory_context')).text;
    expect(ctx).toContain('[env] I switched to Fedora');
    expect(ctx).toContain('Test: `npm test` → `vitest run`'); // passive capture from package.json
    await s.client.close();

    s = await connect({ roots: [project] }); // new process, same database
    expect((await s.call('memory_search', { query: 'drizzle' })).text).toContain('Drizzle');
    const del = await s.call('memory_delete', { query: 'drizzle' });
    expect(del.text).toMatch(/^deleted #\d+ \(undo: memory7 undo \d+\)/);
    expect((await s.call('memory_search', { query: 'drizzle' })).text).toBe('no matches');
    expect((await s.call('memory_delete', { key: 'os' })).text).toMatch(/^deleted/);
    await s.client.close();
  });

  it('project memory is scoped by the workspace root the client reports', async () => {
    const other = makeProject();
    dirs.push(other);
    const a = await connect({ roots: [project] });
    await a.call('memory_save', { content: 'Project-only fact about zebras', scope: 'project' });
    expect((await a.call('memory_search', { query: 'zebras' })).text).toContain('zebras');
    await a.client.close();
    const b = await connect({ roots: [other] });
    expect((await b.call('memory_search', { query: 'zebras' })).text).toBe('no matches');
    expect((await b.call('memory_search', { query: 'zebras', scope: 'any-project' })).text).toContain('zebras');
    await b.client.close();
  });

  it('`memory7 serve` (used by global installs) is the same server', async () => {
    const s = await connect({ args: ['serve'], roots: [project] });
    expect((await s.client.listTools()).tools).toHaveLength(4);
    expect((await s.call('memory_context')).text).toContain('# project');
    expect(s.stderr()).toBe('');
    await s.client.close();
  });

  it('writes saves to .memory/memory.jsonl while the server is running (shared project memory)', async () => {
    const shared = makeProject();
    dirs.push(shared);
    mkdirSync(join(shared, '.memory'));
    const s = await connect({ roots: [shared] });
    await s.call('memory_save', { content: 'Deploys go through the release branch only', type: 'convention' });
    await s.call('memory_save', { content: 'I use Ubuntu', scope: 'global' });
    await new Promise((r) => setTimeout(r, 100));
    const file = readFileSync(join(shared, '.memory', 'memory.jsonl'), 'utf8');
    expect(file).toContain('release branch');
    expect(file).not.toContain('Ubuntu');
    // verify via id with no content
    const id = /#(\d+)/.exec((await s.call('memory_search', { query: 'release branch' })).text)![1]!;
    expect((await s.call('memory_save', { id: Number(id) })).text).toMatch(new RegExp(`^verified #${id}`));
    await s.client.close();
  });

  it('falls back to cwd when the client has no roots', async () => {
    const s = await connect({ cwd: project });
    expect((await s.call('memory_context')).text).toContain('# project');
    await s.client.close();
  });

  it('returns tool errors instead of crashing on bad input', async () => {
    const s = await connect();
    expect((await s.call('memory_save', {})).isError).toBe(true);
    expect((await s.call('memory_delete', {})).isError).toBe(true);
    expect((await s.call('memory_delete', { query: 'the' })).isError).toBe(true);
    expect((await s.call('memory_save', { content: 'api_key=sk_live_abcdefghijklmnop1234' })).text).toMatch(/^rejected/);
    expect((await s.call('memory_search', { query: 'x', limit: 999 })).isError).toBe(true); // schema violation
    expect((await s.call('memory_context')).isError).toBe(false); // still alive
    await s.client.close();
  });

  it('exposes the digest resource and the remember prompt', async () => {
    const s = await connect({ roots: [project] });
    const res = await s.client.readResource({ uri: 'memory7://context' });
    expect((res.contents[0] as { text: string }).text.length).toBeGreaterThan(0);
    const p = await s.client.getPrompt({ name: 'remember', arguments: { text: 'I use Neovim' } });
    expect(JSON.stringify(p.messages)).toContain('saved #');
    expect((await s.call('memory_search', { query: 'editor' })).text).toContain('Neovim');
    await s.client.close();
  });

  it('shuts down cleanly when stdin closes', async () => {
    const s = await connect();
    await s.call('memory_context');
    await s.client.close();
    expect(s.stderr()).toBe('');
  });
});
