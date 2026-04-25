#!/usr/bin/env node
import { Command } from 'commander';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { exitCodeForResult } from './reporting/markdown.js';
import { runCheck } from './commands/check.js';
import { runSecurity } from './commands/security.js';
import { runUi } from './commands/ui.js';
import { runUsers } from './commands/users.js';
import type { RunContext } from './types.js';

export function createProgram(env: NodeJS.ProcessEnv = process.env): Command {
  const program = new Command();

  program
    .name('vibin')
    .description('A pre-launch sanity checker for vibe coders who want a safety net before going live.')
    .version('0.1.0')
    .option('--cwd <path>', 'project directory to check', process.cwd());

  program
    .command('security')
    .description('Run an AI-powered security review of the current project.')
    .option('-o, --output <path>', 'write the markdown report to a file')
    .action(async (options) => {
      await handleCommand(program, env, async (context) => {
        const { result, markdown } = await runSecurity(context, options);
        console.log(markdown);
        return result;
      });
    });

  program
    .command('ui')
    .description('Review the app UI for beauty, modernity, simplicity, and consistency.')
    .option('--url <url>', 'running app URL', 'http://localhost:3000')
    .option('--start-command <command>', 'command used to start the app before reviewing')
    .option('-o, --output <path>', 'write the markdown report to a file')
    .action(async (options) => {
      await handleCommand(program, env, async (context) => {
        const { result, markdown } = await runUi(context, options);
        console.log(markdown);
        return result;
      });
    });

  program
    .command('users')
    .description('Launch a fake-user browser session that tries to complete a real goal.')
    .option('--url <url>', 'running app URL', 'http://localhost:3000')
    .option('--start-command <command>', 'command used to start the app before testing')
    .option('--goal <goal>', 'user goal to attempt', 'understand the product and complete the primary call to action')
    .option('-o, --output <path>', 'write the markdown report to a file')
    .action(async (options) => {
      await handleCommand(program, env, async (context) => {
        const { result, markdown } = await runUsers(context, options);
        console.log(markdown);
        return result;
      });
    });

  program
    .command('check')
    .description('Run security, ui, and users checks in sequence and produce one pre-launch report.')
    .option('--url <url>', 'running app URL', 'http://localhost:3000')
    .option('--start-command <command>', 'command used to start the app before browser checks')
    .option('--goal <goal>', 'fake-user goal to attempt', 'understand the product and complete the primary call to action')
    .option('-o, --output <path>', 'write the markdown report to a file')
    .action(async (options) => {
      await handleCommand(program, env, async (context) => {
        const { result, markdown } = await runCheck(context, options);
        console.log(markdown);
        return result;
      });
    });

  return program;
}

async function handleCommand(
  program: Command,
  env: NodeJS.ProcessEnv,
  run: (context: RunContext) => Promise<{ status: string }>
): Promise<void> {
  try {
    const opts = program.opts<{ cwd: string }>();
    const result = await run({ cwd: opts.cwd, env });
    process.exitCode = exitCodeForResult(result as Parameters<typeof exitCodeForResult>[0]);
  } catch (error) {
    console.error(`vibin failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  await createProgram().parseAsync(process.argv);
}
