import { z } from 'zod';
import { commandWorks, defaultCommandRunner, type CommandRunner } from './commands.js';
import { defaultCredentialsPath, loadLocalCredentials, type LocalAiCredentials } from './credentials.js';
import { isInteractiveTerminal, runAiOnboarding, type AiOnboardingResult, type PromptInput, type PromptOutput } from './onboarding.js';
import { withProgressHeartbeat } from '../progress.js';
import type { AiProvider, AiRequest, AiResponse, ProgressReporter } from '../types.js';

export const DEFAULT_OPENAI_MODEL = 'gpt-5.5';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-7';

const openAiResponseSchema = z.object({
  output_text: z.string().optional(),
  output: z.array(z.unknown()).optional()
});

const anthropicResponseSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }))
});

export interface ResolveAiProviderOptions {
  commandRunner?: CommandRunner;
  credentialsPath?: string;
  fetchImpl?: typeof fetch;
  input?: PromptInput;
  isInteractive?: boolean;
  loadCredentials?: () => Promise<LocalAiCredentials>;
  onboarding?: (context: {
    commandRunner: CommandRunner;
    credentialsPath?: string;
    input?: PromptInput;
    output?: PromptOutput;
    progress?: ProgressReporter;
  }) => Promise<AiOnboardingResult>;
  output?: PromptOutput;
}

export async function resolveAiProvider(env: NodeJS.ProcessEnv = process.env, progress?: ProgressReporter, options: ResolveAiProviderOptions = {}): Promise<AiProvider> {
  if (env.VIBIN_MOCK_AI_RESPONSE) {
    progress?.info('Using mock AI backend.');
    return new StaticAiProvider(env.VIBIN_MOCK_AI_RESPONSE);
  }

  const providers: AiProvider[] = [];
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const credentialsPath = options.credentialsPath ?? defaultCredentialsPath(env);
  const fetchImpl = options.fetchImpl ?? fetch;

  progress?.info('Checking for Copilot CLI AI backend.');
  if (await commandWorks('copilot', ['--version'], commandRunner)) {
    providers.push(new CopilotCliProvider('copilot', commandRunner));
  } else {
    progress?.info('Checking for GitHub CLI Copilot extension.');
    if (await commandWorks('gh', ['copilot', '--help'], commandRunner)) {
      providers.push(new GitHubCopilotCliProvider(commandRunner));
    }
  }

  if (env.OPENAI_API_KEY) {
    progress?.info('OpenAI API key found; adding OpenAI backend.');
    providers.push(new OpenAiProvider(env.OPENAI_API_KEY, env.OPENAI_MODEL, fetchImpl));
  }

  if (env.ANTHROPIC_API_KEY) {
    progress?.info('Anthropic API key found; adding Anthropic backend.');
    providers.push(new AnthropicProvider(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL, fetchImpl));
  }

  if (providers.length === 0) {
    const localCredentials = await (options.loadCredentials ?? (() => loadLocalCredentials(credentialsPath)))();
    if (localCredentials.openaiApiKey) {
      progress?.info('Local OpenAI API key found; adding OpenAI backend.');
      providers.push(new OpenAiProvider(localCredentials.openaiApiKey, env.OPENAI_MODEL, fetchImpl));
    }

    if (localCredentials.anthropicApiKey) {
      progress?.info('Local Anthropic API key found; adding Anthropic backend.');
      providers.push(new AnthropicProvider(localCredentials.anthropicApiKey, env.ANTHROPIC_MODEL, fetchImpl));
    }
  }

  if (providers.length === 0) {
    const input = options.input ?? process.stdin;
    const output = options.output ?? process.stderr;
    const interactive = options.isInteractive ?? isInteractiveTerminal(input, output);
    if (!interactive) {
      throw new Error(missingAiBackendMessage());
    }

    const onboarding = options.onboarding ?? runAiOnboarding;
    const result = await onboarding({
      commandRunner,
      credentialsPath,
      input,
      output,
      progress
    });
    const provider = providerFromOnboardingResult(result, env, commandRunner, fetchImpl);
    if (!provider) {
      throw new Error(missingAiBackendMessage());
    }
    progress?.info(`Selected AI backend: ${provider.name}.`);
    return provider;
  }

  const provider = providers.length === 1 ? providers[0]! : new FallbackAiProvider(providers);
  progress?.info(`Selected AI backend: ${provider.name}.`);
  return provider;
}

function providerFromOnboardingResult(result: AiOnboardingResult, env: NodeJS.ProcessEnv, commandRunner: CommandRunner, fetchImpl: typeof fetch): AiProvider | undefined {
  switch (result.type) {
    case 'copilot-cli':
      return new CopilotCliProvider('copilot', commandRunner);
    case 'gh-copilot':
      return new GitHubCopilotCliProvider(commandRunner);
    case 'openai':
      return new OpenAiProvider(result.apiKey, env.OPENAI_MODEL, fetchImpl);
    case 'anthropic':
      return new AnthropicProvider(result.apiKey, env.ANTHROPIC_MODEL, fetchImpl);
    case 'cancel':
      return undefined;
  }
}

