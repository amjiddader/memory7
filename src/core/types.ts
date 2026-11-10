export type Scope = 'global' | 'project';
export type SearchScope = 'project' | 'global' | 'all' | 'any-project';
export type Source = 'user' | 'ai' | 'auto' | 'team';

export const MEM_TYPES = [
  'preference',
  'environment',
  'stack',
  'convention',
  'decision',
  'command',
  'gotcha',
  'todo',
  'note',
] as const;
export type MemType = (typeof MEM_TYPES)[number];

export interface Anchor {
  /** path relative to the project root */
  p: string;
  /** sha1 of file content when the memory was saved */
  h: string;
  /** mtime (ms) when the memory was saved; lets us skip hashing unchanged files */
  m: number;
}

export interface Memory {
  id: number;
  scope: Scope;
  project_id: string | null;
  key: string | null;
  type: MemType;
  content: string;
  tags: string | null;
  source: Source;
  anchors: string | null;
  pinned: number;
  hit_count: number;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  deleted_at: number | null;
  /** stable id for sharing across machines (local numeric ids differ) */
  uid: string | null;
  /** 1 = never written to the repo's .memory/ folder */
  local_only: number;
}

export interface ProjectInfo {
  id: string;
  name: string;
  root: string;
  remote: string | null;
}

export interface Ctx {
  project: ProjectInfo | null;
}

export const MAX_CONTENT = 500;
