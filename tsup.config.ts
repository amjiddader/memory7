import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: false,
  minify: false,
  // chunks keep the MCP SDK out of CLI/hook invocations (they import it lazily)
  splitting: true,
  // Bundle the MCP SDK and zod: `npx memory7` then installs nothing else and starts without
  // resolving hundreds of small files. node: built-ins (node:sqlite) stay external.
  noExternal: [/^(?!node:).*/],
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module';\nconst require = __cr(import.meta.url);",
  },
  define: { __VERSION__: JSON.stringify(pkg.version) },
});
