import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_READY_TIMEOUT_MS, waitForUrl, withApp } from '../src/browser/app.js';

describe('browser app readiness', () => {
  it('uses a 20 second default readiness timeout', () => {
    expect(DEFAULT_APP_READY_TIMEOUT_MS).toBe(20_000);
  });

  it('resolves when the URL responds below HTTP 500', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));

    await expect(waitForUrl('http://localhost:3000', 100, { fetchImpl })).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('explains when nothing is listening on localhost', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch failed');
    });

    await expect(
      waitForUrl('http://localhost:3000', 1, {
        fetchImpl,
        checkConnection: async () => 'closed'
      })
    ).rejects.toThrow(/nothing seems to be listening on localhost:3000/);
  });

  it('diagnoses repeated HTTP 5xx responses as an unhealthy app', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 503 }));

    await expect(
      waitForUrl('http://localhost:3000', 1, {
        fetchImpl,
        checkConnection: async () => 'open'
      })
    ).rejects.toThrow(/the app answered, but returned HTTP 503/);
  });

  it('suggests a package.json dev script when no start command was provided', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'vibin-app-test-'));
    try {
      await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
      const fetchImpl = vi.fn(async () => {
        throw new Error('fetch failed');
      });

      await expect(
        waitForUrl('http://localhost:5173', 1, {
          cwd,
          commandName: 'check',
          fetchImpl,
          checkConnection: async () => 'closed'
        })
      ).rejects.toThrow(/vibin check --start-command "npm run dev" --url http:\/\/localhost:5173/);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it('refuses to use implicit localhost without a repo-scoped start command', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'vibin-app-test-'));
    try {
      await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));

      await expect(withApp({ cwd, commandName: 'ui' }, async () => undefined)).rejects.toThrow(
        /won't use http:\/\/localhost:3000 automatically.*vibin ui --start-command "npm run dev"/
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it('includes start-command failure context', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch failed');
    });

    await expect(
      waitForUrl('http://localhost:3000', 1, {
        startCommand: 'npm run dev',
        startDiagnostics: {
          command: 'npm run dev',
          exitSummary: () => 'exited with code 1',
          outputTail: () => 'Missing script: dev'
        },
        fetchImpl,
        checkConnection: async () => 'closed'
      })
    ).rejects.toThrow(/Missing script: dev/);
  });
});
