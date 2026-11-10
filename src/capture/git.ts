import { spawnSync } from 'node:child_process';

export interface Commit {
  subject: string;
  ago: string;
}

/** "2 days ago" -> "2d", "3 months ago" -> "3mo" */
export function shortAgo(s: string): string {
  const m = /^(\d+)\s+(second|minute|hour|day|week|month|year)s?/.exec(s);
  if (!m) return s.replace(/ ago$/, '');
  const unit = { second: 's', minute: 'm', hour: 'h', day: 'd', week: 'w', month: 'mo', year: 'y' }[m[2]!];
  return `${m[1]}${unit}`;
}

/** Last few commit subjects. Computed on demand, never stored. Fails soft (no git, not a repo, slow disk). */
const cache = new Map<string, { at: number; commits: Commit[] }>();

export function recentCommits(root: string, n = 3): Commit[] {
  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < 30_000) return hit.commits;
  const commits = readCommits(root, n);
  cache.set(root, { at: Date.now(), commits });
  return commits;
}

function readCommits(root: string, n: number): Commit[] {
  try {
    const r = spawnSync('git', ['-C', root, 'log', `-n${n}`, '--no-merges', '--format=%s%x09%cr'], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    if (r.status !== 0 || !r.stdout) return [];
    return r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [subject = '', ago = ''] = l.split('\t');
        return { subject: subject.slice(0, 80), ago: shortAgo(ago) };
      });
  } catch {
    return [];
  }
}
