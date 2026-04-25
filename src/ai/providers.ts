import { execa, execaCommand } from 'execa';
import { z } from 'zod';
import type { AiProvider, AiRequest, AiResponse } from '../types.js';

const openAiResponseSchema = z.object({
  output_text: z.string().optional(),
  output: z.array(z.unknown()).optional()
});

const anthropicResponseSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }))
});

export async function resolveAiProvider(env: NodeJS.ProcessEnv = process.env): Promise<AiProvider> {
  if (env.VIBIN_MOCK_AI_RESPONSE) {
    return new StaticAiProvider(env.VIBIN_MOCK_AI_RESPONSE);
  }

  const providers: AiProvider[] = [];

  if (await commandWorks('copilot', ['--version'])) {
    providers.push(new CopilotCliProvider('copilot'));
  } else if (await commandWorks('gh', ['copilot', '--help'])) {
    providers.push(new GitHubCopilotCliProvider());
  }

  if (env.OPENAI_API_KEY) {
    providers.push(new OpenAiProvider(env.OPENAI_API_KEY, env.OPENAI_MODEL));
  }

  if (env.ANTHROPIC_API_KEY) {
    providers.push(new AnthropicProvider(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL));
  }

  if (providers.length === 0) {
    throw new Error('No AI backend found. Install the Copilot CLI, or set OPENAI_API_KEY or ANTHROPIC_API_KEY.');
  }

  return providers.length === 1 ? providers[0]! : new FallbackAiProvider(providers);
}

async function commandWorks(file: string, args: string[]): Promise<boolean> {
  try {
    const result = await execa(file, args, { reject: false, timeout: 5_000 });
    return result.exitCode === 0;
  } catch {
    return false;
  }
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
        return await provider.generateText(request);
      } catch (error) {
        errors.push(`${provider.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(`All AI backends failed. ${errors.join('; ')}`);
  }
}

class CopilotCliProvider implements AiProvider {
  name = 'copilot-cli';

  constructor(private readonly executable: string) {}

  async generateText(request: AiRequest): Promise<AiResponse> {
    const prompt = formatPrompt(request);
    const attempts = [
      [this.executable, ['ask', prompt]],
      [this.executable, ['prompt', prompt]],
      [this.executable, ['--prompt', prompt]]
    ] as const;

    for (const [file, args] of attempts) {
      const result = await execa(file, args, { reject: false, timeout: 120_000 });
      if (result.exitCode === 0 && result.stdout.trim()) {
        return { provider: this.name, text: result.stdout.trim() };
      }
    }

    throw new Error('Installed Copilot CLI did not accept a non-interactive prompt.');
  }
}

class GitHubCopilotCliProvider implements AiProvider {
  name = 'gh-copilot';

  async generateText(request: AiRequest): Promise<AiResponse> {
    const result = await execa('gh', ['copilot', 'explain', formatPrompt(request)], {
      reject: false,
      timeout: 120_000
    });

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
    private readonly model = 'gpt-4.1-mini'
  ) {}

  async generateText(request: AiRequest): Promise<AiResponse> {
    const response = await fetch('https://api.openai.com/v1/responses', {
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
    });

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
    private readonly model = 'claude-3-5-haiku-latest'
  ) {}

  async generateText(request: AiRequest): Promise<AiResponse> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
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
    });

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
