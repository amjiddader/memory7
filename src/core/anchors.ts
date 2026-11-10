import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Anchor } from './types.js';

const MAX_HASH_BYTES = 1_000_000;

/** Resolve a user-supplied path inside the project root. Returns null if it escapes the root. */
export function safeJoin(root: string, p: string): string | null {
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) return null;
  return abs;
}

/**
 * Content hash that survives checkouts on other platforms: CRLF is normalized to LF for text files, so a
 * Windows clone with core.autocrlf produces the same hash as a Linux one. Binary files are hashed as-is.
 */
export function hashFile(abs: string): string {
  const buf = readFileSync(abs).subarray(0, MAX_HASH_BYTES);
  const binary = buf.subarray(0, 8000).includes(0);
  let data: Buffer | string = buf;
  if (!binary) {
    const text = buf.toString('utf8');
    data = text.includes('\r') ? text.replace(/\r\n/g, '\n') : text;
  }
  return createHash('sha1').update(data).digest('hex').slice(0, 16);
}

// Paths worth anchoring: contain a directory, or have a source-like extension.
const PATH_RE =
  /(?:^|[\s`"'(\[])((?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z0-9]{1,8}|[\w-]+\.(?:tsx?|jsx?|mjs|cjs|py|rs|go|java|kt|rb|php|cs|swift|json|ya?ml|toml|sql|sh|css|scss|html|vue|svelte))(?=$|[\s`"')\],.:;])/g;
// Files that change constantly or say nothing about behavior: anchoring them would only create noise.
const NOISY = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|CHANGELOG\.md|README\.md|LICENSE|node_modules\/.*)$/i;

/** Existing files in the project that the text mentions (at most 5). Lets memories go stale without the AI listing files. */
export function extractPaths(content: string, root: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(PATH_RE)) {
    const p = m[1]!;
    if (out.includes(p) || NOISY.test(p)) continue;
    const abs = safeJoin(root, p);
    if (!abs) continue;
    try {
      if (statSync(abs).isFile()) out.push(p);
    } catch {
      /* mentioned but absent: not an anchor */
    }
    if (out.length >= 5) break;
  }
  return out;
}

/** Record the current state of files a memory depends on. Unreadable or out-of-root paths are returned in `rejected`. */
export function snapshotAnchors(root: string, files: string[]): { anchors: Anchor[]; rejected: string[] } {
  const anchors: Anchor[] = [];
  const rejected: string[] = [];
  for (const f of files.slice(0, 10)) {
    const abs = safeJoin(root, f);
    if (!abs) {
      rejected.push(f);
      continue;
    }
    try {
      const st = statSync(abs);
      if (!st.isFile()) throw new Error('not a file');
      anchors.push({ p: relative(root, abs).split(sep).join('/'), h: hashFile(abs), m: Math.floor(st.mtimeMs) });
    } catch {
      rejected.push(f);
    }
  }
  return { anchors, rejected };
}

export type AnchorState = 'ok' | 'stale' | 'missing';

/** mtime first; hash only when mtime moved. Returns the worst state across anchors. */
export function checkAnchors(root: string, anchors: Anchor[]): AnchorState {
  let state: AnchorState = 'ok';
  for (const a of anchors) {
    const abs = safeJoin(root, a.p);
    if (!abs) continue;
    try {
      const st = statSync(abs);
      if (Math.floor(st.mtimeMs) === a.m) continue;
      if (hashFile(abs) !== a.h) state = 'stale';
    } catch {
      return 'missing';
    }
  }
  return state;
}

export function parseAnchors(json: string | null): Anchor[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as Anchor[]) : [];
  } catch {
    return [];
  }
}
