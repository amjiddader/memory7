import { MARK_END, MARK_START, RULES } from './rules.js';

/** Short block placed in AGENTS.md / CLAUDE.md / Kiro steering / Cursor rules of a project that shares memory. */
export function projectRules(): string {
  return `${RULES}\n\nShared project memory lives in .memory/memory.jsonl. Setup and update triggers: MEMORY.md (read it if the memory7 tools are missing).`;
}

export function projectBlock(): string {
  return `${MARK_START}\n## memory7\n${projectRules()}\n${MARK_END}`;
}

/** The human + agent guide committed at the repo root. Lives between markers so people can add their own text around it. */
export function memoryMdBlock(): string {
  return `${MARK_START}
# Project memory (memory7)

This repository shares its AI memory through [memory7](https://www.npmjs.com/package/memory7).
Shared memories are stored in \`.memory/memory.jsonl\` (one JSON object per line, committed to git). When you open the
project in an AI tool that has memory7 installed, it loads them automatically and keeps them up to date.

## Set up (once per machine)

Needs Node.js 22.13 or newer. Works on macOS, Linux and Windows.

\`\`\`bash
npm install -g memory7
memory7 init        # configures Claude Code, Kiro, VS Code, Cursor and OpenCode, whichever are installed
memory7 doctor      # checks the setup
\`\`\`

- No global install: \`npx -y memory7 init\` works too, but IDEs start the server more slowly.
- Windows: run the same commands in PowerShell, Command Prompt or Git Bash.
- Restart your IDE after \`memory7 init\`.
- Not installing memory7? An AI tool can still read \`.memory/memory.jsonl\`; it is plain text.

## Rules for AI agents

${RULES}

### When to update memory

| Moment | Do |
|---|---|
| Session start | \`memory_context\`. Check the \`stale:\` line and verify those memories. |
| The user states a preference, decision or convention | \`memory_save\` right then. |
| You find a gotcha, or a command that works | \`memory_save\` with a stable \`key\` (\`test-cmd\`, \`db\`, \`deploy\`). |
| You finish a feature, fix or refactor | Save the decision or gotcha it produced. Update or delete memories describing code you changed. |
| A memory is flagged \`?stale\` or \`?missing\` | Read the code, then \`memory_save id=N\` with new text, \`memory_save id=N\` with no content if it is still true, or \`memory_delete\`. |
| Before your final answer | Ask: did this change anything a future session needs to know? |

Memories that name a file (for example \`src/auth.ts\`) are tracked against it automatically and flagged when it changes.

## How shared memory works

- Memories you or your AI save for this project are written to \`.memory/memory.jsonl\`; commit it with your code.
- After \`git pull\`, new and changed memories are picked up automatically (no command needed).
- Concurrent additions merge cleanly (\`.memory/.gitattributes\` uses git's union merge). The newest edit of a memory wins; deletes are propagated.
- Keep a memory off the repo: \`memory7 private <id>\`. Global memory (your own preferences) is never written here.
- Never save secrets. The tool refuses obvious ones, but review memory changes in pull requests like any other change.
- Check for memories that no longer match the code: \`memory7 check\` (add \`--strict\` to fail a CI job).
${MARK_END}`;
}

export const MEMORY_MD_HEADER = '';
