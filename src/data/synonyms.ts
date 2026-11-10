/**
 * Query expansion without embeddings. Each group is a set of terms that should find each other.
 * The first word in a group is also used as an abbreviation key ("os", "pm", "db").
 */
const GROUPS: string[][] = [
  ['os', 'operating', 'ubuntu', 'debian', 'fedora', 'arch', 'linux', 'macos', 'mac', 'windows', 'wsl', 'nixos', 'manjaro', 'mint', 'opensuse'],
  ['shell', 'bash', 'zsh', 'fish', 'powershell', 'terminal', 'nushell'],
  ['editor', 'ide', 'vscode', 'neovim', 'vim', 'emacs', 'cursor', 'kiro', 'zed', 'intellij', 'webstorm', 'sublime'],
  ['pm', 'package', 'manager', 'npm', 'pnpm', 'yarn', 'bun', 'pip', 'uv', 'poetry', 'cargo', 'gem', 'composer'],
  ['db', 'database', 'postgres', 'postgresql', 'mysql', 'mariadb', 'sqlite', 'mongo', 'mongodb', 'redis', 'dynamodb', 'supabase'],
  ['orm', 'prisma', 'drizzle', 'typeorm', 'sequelize', 'mongoose', 'knex', 'sqlalchemy', 'activerecord'],
  ['test', 'tests', 'testing', 'vitest', 'jest', 'mocha', 'pytest', 'playwright', 'cypress', 'unittest', 'spec'],
  ['lint', 'linter', 'eslint', 'biome', 'ruff', 'flake8', 'pylint', 'clippy', 'prettier', 'format', 'formatter'],
  ['build', 'compile', 'bundle', 'bundler', 'vite', 'webpack', 'esbuild', 'tsup', 'rollup', 'turbopack'],
  ['framework', 'next', 'nextjs', 'react', 'vue', 'nuxt', 'svelte', 'sveltekit', 'angular', 'astro', 'remix', 'express', 'fastify', 'nest', 'nestjs', 'django', 'flask', 'fastapi', 'rails', 'laravel', 'spring'],
  ['lang', 'language', 'typescript', 'javascript', 'python', 'rust', 'golang', 'java', 'kotlin', 'ruby', 'php', 'swift', 'csharp'],
  ['deploy', 'deployment', 'hosting', 'vercel', 'netlify', 'fly', 'railway', 'heroku', 'aws', 'gcp', 'azure', 'cloudflare', 'docker', 'kubernetes', 'k8s'],
  ['ci', 'pipeline', 'actions', 'github', 'gitlab', 'jenkins', 'circleci'],
  ['auth', 'authentication', 'login', 'session', 'jwt', 'oauth', 'sso', 'token'],
  ['style', 'styling', 'css', 'tailwind', 'sass', 'scss', 'styled'],
  ['concise', 'brief', 'short', 'terse', 'verbose'],
  ['node', 'nodejs', 'runtime', 'deno'],
  ['container', 'docker', 'compose', 'podman'],
  ['env', 'environment', 'envvar', 'dotenv', 'config', 'configuration'],
  ['api', 'rest', 'graphql', 'trpc', 'grpc', 'endpoint'],
  ['cmd', 'command', 'script', 'run'],
];

const index = new Map<string, Set<string>>();
for (const g of GROUPS) {
  for (const w of g) {
    let s = index.get(w);
    if (!s) index.set(w, (s = new Set()));
    for (const o of g) if (o !== w) s.add(o);
  }
}

/** Related terms for `term` (excluding itself). Empty when unknown. */
export function expand(term: string): string[] {
  const s = index.get(term);
  return s ? [...s] : [];
}
