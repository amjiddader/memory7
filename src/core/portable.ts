import { readFileSync } from 'node:fs';
import type { Store } from './store.js';
import { MEM_TYPES } from './types.js';
import type { MemType, ProjectInfo, Scope } from './types.js';

interface Line {
  scope?: Scope;
  key?: string;
  type: MemType;
  content: string;
  tags?: string;
}

/** Personal backup: everything visible from here (global + this project) as JSONL, minus auto-detected facts. */
export function exportAll(store: Store, project: ProjectInfo | null): string {
  return (
    store
      .list({ scope: 'all', projectId: project?.id ?? null, limit: 5000 })
      .filter((m) => m.source !== 'auto')
      .map((m) => {
        const l: Line = { scope: m.scope, type: m.type, content: m.content };
        if (m.key) l.key = m.key;
        if (m.tags) l.tags = m.tags;
        return JSON.stringify(l);
      })
      .join('\n') + '\n'
  );
}

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  rejected: number;
}

/** Restore a backup made by `memory7 export`. Goes through the normal save path (dedupe, secret filter, limits). */
export function importFile(store: Store, project: ProjectInfo | null, file: string): ImportResult {
  const res: ImportResult = { created: 0, updated: 0, skipped: 0, rejected: 0 };
  const text = readFileSync(file, 'utf8');
  store.tx(() => {
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      let l: Line;
      try {
        l = JSON.parse(raw);
      } catch {
        res.rejected++;
        continue;
      }
      if (!l || typeof l.content !== 'string' || !(MEM_TYPES as readonly string[]).includes(l.type)) {
        res.rejected++;
        continue;
      }
      const scope: Scope = l.scope === 'global' ? 'global' : 'project';
      if (scope === 'project' && !project) {
        res.rejected++;
        continue;
      }
      const r = store.save({ project }, { content: l.content, key: typeof l.key === 'string' ? l.key : undefined, type: l.type, scope, tags: typeof l.tags === 'string' ? l.tags : undefined }, 'user');
      if (r.status === 'created') res.created++;
      else if (r.status === 'updated') res.updated++;
      else if (r.status === 'skipped') res.skipped++;
      else res.rejected++;
    }
  });
  return res;
}
