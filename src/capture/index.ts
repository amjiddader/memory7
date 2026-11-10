import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../core/store.js';
import type { ProjectInfo } from '../core/types.js';
import { WATCHED, detect } from './detectors.js';

function signature(root: string): string {
  const h = createHash('sha1');
  for (const f of WATCHED) {
    try {
      const st = statSync(join(root, f));
      h.update(`${f}:${Math.floor(st.mtimeMs)}:${st.size}\n`);
    } catch {
      /* absent */
    }
  }
  return h.digest('hex');
}

export interface CaptureResult {
  ran: boolean;
  created: number;
  updated: number;
  removed: number;
}

/**
 * Passive capture. Cheap when nothing changed (about 40 stat calls); otherwise re-reads the manifests and
 * upserts `auto` memories. Memories the AI or user has taken over (same key, other source) are left alone.
 * Auto memories whose source fact disappeared (e.g. a removed dependency) are soft-deleted.
 */
export function capture(store: Store, project: ProjectInfo, force = false): CaptureResult {
  const res: CaptureResult = { ran: false, created: 0, updated: 0, removed: 0 };
  const db = store.db;
  let sig: string;
  try {
    sig = signature(project.root);
  } catch {
    return res;
  }
  const row = db.prepare("SELECT hash FROM detectors WHERE project_id = ? AND file = '*'").get(project.id) as { hash: string } | undefined;
  if (!force && row?.hash === sig) return res;

  res.ran = true;
  const found = detect(project.root);
  store.tx(() => {
    const ctx = { project };
    for (const f of found.facts) {
      const r = store.save(ctx, { content: f.content, key: f.key, type: f.type, scope: 'project' }, 'auto');
      if (r.status === 'created') res.created++;
      else if (r.status === 'updated') res.updated++;
    }
    const live = new Set(found.facts.map((f) => f.key));
    const old = store.list({ scope: 'project', projectId: project.id, source: 'auto', limit: 500 });
    const gone = old.filter((m) => m.key && !live.has(m.key)).map((m) => m.id);
    res.removed = store.delete(gone, 'auto').length;
    db.prepare(
      `INSERT INTO detectors(project_id, file, hash, checked_at) VALUES(?, '*', ?, ?)
       ON CONFLICT(project_id, file) DO UPDATE SET hash = excluded.hash, checked_at = excluded.checked_at`,
    ).run(project.id, sig, Date.now());
  });
  return res;
}
