#!/usr/bin/env node
import { Command } from 'commander';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { exitCodeForResult } from './reporting/markdown.js';
import { runCheck } from './commands/check.js';
import { runSecurity } from './commands/security.js';
import { runUi } from './commands/ui.js';
import { runUsers } from './commands/users.js';
import { createProgressReporter } from './progress.js';
import { renderCliError, renderTerminalMarkdown } from './terminal.js';
import type { CheckResult, RunContext } from './types.js';

export function createProgram(env: NodeJS.ProcessEnv = process.env): Command {
  const program = new Command();

  program
    .name('vibin')
    .description('A pre-launch sanity checker for vibe coders who want a safety net before going live.')
    .version('0.1.0')
    .option('--cwd <path>', 'project directory to check', process.cwd())
    .option('--quiet', 'hide progress messages')
    .option('--no-color', 'disable colorized terminal output');

  program
    .command('security')
    .description('Run an AI-powered security review of the current project.')
    .option('-o, --output <path>', 'write the markdown report to a file')
    .action(async (options) => {
      await handleCommand(program, env, 'security', async (context, printMarkdown) => {
        const { result, markdown } = await runSecurity(context, options);
        printMarkdown(markdown);
        return result;
      });
    });

  program
    .command('ui')
    .description('Review the app UI for beauty, modernity, simplicity, and consistency.')
    .option('--url <url>', 'running app URL to review (default: http://localhost:3000)')
    .option('--start-command <command>', 'command used to start this project before reviewing')
    .option('-o, --output <path>', 'write the markdown report to a file')
    .action(async (options) => {
      await handleCommand(program, env, 'ui', async (context, printMarkdown) => {
        const { result, markdown } = await runUi(context, options);
        printMarkdown(markdown);
        return result;
      });
    });

  program
    .command('users')
    .description('Launch a fake-user browser session that tries to complete a real goal.')
    .option('--url <url>', 'running app URL to test (default: http://localhost:3000)')
    .option('--start-command <command>', 'command used to start this project before testing')
    .option('--goal <goal>', 'user goal to attempt', 'understand the product and complete the primary call to action')
    .option('-o, --output <path>', 'write the markdown report to a file')
    .action(async (options) => {
      await handleCommand(program, env, 'users', async (context, printMarkdown) => {
        const { result, markdown } = await runUsers(context, options);
        printMarkdown(markdown);
        return result;
      });
    });

  program
    .command('check')
    .description('Run security, ui, and users checks in sequence and produce one pre-launch report.')
    .option('--url <url>', 'running app URL to check (default: http://localhost:3000)')
    .option('--start-command <command>', 'command used to start this project before browser checks')
    .option('--goal <goal>', 'fake-user goal to attempt', 'understand the product and complete the primary call to action')
    .option('-o, --output <path>', 'write the markdown report to a file')
    .action(async (options) => {
      await handleCommand(program, env, 'check', async (context, printMarkdown) => {
        const { result, markdown } = await runCheck(context, options);
        printMarkdown(markdown);
        return result;
      });
    });

  return program;
}

async function handleCommand(
  program: Command,
  env: NodeJS.ProcessEnv,
  commandName: string,
  run: (context: RunContext, printMarkdown: (markdown: string) => void) => Promise<CheckResult>
): Promise<void> {
  const terminalColor = program.opts<{ color?: boolean }>().color === false ? false : undefined;
  try {
    const opts = program.opts<{ cwd: string; quiet?: boolean; color?: boolean }>();
    const progress = createProgressReporter({ enabled: !opts.quiet, env, color: terminalColor });
    progress?.info(`Starting ${commandName} in ${opts.cwd}.`);
    const printMarkdown = (markdown: string) => {
      process.stdout.write(renderTerminalMarkdown(markdown, { env, stream: process.stdout, color: terminalColor }));
    };
    const result = await run({ cwd: opts.cwd, env, progress }, printMarkdown);
    progress?.info(`${commandName} finished with ${result.status.toUpperCase()}.`);
    process.exitCode = exitCodeForResult(result);
  } catch (error) {
    console.error(renderCliError(error instanceof Error ? error.message : String(error), { env, stream: process.stderr, color: terminalColor }));
    process.exitCode = 2;
  }
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  await createProgram().parseAsync(process.argv);
}