function missingAiBackendMessage(): string {
  return [
    'No AI backend found.',
    'Recommended: set up GitHub Copilot CLI, then run vibin again.',
    'Install GitHub CLI from https://cli.github.com/, authenticate with `gh auth login`, then run `gh extension install github/gh-copilot` and verify with `gh copilot --help`.',
    'Alternative: set OPENAI_API_KEY or ANTHROPIC_API_KEY, or run vibin in an interactive terminal to save an API key locally outside your project.'
  ].join(' ');
}

class StaticAiProvider implements AiProvider {
  name = 'mock';

  constructor(private readonly response: string) {}

  async generateText(): Promise<AiResponse> {
    return { provider: this.name, text: this.response };
  }
}

class FallbackAiProvider implements AiProvider {
  name: string;

  constructor(private readonly providers: AiProvider[]) {
    this.name = providers.map((provider) => provider.name).join(' -> ');
  }

  async generateText(request: AiRequest): Promise<AiResponse> {
    const errors: string[] = [];
    for (const provider of this.providers) {
      try {
        request.progress?.info(`Trying AI backend: ${provider.name}.`);
        return await provider.generateText(request);
      } catch (error) {
        request.progress?.info(`AI backend ${provider.name} failed; trying the next backend.`);
        errors.push(`${provider.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(`All AI backends failed. ${errors.join('; ')}`);
  }
}

class CopilotCliProvider implements AiProvider {
  name = 'copilot-cli';

  constructor(
    private readonly executable: string,
    private readonly commandRunner: CommandRunner = defaultCommandRunner
  ) {}

  async generateText(request: AiRequest): Promise<AiResponse> {
    const prompt = formatPrompt(request);
    const attempts = [
      [this.executable, ['ask', prompt]],
      [this.executable, ['prompt', prompt]],
      [this.executable, ['--prompt', prompt]]
    ] as const;

    for (const [index, [file, args]] of attempts.entries()) {
      request.progress?.info(`Calling Copilot CLI (${index + 1}/${attempts.length}).`);
      const result = await withProgressHeartbeat(
        request.progress,
        `Still waiting for Copilot CLI response (${index + 1}/${attempts.length}).`,
        this.commandRunner(file, args, { timeout: 120_000 })
      );
      if (result.exitCode === 0 && result.stdout.trim()) {
        return { provider: this.name, text: result.stdout.trim() };
      }
    }

    throw new Error('Installed Copilot CLI did not accept a non-interactive prompt.');
  }
}

class GitHubCopilotCliProvider implements AiProvider {
  name = 'gh-copilot';

  constructor(private readonly commandRunner: CommandRunner = defaultCommandRunner) {}

  async generateText(request: AiRequest): Promise<AiResponse> {
    request.progress?.info('Calling GitHub CLI Copilot.');
    const result = await withProgressHeartbeat(
      request.progress,
      'Still waiting for GitHub CLI Copilot response.',
      this.commandRunner('gh', ['copilot', 'explain', formatPrompt(request)], { timeout: 120_000 })
    );

    if (result.exitCode !== 0 || !result.stdout.trim()) {
      throw new Error('gh copilot did not return a response for this prompt.');
    }

    return { provider: this.name, text: result.stdout.trim() };
  }
}

class OpenAiProvider implements AiProvider {
  name = 'openai';

  constructor(
    private readonly apiKey: string,
    private readonly model = DEFAULT_OPENAI_MODEL,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async generateText(request: AiRequest): Promise<AiResponse> {
    request.progress?.info(`Calling OpenAI model ${this.model}.`);
    const response = await withProgressHeartbeat(
      request.progress,
      `Still waiting for OpenAI model ${this.model}.`,
      this.fetchImpl('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.model,
          input: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.prompt }
          ],
          text: request.preferJson ? { format: { type: 'json_object' } } : undefined
        })
      })
    );

    if (!response.ok) {
      throw new Error(`OpenAI request failed with HTTP ${response.status}: ${await response.text()}`);
    }

    const parsed = openAiResponseSchema.parse(await response.json());
    return { provider: this.name, text: parsed.output_text ?? JSON.stringify(parsed.output ?? []) };
  }
}

class AnthropicProvider implements AiProvider {
  name = 'anthropic';

  constructor(
    private readonly apiKey: string,
    private readonly model = DEFAULT_ANTHROPIC_MODEL,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async generateText(request: AiRequest): Promise<AiResponse> {
    request.progress?.info(`Calling Anthropic model ${this.model}.`);
    const response = await withProgressHeartbeat(
      request.progress,
      `Still waiting for Anthropic model ${this.model}.`,
      this.fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 4_000,
          system: request.system,
          messages: [{ role: 'user', content: request.prompt }]
        })
      })
    );

    if (!response.ok) {
      throw new Error(`Anthropic request failed with HTTP ${response.status}: ${await response.text()}`);
    }

    const parsed = anthropicResponseSchema.parse(await response.json());
    return {
      provider: this.name,
      text: parsed.content.map((item) => item.text ?? '').join('\n').trim()
    };
  }
}

function formatPrompt(request: AiRequest): string {
  return `${request.system}\n\n${request.prompt}`;
}

export function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error('AI response did not contain a JSON object.');
  }

  return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
}
