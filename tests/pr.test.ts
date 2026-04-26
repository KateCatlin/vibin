import { describe, expect, it, vi } from 'vitest';
import { runPr } from '../src/commands/pr.js';
import type { ShellResult, ShellRunner } from '../src/utils/shell.js';
import type { AiProvider, AiResponse, RunContext } from '../src/types.js';

interface ScriptedCall {
  match: (file: string, args: readonly string[]) => boolean;
  result: ShellResult | ((file: string, args: readonly string[]) => ShellResult);
}

function makeRunner(script: ScriptedCall[]) {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const runner: ShellRunner = async (file, args) => {
    calls.push({ file, args: [...args] });
    for (const entry of script) {
      if (entry.match(file, args)) {
        return typeof entry.result === 'function' ? entry.result(file, args) : entry.result;
      }
    }
    throw new Error(`Unscripted command: ${file} ${args.join(' ')}`);
  };
  return { runner, calls };
}

const ok = (stdout = ''): ShellResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (stderr = 'failed', exitCode = 1): ShellResult => ({ exitCode, stdout: '', stderr });

const mockProvider = (text: string): AiProvider => ({
  name: 'mock',
  async generateText(): Promise<AiResponse> {
    return { provider: 'mock', text };
  }
});

const baseContext = (): RunContext => ({ cwd: '/tmp/repo', env: {}, progress: undefined });

const baseScript = (extra: ScriptedCall[] = []): ScriptedCall[] => [
  { match: (f, a) => f === 'git' && a[0] === 'rev-parse' && a[1] === '--is-inside-work-tree', result: ok('true\n') },
  { match: (f, a) => f === 'git' && a[0] === 'status' && a[1] === '--porcelain', result: ok(' M src/foo.ts\n') },
  { match: (f, a) => f === 'git' && a[0] === 'rev-parse' && a[1] === '--abbrev-ref', result: ok('main\n') },
  { match: (f, a) => f === 'gh' && a[0] === 'repo' && a[1] === 'view', result: ok('main\n') },
  ...extra
];

