import type { MemType, Scope } from './types.js';
import { MEM_TYPES } from './types.js';

const FIRST_PERSON = /\b(i|i'm|im|i've|my|me|mine|user|user's|users|prefers?|preferred)\b/i;

interface KeyRule {
  key: string;
  re: RegExp;
  scope: Scope;
  type: MemType;
  /** requires first-person / "user" wording so "deploy to ubuntu" is not read as the user's OS */
  person?: boolean;
}

/**
 * Subjects that have exactly one current value. A new memory about the same subject replaces the old one
 * (history keeps the old value), so "switched to Fedora" overwrites "uses Ubuntu".
 */
const KEY_RULES: KeyRule[] = [
  { key: 'os', scope: 'global', type: 'environment', person: true, re: /\b(ubuntu|debian|fedora|arch linux|manjaro|linux mint|pop!?_?os|opensuse|nixos|macos|mac os|os x|windows(?: ?\d+)?|wsl2?|linux)\b/i },
  { key: 'shell', scope: 'global', type: 'environment', person: true, re: /\b(zsh|bash|fish|powershell|nushell)\b(?!\s+(?:script|command))/i },
  { key: 'editor', scope: 'global', type: 'environment', person: true, re: /\b(vs ?code|neovim|vim|emacs|intellij|webstorm|pycharm|sublime|zed|cursor|kiro)\b/i },
  { key: 'pkg-manager', scope: 'global', type: 'preference', person: true, re: /\b(pnpm|npm|yarn|bun)\b.*\b(over|instead|prefer|always|use|using)\b|\b(prefer|always use|use|using)\b.*\b(pnpm|npm|yarn|bun)\b/i },
  { key: 'response-style', scope: 'global', type: 'preference', re: /\b(concise|brief|terse|short(?:er)? (?:answers|responses|replies)|no emojis?|verbose|detailed (?:answers|explanations))\b/i },
  { key: 'name', scope: 'global', type: 'environment', re: /\b(?:my name is|call me|user(?:'s)? name is)\s+\S+/i },
  { key: 'test-cmd', scope: 'project', type: 'command', re: /\b(?:run|runs|running)?\s*tests?\b.*`[^`]+`|`[^`]+`.*\b(?:to|for)\s+(?:run\s+)?tests?\b|\btest (?:command|cmd|script)\b/i },
  { key: 'dev-cmd', scope: 'project', type: 'command', re: /\b(?:dev server|start (?:the )?(?:dev )?server|dev (?:command|cmd|script)|run dev)\b.*`[^`]+`|\b(?:dev|start)(?: command| cmd| script)\b/i },
  { key: 'build-cmd', scope: 'project', type: 'command', re: /\bbuild (?:command|cmd|script)\b|\b(?:to )?build\b.*`[^`]+`/i },
  { key: 'lint-cmd', scope: 'project', type: 'command', re: /\blint(?:ing)? (?:command|cmd|script)\b|\b(?:to )?lint\b.*`[^`]+`/i },
  { key: 'deploy', scope: 'project', type: 'decision', re: /\bdeploy(?:s|ed|ment)?\b.*\b(vercel|netlify|fly\.io|railway|heroku|aws|gcp|azure|cloudflare|docker|kubernetes|k8s)\b/i },
  { key: 'db', scope: 'project', type: 'stack', re: /\b(?:database|db)\b.*\b(postgres(?:ql)?|mysql|mariadb|sqlite|mongo(?:db)?|redis|dynamodb|supabase)\b|\b(postgres(?:ql)?|mysql|mariadb|sqlite|mongo(?:db)?)\b.*\b(?:database|db)\b/i },
  { key: 'orm', scope: 'project', type: 'stack', re: /\b(?:orm|query builder)\b.*\b(prisma|drizzle|typeorm|sequelize|mongoose|knex|sqlalchemy)\b|\b(prisma|drizzle|typeorm|sequelize|mongoose|knex|sqlalchemy)\b.*\borm\b/i },
  { key: 'auth', scope: 'project', type: 'stack', re: /\b(?:auth|authentication|login)\b.*\b(nextauth|auth\.js|clerk|auth0|supabase auth|lucia|passport|firebase auth|jwt|oauth)\b/i },
];

export interface Inferred {
  scope: Scope;
  type: MemType;
  key?: string;
}

/** Pick a type from wording. Returns undefined when nothing matches. */
export function inferType(content: string): MemType | undefined {
  const c = content;
  if (/\b(todo|to-do|unfinished|not (?:yet )?(?:implemented|done)|still need|later)\b/i.test(c)) return 'todo';
  if (/\b(don't|do not|never|must not|careful|breaks?(?: if| when)?|fails? (?:if|when|unless)|watch out|gotcha|beware|otherwise)\b/i.test(c)) return 'gotcha';
  if (/\b(we (?:decided|chose|picked|went with|agreed)|decided (?:to|on)|chose|instead of|rather than|switched (?:to|from))\b/i.test(c)) return 'decision';
  if (/`[^`]+`/.test(c) && /\b(run|runs|command|script|cmd|execute|invoke|start|test|build|lint|deploy)\b/i.test(c)) return 'command';
  if (/\b(convention|always|naming|style|format|structure|pattern|use named|prefer(?:red)? (?:to )?(?:use|write))\b/i.test(c)) return 'convention';
  if (/\b(uses?|built (?:with|on)|stack|framework|library|database|written in|runs on)\b/i.test(c)) return 'stack';
  return undefined;
}

export function inferKey(content: string): { rule: KeyRule } | undefined {
  if (content.length > 200) return undefined;
  const person = FIRST_PERSON.test(content);
  for (const rule of KEY_RULES) {
    if (rule.person && !person) continue;
    if (rule.re.test(content)) return { rule };
  }
  return undefined;
}

/** Fill in whatever the caller omitted. Explicit values always win. */
export function infer(content: string, given: { scope?: Scope; type?: MemType; key?: string }): Inferred & { keyInferred: boolean } {
  const keyHit = given.key ? undefined : inferKey(content);
  const key = given.key ?? keyHit?.rule.key;
  const typeFromText = inferType(content);

  let type: MemType = given.type ?? keyHit?.rule.type ?? typeFromText ?? 'note';
  if (!(MEM_TYPES as readonly string[]).includes(type)) type = 'note';

  let scope: Scope;
  if (given.scope) scope = given.scope;
  else if (keyHit) scope = keyHit.rule.scope;
  else if ((type === 'preference' || type === 'environment') && FIRST_PERSON.test(content)) scope = 'global';
  else if (/\b(i|my|me)\b/i.test(content) && /\b(prefer|always|never|like|hate|want)\b/i.test(content) && !typeFromText) scope = 'global';
  else scope = 'project';

  if (!given.type && !keyHit && !typeFromText && scope === 'global') type = 'preference';
  return { scope, type, key, keyInferred: !given.key && !!keyHit };
}
