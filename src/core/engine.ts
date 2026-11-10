import { capture } from '../capture/index.js';
import { loadConfig, openDb } from './db.js';
import type { Config, DB } from './db.js';
import { buildDigest } from './digest.js';
import { lazyGc } from './gc.js';
import { detectProject, registerProject } from './project.js';
import { formatLine, projectNames, search } from './search.js';
import type { Hit } from './search.js';
import { Store } from './store.js';
import type { SaveInput, SaveResult } from './store.js';
import { checkAnchors, parseAnchors } from './anchors.js';
import type { AnchorState } from './anchors.js';
import { sync, syncEnabled } from './sync.js';
import type { SyncReport } from './sync.js';
import type { Ctx, MemType, Memory, ProjectInfo, SearchScope, Source } from './types.js';

const CAPTURE_THROTTLE_MS = 20_000;
const DEFAULT_BUDGET = 400;

/** Everything the MCP server and the CLI need, in one place. */
export class Engine {
  readonly store: Store;
  readonly config: Config;
  project: ProjectInfo | null = null;
  private lastCapture = 0;
  private syncing = false;
  private dirty = false;
  private flushQueued = false;
  /** last sync problem, for `memory7 doctor` */
  lastSyncError: string | undefined;

  constructor(db: DB, project: ProjectInfo | null = null, config: Config = loadConfig()) {
    this.store = new Store(db);
    this.config = config;
    // write-through: user/AI changes reach .memory/memory.jsonl right after the current call finishes
    this.store.onChange = () => {
      if (this.syncing) return;
      this.dirty = true;
      if (this.flushQueued) return;
      this.flushQueued = true;
      queueMicrotask(() => {
        this.flushQueued = false;
        this.flushSync();
      });
    };
    if (project) this.setProject(project);
  }

  static open(dir: string, dbPath?: string): Engine {
    const e = new Engine(openDb(dbPath));
    const p = detectProject(dir);
    if (p) e.setProject(p);
    return e;
  }

  get db(): DB {
    return this.store.db;
  }

  setProject(p: ProjectInfo | null): void {
    this.project = p;
    this.lastCapture = 0;
    if (p) registerProject(this.db, p);
  }

  ctx(): Ctx {
    return { project: this.project };
  }

  get syncOn(): boolean {
    return syncEnabled(this.project, this.config);
  }

  /** Pull changes from .memory/memory.jsonl and write ours back. Never throws. */
  sync(): SyncReport | null {
    if (!this.project || !this.syncOn) return null;
    this.syncing = true;
    try {
      const r = sync(this.store, this.project);
      this.lastSyncError = r.skippedWrite;
      return r;
    } catch (e) {
      this.lastSyncError = (e as Error).message;
      return null;
    } finally {
      this.syncing = false;
    }
  }

  flushSync(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.sync();
  }

  /** Shared-file sync + passive capture, throttled so it can run on every tool call at near-zero cost. */
  refresh(force = false): void {
    if (!this.project) return;
    const now = Date.now();
    if (!force && now - this.lastCapture < CAPTURE_THROTTLE_MS) return;
    this.lastCapture = now;
    this.sync();
    try {
      capture(this.store, this.project, force);
    } catch {
      /* passive capture must never break a tool call */
    }
  }

  /** Every project memory whose anchored files changed (or vanished) since it was saved. */
  checkStale(): Array<{ memory: Memory; state: AnchorState }> {
    if (!this.project) return [];
    const out: Array<{ memory: Memory; state: AnchorState }> = [];
    for (const m of this.store.list({ scope: 'project', projectId: this.project.id, limit: 2000 })) {
      const a = parseAnchors(m.anchors);
      if (!a.length) continue;
      const state = checkAnchors(this.project.root, a);
      if (state !== 'ok') out.push({ memory: m, state });
    }
    return out;
  }

  /** Active project memories anchored to a file (project-relative, forward slashes). */
  anchoredTo(rel: string): Memory[] {
    if (!this.project) return [];
    const esc = rel.replace(/[\\%_]/g, '\\$&');
    return this.db
      .prepare("SELECT * FROM memories WHERE project_id = ? AND deleted_at IS NULL AND anchors LIKE ? ESCAPE '\\' LIMIT 5")
      .all(this.project.id, `%"p":"${esc}"%`) as unknown as Memory[];
  }

  save(input: SaveInput, source: Source = 'ai'): SaveResult {
    this.refresh();
    return this.store.save(this.ctx(), input, source);
  }

  search(query: string, scope: SearchScope = 'all', type?: MemType, limit = 5): { hits: Hit[]; text: string } {
    this.refresh();
    const hits = search(this.db, {
      query,
      scope,
      type,
      limit,
      projectId: this.project?.id ?? null,
      projectRoot: this.project?.root ?? null,
    });
    this.store.touch(hits.map((h) => h.memory.id));
    const names = projectNames(this.db);
    const text = hits.length ? hits.map((h) => formatLine(h.memory, this.project?.id ?? null, names, h.state)).join('\n') : 'no matches';
    return { hits, text };
  }

  context(budget?: number): string {
    this.refresh();
    return buildDigest({ store: this.store, project: this.project, budget: budget ?? this.config.budget ?? DEFAULT_BUDGET });
  }

  maintenance(): void {
    try {
      lazyGc(this.store);
    } catch {
      /* best effort */
    }
  }

  close(): void {
    this.flushSync();
    this.store.close();
  }
}
