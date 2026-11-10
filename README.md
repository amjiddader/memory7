# memory7

Fast, local, low-token long-term memory for AI coding tools, over MCP.

One memory shared by Claude Code, Kiro, VS Code (Copilot), Cursor and OpenCode, on macOS, Linux and Windows. It remembers things about **you** (global: "uses Ubuntu", "prefers pnpm") and about **each project** (stack, commands, decisions, gotchas). Project memory can live in the repo, so a teammate who clones it starts with the same memory.

```bash
npm install -g memory7     # or use npx
memory7 init               # wires memory7 into the IDEs it finds
memory7 init --project     # inside a repo: share its memory through git (.memory/ + MEMORY.md)
```

Restart your IDE. From then on, the AI loads a short digest at session start, saves what matters as you work, and searches before asking you something you already told it.

## Why this one

| | |
|---|---|
| **Fast** | In-process SQLite + FTS5. On 10k memories: search p95 ≈ 3 ms, digest ≈ 5 ms, MCP server ready in ≈ 90 ms. Hooks run in ≈ 45 ms. |
| **Few tokens** | 4 tools, ≈ 800 tokens of schema + instructions in total. Results are one line each. The session digest is capped (default 400 tokens) and ranked, not dumped. |
| **Automatic** | The AI is told to save unprompted. On top of that, memory7 reads your manifests (`package.json`, `pyproject.toml`, `Cargo.toml`, Dockerfile, CI files, ...) and records stack and commands itself. |
| **Notices when code moves on** | A memory that names a file is tracked against it automatically and flagged `?stale` when the file changes. |
| **Shared through git** | `.memory/memory.jsonl` in the repo, merged without conflicts, newest edit wins, deletes propagate. |
| **Not a pile** | Keyed facts replace their old value ("switched to Fedora" overwrites "uses Ubuntu"). Duplicates are skipped. Everything is soft-deleted with undo. |
| **Local** | SQLite file in `~/.memory7`. No network, no telemetry, no model download. |
| **Zero dependencies** | The published package bundles everything. Needs Node ≥ 22.13 (built-in `node:sqlite`). |

## How it works

### Tools the AI sees

| Tool | What it does |
|---|---|
| `memory_context` | Short digest: global memory + current project (stack, commands, conventions, decisions, gotchas, todos, recent commits) and a `stale:` line for memories whose code changed. Called once per session. |
| `memory_search(query, scope?, type?, limit?)` | One line per hit, e.g. `#12 [pref\|g] {pkg-manager} Prefers pnpm over npm`. `scope`: `all` (default), `project`, `global`, `any-project`. |
| `memory_save(content, key?, type?, scope?, files?, id?, replace?, items?)` | Upsert. Scope and type are inferred if omitted. `items` saves several at once. `id` with no `content` re-confirms a memory against the current code. |
| `memory_delete(ids? \| key? \| query?)` | Soft delete. A query deletes only when it matches exactly one memory, otherwise it lists candidates. |

Also exposed: resource `memory7://context` and prompt `/remember <text>`.

### Keeping memory current when code changes

Memory that is not updated when the code changes is worse than none, so memory7 attacks this from several sides:

1. **Auto-anchoring.** When a saved memory mentions an existing file (`src/lib/auth.ts`), memory7 records the file's content hash. When the file changes the memory shows `?stale` (or `?missing` if deleted) in search results and in the digest, and the digest ends with `stale: #12 #19 ...` plus what to do. Line endings are normalized, so a Windows checkout with CRLF does not look changed.
2. **An edit trigger (Claude Code).** After the AI edits a file, a `PostToolUse` hook tells it which memories depend on that file: "update with `memory_save(id=N, ...)`, delete, or re-confirm". It is installed only when memory7 is installed globally, because it runs on every edit and `npx` startup would be too slow. Kiro's file-save hook cannot return text to the AI, so Kiro relies on the digest and its steering rules.
3. **Rules that name the moments.** The server instructions and `MEMORY.md` say when to save (immediately, not at the end), when to update (after changing code a memory describes), and what a `?stale` flag means.
4. **Passive capture.** On each tool call (throttled to once per 20 s) memory7 re-reads changed manifests and refreshes stack, package manager, Node/Python version, test/dev/build/lint commands, containers, CI, env-var names (never values) and Make/just targets. Facts that disappear from the manifests disappear from memory. A memory you or the AI set with the same key wins over an auto one.
5. **`memory7 check`** lists every out-of-date memory; `--strict` exits non-zero so you can run it in CI.

