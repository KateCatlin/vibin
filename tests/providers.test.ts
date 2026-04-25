import { describe, expect, it } from 'vitest';
import { resolveAiProvider } from '../src/ai/providers.js';

describe('resolveAiProvider', () => {
  it('supports a mock provider for deterministic tests', async () => {
    const provider = await resolveAiProvider({ VIBIN_MOCK_AI_RESPONSE: 'ok' });
    await expect(provider.generateText({ system: 'x', prompt: 'y' })).resolves.toEqual({ provider: 'mock', text: 'ok' });
  });
});
