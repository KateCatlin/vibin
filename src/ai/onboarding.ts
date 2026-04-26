import readline from 'node:readline';
import { commandWorks, type CommandRunner } from './commands.js';
import { saveLocalCredential, type ApiKeyProvider } from './credentials.js';
import type { ProgressReporter } from '../types.js';

export type AiOnboardingResult =
  | { type: 'copilot-cli' }
  | { type: 'gh-copilot' }
  | { type: 'openai'; apiKey: string }
  | { type: 'anthropic'; apiKey: string }
  | { type: 'cancel' };

export type PromptInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
};

export type PromptOutput = NodeJS.WritableStream & {
  isTTY?: boolean;
};

export interface AiOnboardingContext {
  commandRunner: CommandRunner;
  credentialsPath?: string;
  input?: PromptInput;
  output?: PromptOutput;
  progress?: ProgressReporter;
}

export function isInteractiveTerminal(input: PromptInput = process.stdin, output: PromptOutput = process.stderr): boolean {
  return input.isTTY === true && output.isTTY === true;
}

export async function runAiOnboarding(context: AiOnboardingContext): Promise<AiOnboardingResult> {
  const input = context.input ?? process.stdin;
  const output = context.output ?? process.stderr;

  output.write(
    [
      '',
      'vibin needs an AI backend to continue.',
      'Recommended: set up GitHub Copilot CLI so vibin can use your Copilot access without storing provider API keys.',
      'vibin will not choose a Copilot model; it uses whatever default your installed Copilot tooling uses.',
      '',
      '1. Set up GitHub Copilot CLI (recommended)',
      '2. Use an OpenAI API key instead',
      '3. Use an Anthropic API key instead',
      '4. Cancel',
      ''
    ].join('\n')
  );

  const choice = await promptLine(input, output, 'Choose an option [1]: ');
  switch ((choice.trim() || '1').toLowerCase()) {
    case '1':
    case 'copilot':
      return setupCopilotCli(context);
    case '2':
    case 'openai':
      return setupApiKey('openai', context);
    case '3':
    case 'anthropic':
      return setupApiKey('anthropic', context);
    default:
      return { type: 'cancel' };
  }
}

async function setupCopilotCli(context: AiOnboardingContext): Promise<AiOnboardingResult> {
  const input = context.input ?? process.stdin;
  const output = context.output ?? process.stderr;

  if (await commandWorks('copilot', ['--version'], context.commandRunner)) {
    output.write('Found copilot CLI.\n');
    return { type: 'copilot-cli' };
  }

  if (await commandWorks('gh', ['copilot', '--help'], context.commandRunner)) {
    output.write('Found GitHub CLI Copilot extension.\n');
    return { type: 'gh-copilot' };
  }

  output.write(
    [
      '',
      'Copilot setup steps:',
      '1. Install GitHub CLI if needed: https://cli.github.com/',
      '2. Authenticate GitHub CLI if needed: gh auth login',
      '3. Install the Copilot extension: gh extension install github/gh-copilot',
      '4. Verify it works: gh copilot --help',
      ''
    ].join('\n')
  );

  if (await commandWorks('gh', ['--version'], context.commandRunner)) {
    const install = await promptLine(input, output, 'Run `gh extension install github/gh-copilot` now? [y/N]: ');
    if (/^y(es)?$/i.test(install.trim())) {
      context.progress?.info('Installing GitHub CLI Copilot extension.');
      const result = await context.commandRunner('gh', ['extension', 'install', 'github/gh-copilot'], { timeout: 120_000 });
      if (result.exitCode !== 0) {
        output.write(
          [
            'GitHub CLI could not install the Copilot extension automatically.',
            result.stderr ? `Last error: ${result.stderr}` : 'Please run the install command manually, then run vibin again.',
            ''
          ].join('\n')
        );
      }
    }
  } else {
    output.write('GitHub CLI is not installed yet. Install it in another terminal, then come back here.\n');
  }

  const ready = await promptLine(input, output, 'Press Enter after Copilot CLI is installed, or type `skip` to use an API key instead: ');
  if (/^skip$/i.test(ready.trim())) {
    return runAiOnboarding(context);
  }

  if (await commandWorks('copilot', ['--version'], context.commandRunner)) {
    return { type: 'copilot-cli' };
  }

  if (await commandWorks('gh', ['copilot', '--help'], context.commandRunner)) {
    return { type: 'gh-copilot' };
  }

  output.write('Copilot CLI is still not callable by vibin.\n');
  const fallback = await promptLine(input, output, 'Use an OpenAI or Anthropic API key instead? [y/N]: ');
  if (/^y(es)?$/i.test(fallback.trim())) {
    return runAiOnboarding(context);
  }

  return { type: 'cancel' };
}

async function setupApiKey(provider: ApiKeyProvider, context: AiOnboardingContext): Promise<AiOnboardingResult> {
  const input = context.input ?? process.stdin;
  const output = context.output ?? process.stderr;
  const label = provider === 'openai' ? 'OpenAI' : 'Anthropic';

  output.write(
    [
      '',
      `${label} API key fallback:`,
      'vibin will store this key only in a user-local config file outside this project.',
      'Do not paste this key into source code, README files, shell history, or committed .env files.',
      ''
    ].join('\n')
  );

  const apiKey = await promptHidden(input, output, `${label} API key: `);
  if (!apiKey.trim()) {
    output.write('No key entered.\n');
    return { type: 'cancel' };
  }

  await saveLocalCredential(provider, apiKey, context.credentialsPath);
  output.write(`${label} key saved locally for vibin.\n`);
  return { type: provider, apiKey: apiKey.trim() };
}

async function promptLine(input: PromptInput, output: PromptOutput, question: string): Promise<string> {
  const rl = readline.createInterface({ input, output, terminal: true });
  try {
    return await new Promise((resolve) => {
      rl.question(question, resolve);
    });
  } finally {
    rl.close();
  }
}

async function promptHidden(input: PromptInput, output: PromptOutput, question: string): Promise<string> {
  output.write(question);

  if (!input.isTTY || !input.setRawMode) {
    return promptLine(input, output, '');
  }

  readline.emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();

  return await new Promise((resolve, reject) => {
    const chars: string[] = [];

    const cleanup = () => {
      input.removeListener('keypress', onKeypress);
      input.setRawMode?.(false);
      output.write('\n');
    };

    const onKeypress = (str: string, key: readline.Key) => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        reject(new Error('API key entry was cancelled.'));
        return;
      }

      if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        resolve(chars.join(''));
        return;
      }

      if (key.name === 'backspace') {
        chars.pop();
        return;
      }

      if (str && !key.ctrl && !key.meta) {
        chars.push(str);
      }
    };

    input.on('keypress', onKeypress);
  });
}