What it cannot do: notice that a memory is wrong when it names no file and no manifest changed. Those depend on the AI following the rules.

### Staying current without being asked

An MCP server cannot force a model to call it, so there are three layers: the server instructions and rules files; passive capture (no AI involved); and hooks where the IDE supports them (digest injected at session start, prompts starting with "remember ..." saved directly).

### Search

SQLite FTS5 (porter stemming, prefix matching), a built-in synonym map (searching `os` finds "Ubuntu", `db` finds "Postgres"), AND-then-OR fallback, and a trigram fallback for typos. Ranking blends match quality with memory type, recency (60-day half-life, floored), how often a memory was actually returned, pinning, and whether it belongs to the current project.

### Project identity

A project is identified by the hash of its normalized `origin` URL, so every clone and git worktree shares memory. With no remote it falls back to the real path. The workspace comes from the MCP client's `roots`, then `MEMORY7_PROJECT`, then the working directory. Home and `/` are never treated as projects.

## Sharing project memory with your team

```bash
cd my-repo
memory7 init --project      # creates .memory/ and MEMORY.md, adds rule files for your IDEs
git add .memory MEMORY.md AGENTS.md CLAUDE.md .kiro .cursor   # whichever were created
git commit -m "Add shared AI memory"
```

What you get in the repo:

| File | Purpose |
|---|---|
| `.memory/memory.jsonl` | The shared memories: one JSON object per line, sorted, plain text. |
| `.memory/.gitattributes` | `merge=union` and LF endings, so two branches that each add memories merge without conflicts. |
| `MEMORY.md` | Setup instructions per OS, the rules for AI agents, and when to update memory. Written between markers; text you add around the block is kept. |
| `AGENTS.md` / `CLAUDE.md` / `.kiro/steering` / `.cursor/rules` | A short pointer block with the rules, because no AI tool reads a file just because it is called `MEMORY.md`. |

A teammate then runs `npm install -g memory7 && memory7 init` once (the steps are in `MEMORY.md`), opens the project, and has the same memory. After `git pull` the new lines are picked up on the next tool call or session start. Nothing to run.

How sync behaves:

- Sync is on for a project when its `.memory/` folder exists. Turn it off everywhere with `"sync": false` in `~/.memory7/config.json`, or per shell with `MEMORY7_NO_SYNC=1`.
- Every project memory you or your AI save is written through to the file right after the call, except memories you mark local (`memory7 private <id>`), auto-detected facts (recomputed anywhere) and global memory (always personal).
- Conflicts: the newest edit of a memory wins. Deletes are written as tombstones (kept 180 days) so they reach teammates, and a stale copy cannot resurrect a deleted memory. Two people saving the same note independently end up with one.
- `memory7 sync` runs it by hand. `memory7 doctor` shows the state.
- **Treat the file like code.** It is plain text in your git history, so review it in pull requests. Secrets are refused when saving, but nothing can promise a human never types one.

Safety of a file that comes from a repository (it is untrusted input, like `AGENTS.md`):

- Every line is validated: known type, length limit, secret filter, safe file paths, at most 5,000 lines / 2 MB. Bad lines are dropped and counted.
- Lines can only create **project** memories. A repo can never write your global memory.
- Memory that came from a repo is hidden from `any-project` searches in other projects.
- The AI is told that memory entries are notes, not instructions.
- A file that is mostly unreadable (for example with merge-conflict markers) is left untouched.

## Setup per IDE

`memory7 init` detects installed IDEs. Choose explicitly with `--ide claude,kiro,vscode,cursor,opencode` (or `all`). Preview with `--dry-run`. Every edited file gets a one-time `*.memory7.bak` copy, edits are merged (never overwritten), and `memory7 uninstall` reverses everything except your shared memories.

