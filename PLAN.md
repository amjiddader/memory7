# memory7: Plan

Local, fast, low-token memory for AI coding tools. One MCP server shared by Claude Code, Kiro, VS Code (Copilot), OpenCode and Cursor, with global memory (about the user) and project memory (about a codebase).

```
npx -y memory7          # runs the MCP server over stdio
npx memory7 init        # wires it into your IDEs
```

npm name `memory7` is unclaimed (checked 2026-11-09).

---

## 1. Goals and non-goals

**Goals**
- **Fast.** Cold start under 150 ms. Search p95 under 5 ms on 10k memories. Digest under 10 ms.
- **Few tokens.** 4 tools with short schemas. Compact one-line results. Session digest capped at a token budget (default 400).
- **Automatic.** Memory stays current while coding, without the user saying "remember".
- **Smart.** No duplicates, no contradictions, stale facts flagged, the most useful memories ranked first.
- **Shared.** Every IDE reads and writes the same memory.
- **Safe.** Never store secrets. Everything local. Easy undo.

**Non-goals (v1)**
- Remote/HTTP transport or ChatGPT support.
- Embeddings or a bundled language model. FTS5 plus query expansion covers v1. The schema leaves room for vectors later.
- Cloud sync or accounts.

---

## 2. Stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript, ESM, compiled to `dist/` | Typed, standard for MCP |
| Runtime | Node >= 22.13 | Ships `node:sqlite` without a flag |
| Database | `node:sqlite` (built in), FTS5 | No native deps, so `npx` installs in about a second with no compiler step. Fallback adapter for `better-sqlite3` if a user's Node build lacks FTS5 |
| MCP | `@modelcontextprotocol/sdk`, stdio | Official SDK |
| Validation | `zod` | Already a dependency of the SDK |
| Build | `tsup` (single bundled file) | Smaller install, faster start |
| Tests | `vitest` + a benchmark script | |

Runtime dependencies: the MCP SDK and zod only. Everything else is hand-written and small.

---

## 3. Storage

### 3.1 Location

```
~/.memory7/
  memory7.db          # all memories: global + every project (SQLite, WAL)
  config.json         # optional user settings
  logs/               # opt-in debug log
<repo>/.memory7/
  team.jsonl          # optional, committed, shared project memory (see 3.4)
```

One database file, with a `project_id` column. This keeps repos clean, makes cross-project search possible ("how did I set up auth in my other app?"), and needs only one connection.

SQLite settings: `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=3000`, `foreign_keys=ON`. WAL lets Claude Code and Kiro use the same file at the same time.

### 3.2 Project identity

A project is identified so that clones, worktrees and moved folders share memory:

1. Workspace root from MCP `roots` (fallback: `MEMORY7_PROJECT` env, then `cwd`).
2. Walk up to the git root.
3. `project_id = sha1(normalized git remote "origin" URL)`. If there is no remote, use `sha1(realpath(git root))`.
4. Record `root`, `name`, `remote` and `last_seen` in the `projects` table. If the path changes, update it.

Cached in memory for the life of the process. The cost is one `git` call per session (or reading `.git/config` directly to skip spawning a process).

### 3.3 Schema

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT, root TEXT, remote TEXT,
  created_at INTEGER, last_seen INTEGER
);

CREATE TABLE memories (
  id           INTEGER PRIMARY KEY,
  scope        TEXT NOT NULL CHECK (scope IN ('global','project')),
  project_id   TEXT REFERENCES projects(id),     -- NULL for global
  key          TEXT,                              -- e.g. 'os', 'pkg-manager', 'test-cmd'
  type         TEXT NOT NULL,                     -- see 3.5
  content      TEXT NOT NULL,                     -- one short fact, <= 500 chars
  tags         TEXT,                              -- space-separated
  source       TEXT NOT NULL,                     -- 'user' | 'ai' | 'auto' | 'team'
  anchors      TEXT,                              -- JSON: [{path, hash}] files this fact depends on
  branch       TEXT,                              -- optional: fact only valid on this branch
  pinned       INTEGER DEFAULT 0,
  hit_count    INTEGER DEFAULT 0,
  created_at   INTEGER, updated_at INTEGER, last_used_at INTEGER,
  deleted_at   INTEGER                            -- soft delete
);
CREATE UNIQUE INDEX mem_key ON memories(scope, IFNULL(project_id,''), key)
  WHERE key IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX mem_scope ON memories(project_id, type, deleted_at);

CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, tags, key,
  content='memories', content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 2', prefix='2 3'
);
-- plus a trigram FTS table for typo-tolerant fallback
CREATE VIRTUAL TABLE memories_tri USING fts5(content, content='memories', content_rowid='id', tokenize='trigram');

CREATE TABLE history (               -- every change, for undo and audit
  id INTEGER PRIMARY KEY, memory_id INTEGER, op TEXT,  -- 'create'|'update'|'delete'
  old_content TEXT, new_content TEXT, at INTEGER, source TEXT
);

CREATE TABLE detectors (             -- passive capture cache
  project_id TEXT, file TEXT, hash TEXT, checked_at INTEGER,
  PRIMARY KEY (project_id, file)
);

CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);  -- schema_version, etc.
```

Triggers keep both FTS tables in sync. Migrations run in a transaction on startup, keyed on `meta.schema_version`.

### 3.4 Team memory (optional)

SQLite files don't merge in git, so shared project memory uses text:

- `memory7 export --team` writes project memories marked `shared` to `<repo>/.memory7/team.jsonl`, sorted by key so diffs stay clean.
- On session start, if `team.jsonl` changed (hash check), it is imported with `source='team'`.
- Local memories are never written to the repo unless the user exports them.

### 3.5 Memory types

| Type | Example | Default scope |
|---|---|---|
| `preference` | "Prefers pnpm over npm" | global |
| `environment` | "Ubuntu 24.04, zsh, Node 22 via fnm" | global |
| `stack` | "Next.js 15, Postgres, Drizzle, vitest" | project (mostly `auto`) |
| `convention` | "Use named exports; tests next to source" | project |
| `decision` | "Chose Drizzle over Prisma for edge support" | project |
| `command` | "Run tests: `pnpm test -- --run`" | project |
| `gotcha` | "Migrations must run before seed or FK fails" | project |
| `todo` | "Auth refresh token rotation is unfinished" | project |
| `note` | anything else | either |

Types control the digest order and the default scope.

---

## 4. MCP surface

Kept small, because every tool schema costs tokens in every session.

### 4.1 Server `instructions` (sent once at init, about 120 tokens)

> memory7 stores durable memory. At session start call `memory_context`. Call `memory_save` without being asked when: the user states a preference or fact about themselves or their setup (scope=global); a decision, convention, command, gotcha or todo emerges in the project; you learn something you had to discover the hard way. One fact per memory, short. Use a stable `key` for facts that can change (e.g. `os`, `db`, `test-cmd`) so they are replaced, not duplicated. Search before asking the user something they may have told you before. Never save secrets.

### 4.2 Tools

**`memory_context()`**: the session digest. No arguments.
Returns plain text within the token budget:

```
# global
[env] Ubuntu 24.04, zsh (#3)
[pref] pnpm over npm; concise answers (#5 #9)
# project: acme-web (main)
[stack] Next.js 15, TS, Drizzle, Postgres, vitest, pnpm (auto)
[cmd] test: pnpm test -- --run · dev: pnpm dev (#21 #22)
[conv] named exports; zod at API edges (#30)
[todo] refresh-token rotation unfinished (#41)
[?stale] #33 "auth lives in src/lib/auth.ts" (file changed)
recent: feat(auth): add session table · fix(api): pagination (git, 2d)
+14 more, use memory_search
```

**`memory_search(query, scope?="all", type?, limit?=5)`**
Returns one line per hit: `#12 [pref|g] uses pnpm over npm`. `scope` is `project | global | all | any-project` (the last searches other projects).

**`memory_save(items)`**
`items` is one object or an array (batch saves cost one call):
`{content, key?, type?, scope?, tags?, files?, branch?, pin?, id?}`.
- `id` or `key` given and existing: update.
- Otherwise: dedupe check (see 5.1), then insert.
- `scope` and `type` are inferred if missing (see 5.2).
- `files` become anchors (path + content hash).

Returns e.g. `saved #44 · updated #12 (was: "uses npm") · skipped: dup of #9`.

**`memory_delete(ids? | key? | query?)`**
Soft delete. `query` deletes only if it matches exactly one memory, otherwise returns the candidates. Returns `deleted #12 (undo: memory7 undo 12)`.

### 4.3 Resources and prompts (free for clients that support them)

- Resource `memory7://context`: same as `memory_context`, so clients can attach it without a tool call.
- Prompt `remember`: user types `/remember <text>` and it saves directly.

---

## 5. What makes it smart

All of this is deterministic code, no model.

### 5.1 Dedupe and contradiction handling
Before an insert:
1. Normalize (lowercase, strip punctuation, stem through FTS).
2. Fetch the top 5 FTS candidates in the same scope and type.
3. Score with token Jaccard plus trigram similarity.
   - `>= 0.85`: duplicate. Skip, bump `hit_count`, return `skipped: dup of #N`.
   - `0.5–0.85` with the same subject words: probable update. Replace if the AI passed `key` or `replace: true`; otherwise save and return `similar: #N "..."` so the AI can decide on the next turn.
4. **Key inference**: a small rule table maps common subjects to keys (`os`, `shell`, `editor`, `pkg-manager`, `node-version`, `db`, `orm`, `test-cmd`, `lint-cmd`, `deploy`...). "I switched to Fedora" gets `key=os` and replaces "uses Ubuntu" automatically. The old value goes to `history`.

### 5.2 Scope and type inference
Keyword rules with a confidence score, for example:
- "I / my / always / prefer / I use" plus OS, shell, editor or language words: `global`, `preference` or `environment`.
- "we decided / chose / instead of": `decision`.
- "run / command / script" plus a backticked command: `command`.
- "don't / must / careful / breaks if": `gotcha`.
- "TODO / later / unfinished": `todo`.
Default: `project`, `note`. The AI can always override.

### 5.3 Ranking
```
score = bm25 * type_weight * recency * usage * pin * scope_bonus * stale_penalty
recency = 0.5 ^ (days_since_used / 60)
usage   = 1 + ln(1 + hit_count) * 0.3
scope_bonus   = 1.2 for current project, 1.0 global, 0.6 other projects
stale_penalty = 0.5 if any anchor changed
```
`last_used_at` and `hit_count` update when a memory appears in a result. These are batched and written once per second, so reads stay fast.

### 5.4 Query expansion (FTS5 without embeddings)
- A built-in synonym map of about 300 dev terms (`os → ubuntu linux macos windows fedora`, `pm → npm pnpm yarn bun`, `db → postgres mysql sqlite mongo`, `tests → vitest jest pytest`...).
- Prefix matching on every term, OR between expansions, AND between original terms. If there are fewer than `limit` results, fall back to OR.
- If there are still no hits, use the trigram table (typos: "postgress").

### 5.5 Staleness through file anchors
A memory saved with `files: ["src/lib/auth.ts"]` stores the file's hash. On `memory_context` or search, anchors in the result set are checked by `mtime` first, and hashed only if the mtime changed. Changed or deleted files mark the memory `?stale` in output, so the AI knows to verify before trusting it. Saving it again with the same key refreshes the hash.

### 5.6 Passive capture (works even if the AI never saves anything)
On `memory_context`, detectors read only files whose `mtime` changed since last check:

| File | Captures |
|---|---|
| `package.json`, lockfiles, `.nvmrc`, `.node-version` | runtime, package manager, framework, test/lint/build scripts, monorepo |
| `tsconfig.json`, eslint/biome/prettier configs | TS strictness, linter, formatter |
| `pyproject.toml`, `requirements*.txt`, `uv.lock`, `poetry.lock` | Python version, tools, frameworks |
| `Cargo.toml`, `go.mod`, `pom.xml`, `build.gradle*`, `Gemfile`, `composer.json` | language and framework |
| `Dockerfile`, `compose*.yml`, `.github/workflows/*` | containers, services, CI |
| `.env.example` | names of required env vars (never values) |
| `Makefile`, `justfile` | common commands |

Results are upserted as `source=auto` memories with fixed keys (`auto:stack`, `auto:cmd:test`...), so they replace themselves when the manifest changes. AI or user memories with the same key take priority over `auto` ones.

Recent git activity (last 5 commit subjects, current branch, uncommitted file count) is computed at digest time and never stored.

### 5.7 Secret guard
Saves are rejected if the content matches common secret patterns: AWS keys, GitHub/GitLab/npm/OpenAI/Anthropic/Stripe tokens, JWTs, PEM blocks, `password=...`, high-entropy strings over 32 chars. The response explains why, so the AI can save a redacted version.

### 5.8 Hygiene
- `memory7 gc` (also run lazily, at most once a day): merges duplicates found since, archives `note`s unused for 180 days with `hit_count=0`, removes `todo`s marked done, and runs FTS `optimize`.
- Caps: 500 chars per memory, warning at 2,000 memories per project.

---

## 6. Automatic updates through hooks

Instructions alone make most models save memories most of the time. Hooks make it reliable where the IDE supports them. `memory7 init` installs them.

| IDE | Session start | During / end |
|---|---|---|
| Claude Code | `SessionStart` hook runs `memory7 context --hook`. Stdout goes into the model context, so the digest arrives with no tool call | `Stop` hook runs `memory7 capture`: re-runs passive capture; `UserPromptSubmit` hook detects "remember ..." and saves directly |
| Kiro | Steering file `.kiro/steering/memory7.md` (always included) with the save rules; `SessionStart` hook for the digest | `Stop` / `PostFileSave` hook runs `memory7 capture` |
| VS Code, Cursor, OpenCode | Rules file (`.github/copilot-instructions.md`, `.cursor/rules/memory7.mdc`, `AGENTS.md`) with the save rules | Server instructions only |

`init` edits these files additively and between marker comments (`<!-- memory7:start -->` ... `<!-- memory7:end -->`), so running it again updates the block instead of duplicating it, and `memory7 uninstall` removes it cleanly.

Exact hook and config formats change between IDE versions. Verify each against current docs while building milestone 4.

---

## 7. CLI

```
memory7                     # no args + stdin not a TTY: start MCP server (stdio)
memory7 init [--ide claude|kiro|vscode|cursor|opencode|all] [--project] [--no-hooks]
memory7 uninstall [--ide ...]
memory7 context [--hook] [--budget 400]
memory7 search <query> [--scope ...]
memory7 add <text> [--global] [--key k] [--type t]
memory7 rm <id|key>      memory7 undo <id>      memory7 pin <id>
memory7 ls [--scope ...] [--type ...]
memory7 capture             # run passive detectors now
memory7 export [--team] [--json|--md]    memory7 import <file>
memory7 gc                  memory7 doctor   # checks Node version, FTS5, DB health, IDE configs
memory7 projects            # list known projects
```

The CLI and the MCP server share one core module. The CLI is how hooks and humans use memory7 without an AI.

### 7.1 IDE configs written by `init`

- Claude Code: `claude mcp add memory7 -s user -- npx -y memory7` (or edits `~/.claude.json`)
- Kiro: `~/.kiro/settings/mcp.json` → `mcpServers.memory7 = {command:"npx", args:["-y","memory7"]}`
- VS Code: user `mcp.json` → `servers.memory7 = {type:"stdio", command:"npx", args:["-y","memory7"]}`
- Cursor: `~/.cursor/mcp.json` → `mcpServers.memory7`
- OpenCode: `opencode.json` → `mcp.memory7 = {type:"local", command:["npx","-y","memory7"], enabled:true}`

Always merge into existing files and back up the original first (`*.bak`).

---

## 8. Performance plan

- Bundle to one file with `tsup`. Lazy-import the CLI-only code and detectors.
- Open the DB and prepare all statements once at startup. Reuse them.
- Respond to MCP `initialize` before running migrations or detectors where possible.
- Passive capture: `stat` first, read and hash only changed files. Run git once.
- Batch writes for usage stats.
- Compact text output everywhere. No JSON in tool results unless `format: "json"` is requested.
- Benchmark script (`bench/`): seeds 10k memories across 20 projects and reports cold start, search p50/p95, save, and digest. CI fails on regressions above 20%.

---

## 9. Project layout

```
memory7/
  src/
    index.ts            # entry: decide server vs CLI
    server.ts           # MCP server, tools, resources, prompts
    cli/                # one file per command
    core/
      db.ts             # open, pragmas, migrations, prepared statements
      store.ts          # save/update/delete/history/undo
      search.ts         # query building, expansion, ranking
      digest.ts         # memory_context assembly + token budget
      dedupe.ts         # similarity, key inference
      infer.ts          # scope/type rules
      anchors.ts        # file hash/staleness
      secrets.ts        # secret patterns
      project.ts        # root + identity detection
      tokens.ts         # cheap token estimate (chars/4)
    capture/            # one detector per ecosystem + git.ts
    ide/                # init/uninstall per IDE, hook + rules templates
    data/synonyms.ts
  migrations/
  test/
  bench/
  package.json          # "bin": {"memory7": "dist/index.js"}, "engines": {"node": ">=22.13"}
  README.md
```

---

## 10. Milestones

| # | Scope | Done when |
|---|---|---|
| M0 | Scaffold: TS, tsup, vitest, lint, `bin`, CI | `npx .` starts and answers MCP `initialize` |
| M1 | Core: DB, migrations, project identity, the 4 tools, keyed upsert, soft delete, history | Works end to end in Claude Code and Kiro |
| M2 | Search quality: FTS5 + trigram, synonyms, ranking, compact output, digest with budget | Search benchmarks pass; digest under 400 tokens |
| M3 | Smart layer: dedupe, key/scope/type inference, anchors and staleness, secret guard, gc | Test suite of about 50 realistic save/search scenarios passes |
| M4 | Passive capture + CLI + `init` for all 5 IDEs + hooks/rules | Fresh machine: `npx memory7 init` then memory works in each IDE |
| M5 | Team memory, export/import, `doctor`, README, benchmarks in CI, publish `memory7@0.1.0` | Published to npm |
| Later | Optional embeddings (`sqlite-vec` + small local model, lazy-loaded), HTTP transport, a small local web UI | |

---

## 11. Open decisions

1. **Project memory location.** This plan stores everything in `~/.memory7/memory7.db`, with optional committed `team.jsonl`. The alternative is a per-repo `.memory7/project.db`. Confirm.
2. **License.** MIT suggested.
3. **Telemetry.** None suggested.
4. **Minimum Node.** 22.13 for built-in `node:sqlite`. If Node 20 support matters, use `better-sqlite3` as the main driver instead, which adds a native install step.

---

## 12. Implementation notes (v0.1.0): where the build differs from this plan

Written after building. The code is the source of truth; these are the deliberate changes.

| Plan | Built | Why |
|---|---|---|
| Runtime deps: MCP SDK + zod | Both are bundled into `dist/`; the published package has **zero** dependencies | Cold start 139 ms → 92 ms; `npx memory7` installs nothing else |
| `Stop` / `PostFileSave` hooks run `capture` | No such hooks. The server runs passive capture itself on tool calls (throttled to once per 20 s, ~40 `stat` calls when nothing changed) | Same freshness without spawning a process after every turn |
| Team memory auto-imported at session start | **Off by default** (`teamAutoImport` in `config.json`). Team imports can never write global memory or override a local key | A cloned repo is untrusted input that would land in the model's context |
| `memory_save` had `tags`, `pin`, `branch` | Tool schema keeps `content, key, type, scope, files, id, replace, items`. Tags and pin remain in the CLI (`add --tags`, `pin`). No `branch` column | Cut ~200 tokens of schema that every session pays; none of those fields were used by the AI in tests |
| OpenCode config edited as JSON | Uses `opencode mcp add --global` when the CLI exists, otherwise prints a snippet | OpenCode changed its config shape (`mcp.servers`) between versions |
| Rules for VS Code at user level | Not written (no verified user-level path). `init --project` writes `AGENTS.md`; `memory7 rules` prints the text | Avoid writing to a path that is not documented |
| Trigram table as typo fallback via phrase match | Trigram candidates are re-scored with a Dice similarity check in code | A misspelled phrase can never match as a whole phrase |
| Query `memory_delete` = "matches exactly one" | Requires every query term to be present (`cov === 1`) and at least one real search word | OR-fallback search could otherwise delete a loosely related memory |
| (not planned) | `memory7 rules`, `memory7 doctor` checks, `unpin`, `prompt-hook` | Needed for hooks and for IDEs without an installer |

Measured on the 10k-memory benchmark (`npm run bench`): search p95 2.6 ms (project+global) / 4.6 ms (all projects), digest p95 7.7 ms, save p95 2.2 ms, server cold start 92 ms median. Tool schemas plus server instructions: about 790 tokens.


### 12.1 Second iteration: staleness, shared project memory, MEMORY.md, platforms

Driven by one question: what happens when code changes and memory is not updated, and how does a teammate who clones the repo get the same memory?

| Change | Detail |
|---|---|
| Shared project memory in the repo | `.memory/memory.jsonl` replaces the earlier `.memory7/team.jsonl` export. The local SQLite stays the index; the file is the shared source of truth with a two-way sync (`src/core/sync.ts`). Stable `ident` per memory (key, or `~uid`), `updated` seconds, tombstones for deletes, `merge=union` so concurrent branches merge without conflicts. Opt-in by the folder existing (`memory7 init --project`). |
| Team import default flipped to **on** | Reverses section 12's "off by default". The user asked for clone-and-go, and a repo file carries the same prompt-injection risk as `AGENTS.md`. Mitigations: project scope only, validated and secret-filtered lines, size caps, hidden from `any-project` search elsewhere, refuses to rewrite a mostly unreadable file, instructions say entries are notes not commands. Disable with `"sync": false` or `MEMORY7_NO_SYNC=1`. |
| Schema v2 | `uid` (stable id across machines) and `local_only` columns, with an in-place migration and backfill. |
| Auto-anchoring | Files mentioned in a memory's text are anchored on save/update (noisy files like lockfiles and README excluded). |
| Cross-machine staleness | Anchor hashes are shared in the file and normalized for CRLF, so a teammate sees `?stale` if the code moved on after the memory was written. |
| Stale surfacing | Digest ends with a `stale:` list for all anchored project memories (not only those shown); `memory7 check [--strict]`; `memory7 verify N` and `memory_save id=N` with no content re-confirm. |
| Edit trigger | Claude Code `PostToolUse` hook (`memory7 edit-hook`) names the memories that depend on a file the AI just edited. Installed only with a global binary. |
| `MEMORY.md` + pointers | `init --project` writes `MEMORY.md` (setup per OS, rules, update triggers) between markers, and short rule blocks into `AGENTS.md`, `CLAUDE.md`, `.kiro/steering`, `.cursor/rules`. |
| Platform work | `realpath.native` for canonical paths, CRLF-safe hashing, rename-with-retry on Windows, LF-forced shared file, platform-aware tests, and a CI matrix (ubuntu/macos/windows x Node 22/24) in `.github/workflows/ci.yml`. |
| Performance | Recent-commit lookup cached 30 s (digest p95 7.7 ms to 4.5 ms); cross-project team filter moved from SQL to JS (about 0.7 ms saved). |
