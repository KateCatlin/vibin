import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export type ApiKeyProvider = 'openai' | 'anthropic';

const credentialsSchema = z
  .object({
    openaiApiKey: z.string().min(1).optional(),
    anthropicApiKey: z.string().min(1).optional()
  })
  .strict();

export type LocalAiCredentials = z.infer<typeof credentialsSchema>;

export function defaultCredentialsPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.VIBIN_CONFIG_DIR) {
    return path.join(env.VIBIN_CONFIG_DIR, 'credentials.json');
  }

  if (platform === 'win32' && env.APPDATA) {
    return path.join(env.APPDATA, 'vibin', 'credentials.json');
  }

  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'vibin', 'credentials.json');
  }

  return path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'vibin', 'credentials.json');
}

export async function loadLocalCredentials(credentialsPath = defaultCredentialsPath()): Promise<LocalAiCredentials> {
  let raw: string;
  try {
    raw = await fs.readFile(credentialsPath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }

  try {
    return credentialsSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(`Local vibin credentials are invalid at ${credentialsPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function saveLocalCredential(provider: ApiKeyProvider, apiKey: string, credentialsPath = defaultCredentialsPath()): Promise<LocalAiCredentials> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    throw new Error('API key cannot be empty.');
  }

  const existing = await loadLocalCredentials(credentialsPath);
  const updated: LocalAiCredentials = {
    ...existing,
    ...(provider === 'openai' ? { openaiApiKey: trimmed } : { anthropicApiKey: trimmed })
  };

  await fs.mkdir(path.dirname(credentialsPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(credentialsPath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(credentialsPath, 0o600);
  return updated;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
