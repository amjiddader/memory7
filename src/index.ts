/**
 * Entry point.
 *  - launched by an IDE (no args, stdin is a pipe): run the MCP server over stdio
 *  - anything else: CLI
 * Heavy modules are imported lazily so hooks and CLI calls do not pay for the MCP SDK.
 */
const args = process.argv.slice(2);

async function main(): Promise<void> {
  if (args.length === 0 && !process.stdin.isTTY) {
    const { runServer } = await import('./server.js');
    await runServer();
    return;
  }
  const { runCli } = await import('./cli/index.js');
  let code = 0;
  try {
    code = await runCli(args);
  } catch (e) {
    process.stderr.write(`memory7: ${(e as Error).message}\n`);
    code = 1;
  }
  if (code >= 0) process.exit(code);
}

main().catch((e) => {
  process.stderr.write(`memory7: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