| IDE | MCP server | Rules | Hooks |
|---|---|---|---|
| **Claude Code** | `claude mcp add --scope user` (or `~/.claude.json`) | `~/.claude/CLAUDE.md` block; with `--project`: `CLAUDE.md` block | `SessionStart` digest, `UserPromptSubmit` "remember", `PostToolUse` edit trigger (global install only), plus permissions so the three safe tools don't prompt on every call (delete still asks) |
| **Kiro** | `~/.kiro/settings/mcp.json` with `autoApprove` | `~/.kiro/steering/memory7.md`; with `--project`: `.kiro/steering/memory7.md` | with `--project`: `.kiro/hooks/memory7.json` (committed, so teammates need memory7 installed) |
| **VS Code** | user `mcp.json` (`servers`) | with `--project`: `AGENTS.md` block | none |
| **Cursor** | `~/.cursor/mcp.json` | with `--project`: `.cursor/rules/memory7.mdc` | none |
| **OpenCode** | `opencode mcp add --global` | `~/.config/opencode/AGENTS.md` block; with `--project`: `AGENTS.md` block | none |

If a config file contains comments (JSONC), memory7 will not rewrite it. It prints the snippet to add by hand. Manual MCP entry for any client that launches stdio servers:

```json
{ "command": "npx", "args": ["-y", "memory7"] }
```

On Windows clients that cannot run `npx` directly, use `{ "command": "cmd", "args": ["/c", "npx", "-y", "memory7"] }` (`init` does this for you). With a global install (`npm i -g memory7`) `init` points at the `memory7` binary instead of `npx`, which starts faster.

## CLI

```
memory7 init | uninstall [--ide ...] [--project] [--no-hooks] [--dry-run]
memory7 doctor                      check Node, SQLite, database, sharing and IDE setup
memory7 rules                       print the rule text for any IDE's instructions
memory7 context [--budget N]        the session digest
memory7 search <query> [--scope S] [--type T] [--limit N]
memory7 add <text> [--global] [--key K] [--type T]
memory7 ls | rm <id|key> | undo <id> | pin <id> | unpin <id>
memory7 sync                        pull/push .memory/memory.jsonl now (normally automatic)
memory7 private <id> | unprivate <id>   keep a memory out of the repo / share it again
memory7 verify <id>                 re-confirm a memory against the current code
memory7 check [--strict]            list memories whose files changed or vanished
memory7 capture [--force]           re-detect stack and commands
memory7 export | import <file>      personal backup as JSONL
memory7 gc | projects
```

## Data, privacy, configuration

- Everything private lives in `~/.memory7/memory7.db` (override with `MEMORY7_HOME`). One file, WAL mode, safe with several IDEs open at once.
- Nothing leaves your machine except what you commit in `.memory/`. There is no telemetry.
- Saves are rejected if they look like credentials (cloud/API keys, tokens, JWTs, private keys, passwords, credentials in URLs, high-entropy strings). The model is told why and can save a redacted version.
- `~/.memory7/config.json` (optional): `{ "budget": 400, "sync": true }`.
- Env: `MEMORY7_HOME`, `MEMORY7_PROJECT` (force the workspace path), `MEMORY7_NO_SYNC=1`.

## Platforms

Written for macOS, Linux and Windows: paths go through Node's `path` module, anchors use `/` in the shared file, line endings are normalized for hashing and the shared file is forced to LF, Windows launch commands use `cmd /c`, and file replacement retries when Windows holds a file open. The test suite and the packed-tarball smoke test run on all three in GitHub Actions (`.github/workflows/ci.yml`). Linux was exercised directly during development; treat macOS and Windows as verified only once that workflow is green.

## Known limits

- Local IDEs only. ChatGPT needs a remote HTTP server and is not supported.
- Whether the AI saves and updates on its own depends on the model following the instructions. Hooks, auto-anchoring and passive capture reduce that dependence but do not remove it.
- A memory that names no file cannot go stale automatically.
- The fast path trusts an unchanged file modification time; a content change that preserves the mtime is not noticed until the mtime moves.
- VS Code gets no user-level rules file from `init`; use `--project` (AGENTS.md) or paste the output of `memory7 rules`.
- OpenCode's config format changed across versions, so `init` uses the `opencode` CLI when available and otherwise prints a snippet.
- No semantic embeddings in v0.1. Synonyms and fuzzy matching cover common cases, not arbitrary paraphrase.

## Development

```bash
npm install
npm run typecheck && npm test      # 119 tests, including a real MCP client over stdio and a two-person git workflow
npm run build                      # bundles to dist/
npm run bench                      # 10k-memory latency benchmark
```
