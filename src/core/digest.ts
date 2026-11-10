import { recentCommits } from '../capture/git.js';
import { checkAnchors, parseAnchors } from './anchors.js';
import type { AnchorState } from './anchors.js';
import { baseScore } from './search.js';
import { readBranch } from './project.js';
import { estimateTokens } from './tokens.js';
import { shortType } from './store.js';
import type { Store } from './store.js';
import type { MemType, Memory, ProjectInfo } from './types.js';

const PROJECT_ORDER: MemType[] = ['stack', 'command', 'convention', 'decision', 'gotcha', 'todo', 'note', 'preference', 'environment'];
const GLOBAL_ORDER: MemType[] = ['environment', 'preference', 'convention', 'decision', 'gotcha', 'command', 'stack', 'todo', 'note'];

function cost(m: Memory): number {
  return estimateTokens(m.content) + 4;
}

function select(items: Array<{ m: Memory; score: number }>, budget: number): { chosen: Memory[]; used: number; rest: Array<{ m: Memory; score: number }> } {
  const chosen: Memory[] = [];
  const rest: Array<{ m: Memory; score: number }> = [];
  let used = 0;
  for (const it of items) {
    const c = cost(it.m);
    // pinned memories always make it in
    if (used + c <= budget || it.m.pinned) {
      chosen.push(it.m);
      used += c;
    } else rest.push(it);
  }
  return { chosen, used, rest };
}

function render(mems: Memory[], order: MemType[], states: Map<number, AnchorState>): string[] {
  const rank = (t: MemType) => order.indexOf(t);
  const sorted = [...mems].sort((a, b) => rank(a.type) - rank(b.type) || b.pinned - a.pinned || a.id - b.id);
  return sorted.map((m) => {
    const st = states.get(m.id);
    const flag = st === 'stale' ? ' ?stale' : st === 'missing' ? ' ?missing' : '';
    // auto memories maintain themselves: their ids are noise
    const id = m.source === 'auto' ? '' : ` #${m.id}`;
    return `[${shortType(m.type)}] ${m.content}${id}${flag}`;
  });
}

export interface DigestOpts {
  store: Store;
  project: ProjectInfo | null;
  budget: number;
}

/** Compact session digest. Never touches usage stats: showing a memory is not using it. */
export function buildDigest({ store, project, budget }: DigestOpts): string {
  const pid = project?.id ?? null;
  const all = store.list({ scope: 'all', projectId: pid, limit: 1000 });
  if (!all.length) {
    return project
      ? `memory7: no memories yet for ${project.name}. Save durable facts with memory_save; stack and commands are detected automatically.`
      : 'memory7: no memories yet. Save durable facts with memory_save.';
  }
  const now = Date.now();
  const scored = all.map((m) => ({ m, score: baseScore(m, pid, now) })).sort((a, b) => b.score - a.score);
  const glob = scored.filter((x) => x.m.scope === 'global');
  const proj = scored.filter((x) => x.m.scope === 'project');

  const header = 40;
  const commitsBudget = project ? 45 : 0;
  const pool = Math.max(60, budget - header - commitsBudget);
  const g = select(glob, Math.floor(pool * 0.35));
  const p = select(proj, pool - g.used);
  // leftover room goes back to global
  const g2 = select(g.rest, Math.max(0, pool - g.used - p.used));
  const globalChosen = [...g.chosen, ...g2.chosen];

  // anchored memories: check all of them, not just the ones shown, so nothing stale hides behind the budget
  const states = new Map<number, AnchorState>();
  const stale: number[] = [];
  if (project) {
    for (const { m } of proj) {
      const anchors = parseAnchors(m.anchors);
      if (!anchors.length) continue;
      const st = checkAnchors(project.root, anchors);
      states.set(m.id, st);
      if (st !== 'ok') stale.push(m.id);
    }
  }

  const lines: string[] = [];
  if (globalChosen.length) {
    lines.push('# global', ...render(globalChosen, GLOBAL_ORDER, states));
  }
  if (project) {
    const branch = readBranch(project.root);
    lines.push(`# project ${project.name}${branch ? ` (${branch})` : ''}`);
    lines.push(...render(p.chosen, PROJECT_ORDER, states));
    const commits = recentCommits(project.root, 3);
    if (commits.length) lines.push('recent: ' + commits.map((c) => `${c.subject} (${c.ago})`).join(' | '));
  }
  if (stale.length) {
    const ids = stale.slice(0, 8).map((i) => '#' + i).join(' ');
    lines.push(`stale: ${ids}${stale.length > 8 ? ' …' : ''}. Code changed since saved: verify, then memory_save id=N (re-confirms) or fix/delete.`);
  }
  const hidden = g2.rest.length + p.rest.length;
  if (hidden > 0) lines.push(`+${hidden} more: memory_search`);
  return lines.join('\n');
}
