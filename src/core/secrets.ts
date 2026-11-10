/** Refuse to store anything that looks like a credential. Returns a label for the first match, or null. */

const PATTERNS: Array<[string, RegExp]> = [
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{16,}\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{30,}\b/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['OpenAI key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
  ['Stripe key', /\b[rsp]k_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ['private key block', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['credentials in URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{3,}@/i],
  [
    'password/secret assignment',
    /\b(?:pass(?:word|wd)?|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)\b\s*[:=]\s*["']?[^\s"']{6,}/i,
  ],
];

function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export function findSecret(text: string): string | null {
  for (const [label, re] of PATTERNS) if (re.test(text)) return label;
  // high-entropy long tokens (random keys), ignoring path-like and hex-hash-like strings
  for (const tok of text.split(/\s+/)) {
    const t = tok.replace(/^[`"'(\[]+|[`"'),.;\]]+$/g, '');
    if (t.length < 32 || t.length > 200) continue;
    if (!/^[A-Za-z0-9+/_=-]+$/.test(t)) continue;
    if ((t.match(/\//g) ?? []).length >= 2) continue; // paths
    if (/^[0-9a-f]+$/i.test(t)) continue; // git shas, content hashes
    if (!/[A-Za-z]/.test(t) || !/[0-9]/.test(t)) continue;
    if (entropy(t) > 4.3) return 'high-entropy token';
  }
  return null;
}
