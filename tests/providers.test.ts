import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { CommandRunner } from '../src/ai/commands.js';
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL, resolveAiProvider } from '../src/ai/providers.js';
import type { PromptInput, PromptOutput } from '../src/ai/onboarding.js';

describe('resolveAiProvider', () => {
  it('supports a mock provider for deterministic tests', async () => {
    const provider = await resolveAiProvider({ VIBIN_MOCK_AI_RESPONSE: 'ok' });
    await expect(provider.generateText({ system: 'x', prompt: 'y' })).resolves.toEqual({ provider: 'mock', text: 'ok' });
  });

  it('uses environment API keys before local credentials', async () => {
    const fetchCalls: RequestInit[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      fetchCalls.push(init ?? {});
      return jsonResponse({ output_text: 'ok' });
    };

    const provider = await resolveAiProvider(
      { OPENAI_API_KEY: 'placeholder-env-credential' },
      undefined,
      {
        commandRunner: commandNotFound,
        fetchImpl,
        loadCredentials: async () => {
          throw new Error('local credentials should not be loaded when an env key is configured');
        }
      }
    );

    await expect(provider.generateText({ system: 'system', prompt: 'prompt' })).resolves.toEqual({ provider: 'openai', text: 'ok' });
    expect(fetchCalls[0]?.headers).toMatchObject({ Authorization: 'Bearer placeholder-env-credential' });
  });

  it('defaults local OpenAI credentials to GPT-5.5', async () => {
    const fetchCalls: RequestInit[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      fetchCalls.push(init ?? {});
      return jsonResponse({ output_text: 'ok' });
    };

    const provider = await resolveAiProvider(
      {},
      undefined,
      {
        commandRunner: commandNotFound,
        fetchImpl,
        loadCredentials: async () => ({ openaiApiKey: 'placeholder-openai-credential' }),
        isInteractive: false
      }
    );

    await provider.generateText({ system: 'system', prompt: 'prompt' });
    expect(JSON.parse(String(fetchCalls[0]?.body))).toMatchObject({ model: DEFAULT_OPENAI_MODEL });
    expect(DEFAULT_OPENAI_MODEL).toBe('gpt-5.5');
  });

  it('defaults local Anthropic credentials to Opus 4.7', async () => {
    const fetchCalls: RequestInit[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      fetchCalls.push(init ?? {});
      return jsonResponse({ content: [{ type: 'text', text: 'ok' }] });
    };

    const provider = await resolveAiProvider(
      {},
      undefined,
      {
        commandRunner: commandNotFound,
        fetchImpl,
        loadCredentials: async () => ({ anthropicApiKey: 'placeholder-anthropic-credential' }),
        isInteractive: false
      }
    );

    await provider.generateText({ system: 'system', prompt: 'prompt' });
    expect(JSON.parse(String(fetchCalls[0]?.body))).toMatchObject({ model: DEFAULT_ANTHROPIC_MODEL });
    expect(DEFAULT_ANTHROPIC_MODEL).toBe('claude-opus-4-7');
  });

  it('fails non-interactive missing backend cases with Copilot-first setup instructions', async () => {
    await expect(
      resolveAiProvider(
        {},
        undefined,
        {
          commandRunner: commandNotFound,
          loadCredentials: async () => ({}),
          isInteractive: false
        }
      )
    ).rejects.toThrow(/Recommended: set up GitHub Copilot CLI/);
  });

  it('offers Copilot setup before API-key fallback in the interactive onboarding prompt', async () => {
    const credentialsPath = await tempCredentialsPath();
    const input = promptInput('4\n');
    const { output, chunks } = promptOutput();

    await expect(
      resolveAiProvider(
        {},
        undefined,
        {
          commandRunner: commandNotFound,
          credentialsPath,
          input,
          output,
          loadCredentials: async () => ({}),
          isInteractive: true
        }
      )
    ).rejects.toThrow(/No AI backend found/);

    const rendered = chunks.join('');
    expect(rendered.indexOf('1. Set up GitHub Copilot CLI (recommended)')).toBeLessThan(rendered.indexOf('2. Use an OpenAI API key instead'));
    await expect(fs.access(credentialsPath)).rejects.toThrow();
  });

  it('continues with Copilot after setup without passing a model override', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const commandRunner: CommandRunner = async (file, args) => {
      calls.push({ file, args });
      if (file === 'gh' && args[0] === 'copilot' && args[1] === 'explain') {
        return { exitCode: 0, stdout: 'copilot ok', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: '' };
    };

    const provider = await resolveAiProvider(
      {},
      undefined,
      {
        commandRunner,
        loadCredentials: async () => ({}),
        isInteractive: true,
        onboarding: async () => ({ type: 'gh-copilot' })
      }
    );

    await expect(provider.generateText({ system: 'system', prompt: 'prompt' })).resolves.toEqual({ provider: 'gh-copilot', text: 'copilot ok' });
    const copilotCall = calls.find((call) => call.file === 'gh' && call.args[0] === 'copilot' && call.args[1] === 'explain');
    expect(copilotCall?.args).toEqual(['copilot', 'explain', 'system\n\nprompt']);
    expect(copilotCall?.args.join(' ')).not.toMatch(/\b(model|gpt|claude|opus)\b/i);
  });
});

const commandNotFound: CommandRunner = async () => ({ exitCode: 1, stdout: '', stderr: '' });

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function promptInput(text: string): PromptInput {
  const input = Readable.from([text]) as PromptInput;
  input.isTTY = true;
  return input;
}

function promptOutput(): { output: PromptOutput; chunks: string[] } {
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    }
  }) as PromptOutput;
  output.isTTY = true;
  return { output, chunks };
}

async function tempCredentialsPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibin-credentials-test-'));
  return path.join(dir, 'credentials.json');
}
