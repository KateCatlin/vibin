import { setTimeout as delay } from 'node:timers/promises';
import { execaCommand } from 'execa';

export async function withApp<T>(
  options: { cwd: string; url?: string; startCommand?: string; timeoutMs?: number },
  callback: (url: string) => Promise<T>
): Promise<T> {
  const url = options.url ?? 'http://localhost:3000';
  let child: ReturnType<typeof execaCommand> | undefined;

  try {
    if (options.startCommand) {
      child = execaCommand(options.startCommand, {
        cwd: options.cwd,
        reject: false,
        stdout: 'pipe',
        stderr: 'pipe'
      });
    }

    await waitForUrl(url, options.timeoutMs ?? 60_000);
    return await callback(url);
  } finally {
    if (child?.pid && !child.killed) {
      child.kill('SIGTERM');
    }
  }
}

export async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  let lastError = '';

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status < 500) {
        return;
      }

      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await delay(750);
  }

  throw new Error(`Timed out waiting for ${url}. Last error: ${lastError}`);
}