describe('runPr', () => {
  it('aborts when there are no changes', async () => {
    const { runner } = makeRunner([
      { match: (f, a) => f === 'git' && a[0] === 'rev-parse' && a[1] === '--is-inside-work-tree', result: ok('true\n') },
      { match: (f, a) => f === 'git' && a[0] === 'status', result: ok('') }
    ]);
    await expect(runPr(baseContext(), {}, { shellRunner: runner })).rejects.toThrow(/no changes/i);
  });

  it('aborts when not in a git repo', async () => {
    const { runner } = makeRunner([
      { match: (f, a) => f === 'git' && a[0] === 'rev-parse' && a[1] === '--is-inside-work-tree', result: fail('not a git repo', 128) }
    ]);
    await expect(runPr(baseContext(), {}, { shellRunner: runner })).rejects.toThrow(/Not a git repository/);
  });

  it('requires --message when AI is disabled', async () => {
    const { runner } = makeRunner(baseScript([
      { match: (f, a) => f === 'git' && a[0] === 'checkout' && a[1] === '-b', result: ok('') }
    ]));
    await expect(
      runPr(baseContext(), { ai: false, branch: 'feat/x' }, { shellRunner: runner })
    ).rejects.toThrow(/AI is disabled/);
  });

  it('on default branch creates a new branch with explicit --branch and --message, pushes, opens PR', async () => {
    const events: string[] = [];
    const { runner, calls } = makeRunner(baseScript([
      {
        match: (f, a) => f === 'git' && a[0] === 'checkout' && a[1] === '-b',
        result: (_f, a) => {
          events.push(`checkout:${a[2]}`);
          return ok('');
        }
      },
      { match: (f, a) => f === 'git' && a[0] === 'add' && a[1] === '-A', result: ok('') },
      {
        match: (f, a) => f === 'git' && a[0] === 'commit',
        result: (_f, a) => {
          events.push(`commit:${a.join(' ')}`);
          return ok('');
        }
      },
      { match: (f, a) => f === 'git' && a[0] === 'rev-parse' && a[1] === 'HEAD', result: ok('abc1234567890\n') },
      {
        match: (f, a) => f === 'git' && a[0] === 'push',
        result: (_f, a) => {
          events.push(`push:${a.join(' ')}`);
          return ok('');
        }
      },
      { match: (f, a) => f === 'gh' && a[0] === 'pr' && a[1] === 'view', result: fail('no PR', 1) },
      { match: (f, a) => f === 'git' && a[0] === 'diff', result: ok('diff content') },
      { match: (f, a) => f === 'git' && a[0] === 'log', result: ok('- subject') },
      {
        match: (f, a) => f === 'gh' && a[0] === 'pr' && a[1] === 'create',
        result: (_f, a) => {
          events.push(`pr-create:${a.join(' ')}`);
          return ok('https://github.com/owner/repo/pull/42\n');
        }
      }
    ]));

    const { result } = await runPr(
      baseContext(),
      { branch: 'feat/explicit', message: 'feat: do the thing', ai: false },
      { shellRunner: runner }
    );

    expect(result.status).toBe('pass');
    expect(events).toEqual(expect.arrayContaining([
      'checkout:feat/explicit',
      expect.stringMatching(/^commit:commit -m feat: do the thing -m Co-authored-by/),
      'push:push -u origin feat/explicit'
    ]));
    expect(events.some((event) => event.startsWith('pr-create:'))).toBe(true);
    // gh pr create call should include the explicit subject as title.
    const prCreateCall = calls.find((call) => call.file === 'gh' && call.args[0] === 'pr' && call.args[1] === 'create');
    expect(prCreateCall?.args).toEqual(expect.arrayContaining(['--title', 'feat: do the thing', '--base', 'main']));
  });

  it('on a feature branch with an existing open PR only pushes (no gh pr create)', async () => {
    const created: string[] = [];
    const { runner } = makeRunner([
      { match: (f, a) => f === 'git' && a[0] === 'rev-parse' && a[1] === '--is-inside-work-tree', result: ok('true\n') },
      { match: (f, a) => f === 'git' && a[0] === 'status', result: ok(' M src/foo.ts\n') },
      { match: (f, a) => f === 'git' && a[0] === 'rev-parse' && a[1] === '--abbrev-ref', result: ok('feat/already\n') },
      { match: (f, a) => f === 'gh' && a[0] === 'repo' && a[1] === 'view', result: ok('main\n') },
      { match: (f, a) => f === 'git' && a[0] === 'add' && a[1] === '-A', result: ok('') },
      { match: (f, a) => f === 'git' && a[0] === 'commit', result: ok('') },
      { match: (f, a) => f === 'git' && a[0] === 'rev-parse' && a[1] === 'HEAD', result: ok('deadbee\n') },
      { match: (f, a) => f === 'git' && a[0] === 'push', result: ok('') },
      {
        match: (f, a) => f === 'gh' && a[0] === 'pr' && a[1] === 'view',
        result: ok(JSON.stringify({ url: 'https://github.com/o/r/pull/9', number: 9, state: 'OPEN' }))
      },
      {
        match: (f, a) => f === 'gh' && a[0] === 'pr' && a[1] === 'create',
        result: (_f, a) => {
          created.push(a.join(' '));
          return ok('should not run');
        }
      }
    ]);

    const { result } = await runPr(
      baseContext(),
      { message: 'fix: bug', ai: false },
      { shellRunner: runner }
    );

    expect(created).toEqual([]);
    expect(result.sections[0]?.body).toContain('updated existing');
    expect(result.sections[0]?.body).toContain('https://github.com/o/r/pull/9');
  });

  it('--open opens the created PR in the browser through gh', async () => {
    const { runner, calls } = makeRunner(baseScript([
      { match: (f, a) => f === 'git' && a[0] === 'checkout' && a[1] === '-b', result: ok('') },
      { match: (f, a) => f === 'git' && a[0] === 'add' && a[1] === '-A', result: ok('') },
      { match: (f, a) => f === 'git' && a[0] === 'commit', result: ok('') },
      { match: (f, a) => f === 'git' && a[0] === 'rev-parse' && a[1] === 'HEAD', result: ok('abc1234567890\n') },
      { match: (f, a) => f === 'git' && a[0] === 'push', result: ok('') },
      { match: (f, a) => f === 'gh' && a[0] === 'pr' && a[1] === 'view' && !a.includes('--web'), result: fail('no PR', 1) },
      { match: (f, a) => f === 'git' && a[0] === 'diff', result: ok('diff content') },
      { match: (f, a) => f === 'git' && a[0] === 'log', result: ok('- subject') },
      { match: (f, a) => f === 'gh' && a[0] === 'pr' && a[1] === 'create', result: ok('https://github.com/owner/repo/pull/42\n') },
      { match: (f, a) => f === 'gh' && a[0] === 'pr' && a[1] === 'view' && a.includes('--web'), result: ok('') }
    ]));

    const { result } = await runPr(
      baseContext(),
      { branch: 'feat/open', message: 'feat: open pr', ai: false, open: true },
      { shellRunner: runner }
    );

    expect(calls.map((call) => `${call.file} ${call.args.join(' ')}`)).toContain('gh pr view feat/open --web');
    expect(result.sections[0]?.body).toContain('Browser: opened PR in browser.');
  });

  it('uses the resolved AI provider for commit message and PR body when --message is omitted', async () => {
    const provider = mockProvider(JSON.stringify({ subject: 'feat(api): add endpoint', body: 'Adds /v2/things.' }));
    const resolveAi = vi.fn(async () => provider);

    const { runner } = makeRunner(baseScript([
      { match: (f, a) => f === 'git' && a[0] === 'diff', result: ok('+ added\n') },
      { match: (f, a) => f === 'git' && a[0] === 'checkout' && a[1] === '-b', result: ok('') },
      { match: (f, a) => f === 'git' && a[0] === 'add' && a[1] === '-A', result: ok('') },
      { match: (f, a) => f === 'git' && a[0] === 'commit', result: ok('') },
      { match: (f, a) => f === 'git' && a[0] === 'rev-parse' && a[1] === 'HEAD', result: ok('1234567890ab\n') },
      { match: (f, a) => f === 'git' && a[0] === 'push', result: ok('') },
      { match: (f, a) => f === 'gh' && a[0] === 'pr' && a[1] === 'view', result: fail('no PR', 1) },
      { match: (f, a) => f === 'git' && a[0] === 'log', result: ok('- subject') },
      {
        match: (f, a) => f === 'gh' && a[0] === 'pr' && a[1] === 'create',
        result: ok('https://github.com/o/r/pull/1\n')
      }
    ]));

    const { result } = await runPr(
      { cwd: '/tmp/repo', env: { OPENAI_API_KEY: 'k' } },
      { branch: 'feat/auto' },
      { shellRunner: runner, resolveAi: resolveAi as unknown as typeof import('../src/ai/providers.js').resolveAiProvider }
    );

    expect(resolveAi).toHaveBeenCalled();
    expect(result.sections[0]?.body).toContain('feat(api): add endpoint');
    expect(result.sections[0]?.body).toContain('AI backend: mock');
  });

  it('--no-push skips push and PR steps', async () => {
    const { runner, calls } = makeRunner(baseScript([
      { match: (f, a) => f === 'git' && a[0] === 'checkout' && a[1] === '-b', result: ok('') },
      { match: (f, a) => f === 'git' && a[0] === 'add' && a[1] === '-A', result: ok('') },
      { match: (f, a) => f === 'git' && a[0] === 'commit', result: ok('') },
      { match: (f, a) => f === 'git' && a[0] === 'rev-parse' && a[1] === 'HEAD', result: ok('abc\n') }
    ]));

    const { result } = await runPr(
      baseContext(),
      { message: 'chore: x', ai: false, branch: 'feat/np', push: false },
      { shellRunner: runner }
    );

    expect(calls.some((c) => c.file === 'git' && c.args[0] === 'push')).toBe(false);
    expect(calls.some((c) => c.file === 'gh' && c.args[0] === 'pr')).toBe(false);
    expect(result.summary).toMatch(/push skipped/i);
  });

  it('--dry-run performs no git/gh writes', async () => {
    const writes: string[] = [];
    const { runner } = makeRunner([
      { match: (f, a) => f === 'git' && a[0] === 'rev-parse' && a[1] === '--is-inside-work-tree', result: ok('true\n') },
      { match: (f, a) => f === 'git' && a[0] === 'status', result: ok(' M f\n') },
      { match: (f, a) => f === 'git' && a[0] === 'rev-parse' && a[1] === '--abbrev-ref', result: ok('main\n') },
      { match: (f, a) => f === 'gh' && a[0] === 'repo' && a[1] === 'view', result: ok('main\n') },
      {
        match: (f, a) => ['add', 'commit', 'push', 'checkout'].includes(String(a[0])) && f === 'git',
        result: (_f, a) => {
          writes.push(`git ${a.join(' ')}`);
          return ok('');
        }
      },
      {
        match: (f, a) => f === 'gh' && (a[0] === 'pr'),
        result: (_f, a) => {
          writes.push(`gh ${a.join(' ')}`);
          return ok('');
        }
      }
    ]);

    await runPr(
      baseContext(),
      { message: 'chore: dry', ai: false, branch: 'feat/dry', dryRun: true },
      { shellRunner: runner }
    );

    expect(writes).toEqual([]);
  });
});
