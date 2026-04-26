import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadLocalCredentials, saveLocalCredential } from '../src/ai/credentials.js';

describe('local AI credentials', () => {
  it('stores API keys in a user-selected local file with restrictive permissions', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibin-credentials-test-'));
    const credentialsPath = path.join(dir, 'credentials.json');

    await saveLocalCredential('openai', 'placeholder-openai-credential', credentialsPath);

    await expect(loadLocalCredentials(credentialsPath)).resolves.toEqual({ openaiApiKey: 'placeholder-openai-credential' });
    const stat = await fs.stat(credentialsPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('rejects empty API keys instead of writing a credential file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibin-credentials-test-'));
    const credentialsPath = path.join(dir, 'credentials.json');

    await expect(saveLocalCredential('anthropic', '   ', credentialsPath)).rejects.toThrow(/cannot be empty/);
    await expect(fs.access(credentialsPath)).rejects.toThrow();
  });
});
