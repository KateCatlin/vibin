import { defaultShellRunner, type ShellRunner } from './shell.js';

export class GitError extends Error {
  constructor(message: string, public readonly stderr?: string, public readonly exitCode?: number | null) {
    super(message);
    this.name = 'GitError';
  }
}

async function run(runner: ShellRunner, file: string, args: readonly string[], cwd: string, timeoutMs = 60_000): Promise<string> {
  const result = await runner(file, args, { cwd, timeout: timeoutMs });
  if (result.exitCode !== 0) {
    throw new GitError(
      `${file} ${args.join(' ')} failed with exit code ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
      result.stderr,
      result.exitCode
    );
  }
  return result.stdout;
}

export async function isGitRepo(cwd: string, runner: ShellRunner = defaultShellRunner): Promise<boolean> {
  const result = await runner('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  return result.exitCode === 0 && result.stdout.trim() === 'true';
}

export async function currentBranch(cwd: string, runner: ShellRunner = defaultShellRunner): Promise<string> {
  return (await run(runner, 'git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim();
}

export async function defaultBranch(cwd: string, runner: ShellRunner = defaultShellRunner): Promise<string> {
  const result = await runner('gh', ['repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'], { cwd, timeout: 15_000 });
  if (result.exitCode === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }
  // Fallback: try `git symbolic-ref refs/remotes/origin/HEAD`
  const fallback = await runner('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd });
  if (fallback.exitCode === 0 && fallback.stdout.trim()) {
    return fallback.stdout.trim().replace(/^refs\/remotes\/origin\//, '');
  }
  return 'main';
}

export async function hasChanges(cwd: string, runner: ShellRunner = defaultShellRunner): Promise<boolean> {
  const result = await runner('git', ['status', '--porcelain'], { cwd });
  if (result.exitCode !== 0) {
    throw new GitError(`git status failed: ${result.stderr.trim()}`, result.stderr, result.exitCode);
  }
  return result.stdout.trim().length > 0;
}

export async function checkoutNewBranch(cwd: string, branch: string, runner: ShellRunner = defaultShellRunner): Promise<void> {
  await run(runner, 'git', ['checkout', '-b', branch], cwd);
}

export async function stageAll(cwd: string, runner: ShellRunner = defaultShellRunner): Promise<void> {
  await run(runner, 'git', ['add', '-A'], cwd);
}

export async function commit(cwd: string, subject: string, body: string | undefined, runner: ShellRunner = defaultShellRunner): Promise<string> {
  const args = ['commit', '-m', subject];
  if (body && body.trim()) {
    args.push('-m', body);
  }
  await run(runner, 'git', args, cwd);
  return (await run(runner, 'git', ['rev-parse', 'HEAD'], cwd)).trim();
}

export async function push(cwd: string, branch: string, runner: ShellRunner = defaultShellRunner): Promise<void> {
  await run(runner, 'git', ['push', '-u', 'origin', branch], cwd, 120_000);
}

export interface PrInfo {
  url: string;
  number: number;
  state: string;
}

export async function prForBranch(cwd: string, branch: string, runner: ShellRunner = defaultShellRunner): Promise<PrInfo | undefined> {
  const result = await runner('gh', ['pr', 'view', branch, '--json', 'url,number,state'], { cwd, timeout: 15_000 });
  if (result.exitCode !== 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(result.stdout) as PrInfo;
    return parsed;
  } catch {
    return undefined;
  }
}

export async function createPr(cwd: string, title: string, body: string, baseBranch: string, runner: ShellRunner = defaultShellRunner): Promise<string> {
  const result = await runner(
    'gh',
    ['pr', 'create', '--title', title, '--body', body, '--base', baseBranch],
    { cwd, timeout: 60_000 }
  );
  if (result.exitCode !== 0) {
    throw new GitError(`gh pr create failed: ${result.stderr.trim() || result.stdout.trim()}`, result.stderr, result.exitCode);
  }
  // gh prints the PR URL on stdout.
  const match = result.stdout.match(/https?:\/\/\S+/);
  return match ? match[0] : result.stdout.trim();
}

export async function openPrInBrowser(cwd: string, branch: string, runner: ShellRunner = defaultShellRunner): Promise<void> {
  const result = await runner('gh', ['pr', 'view', branch, '--web'], { cwd, timeout: 15_000 });
  if (result.exitCode !== 0) {
    throw new GitError(`gh pr view --web failed: ${result.stderr.trim() || result.stdout.trim()}`, result.stderr, result.exitCode);
  }
}

export async function diffAgainst(cwd: string, base: string, runner: ShellRunner = defaultShellRunner): Promise<string> {
  const result = await runner('git', ['diff', `${base}...HEAD`], { cwd, timeout: 30_000 });
  if (result.exitCode !== 0) {
    return '';
  }
  return result.stdout;
}

export async function workingDiff(cwd: string, runner: ShellRunner = defaultShellRunner): Promise<string> {
  const tracked = await runner('git', ['diff', 'HEAD'], { cwd, timeout: 30_000 });
  return tracked.exitCode === 0 ? tracked.stdout : '';
}

export async function cachedDiff(cwd: string, runner: ShellRunner = defaultShellRunner): Promise<string> {
  const result = await runner('git', ['diff', '--cached'], { cwd, timeout: 30_000 });
  return result.exitCode === 0 ? result.stdout : '';
}

export async function lastCommitSubject(cwd: string, runner: ShellRunner = defaultShellRunner): Promise<string> {
  return (await run(runner, 'git', ['log', '-1', '--pretty=%s'], cwd)).trim();
}

export async function logSummary(cwd: string, base: string, runner: ShellRunner = defaultShellRunner): Promise<string> {
  const result = await runner('git', ['log', `${base}..HEAD`, '--pretty=- %s'], { cwd, timeout: 15_000 });
  return result.exitCode === 0 ? result.stdout.trim() : '';
}
