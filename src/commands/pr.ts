import { z } from 'zod';
import { resolveAiProvider } from '../ai/providers.js';
import { renderCheckResult, writeReport } from '../reporting/markdown.js';
import type { AiProvider, CheckResult, RunContext } from '../types.js';
import {
  cachedDiff,
  checkoutNewBranch,
  commit,
  createPr,
  currentBranch,
  defaultBranch,
  diffAgainst,
  hasChanges,
  isGitRepo,
  lastCommitSubject,
  logSummary,
  prForBranch,
  push,
  stageAll,
  workingDiff
} from '../utils/git.js';
import { defaultShellRunner, type ShellRunner } from '../utils/shell.js';

const COAUTHOR_TRAILER = 'Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>';

export interface PrOptions {
  output?: string;
  message?: string;
  branch?: string;
  push?: boolean;
  ai?: boolean;
  dryRun?: boolean;
}

export interface PrCommandDeps {
  shellRunner?: ShellRunner;
  resolveAi?: typeof resolveAiProvider;
}

export async function runPr(
  context: RunContext,
  options: PrOptions = {},
  deps: PrCommandDeps = {}
): Promise<{ result: CheckResult; markdown: string }> {
  const startedAt = new Date().toISOString();
  const shouldPush = options.push !== false;
  const allowAi = options.ai !== false;
  const dryRun = options.dryRun === true;
  const runner = deps.shellRunner ?? defaultShellRunner;
  const resolve = deps.resolveAi ?? resolveAiProvider;

  if (!(await isGitRepo(context.cwd, runner))) {
    throw new Error(`Not a git repository: ${context.cwd}`);
  }
  if (!(await hasChanges(context.cwd, runner))) {
    throw new Error('Working tree has no changes to commit.');
  }

  const startingBranch = await currentBranch(context.cwd, runner);
  const baseBranch = await defaultBranch(context.cwd, runner);
  context.progress?.info(`Current branch: ${startingBranch}; default branch: ${baseBranch}.`);

  let aiProvider: AiProvider | undefined;
  const ensureAi = async (): Promise<AiProvider | undefined> => {
    if (!allowAi) return undefined;
    if (aiProvider) return aiProvider;
    try {
      aiProvider = await resolve(context.env, context.progress);
      context.progress?.info(`Using AI backend ${aiProvider.name}.`);
    } catch (error) {
      context.progress?.info(`No AI backend available: ${error instanceof Error ? error.message : String(error)}`);
      aiProvider = undefined;
    }
    return aiProvider;
  };

  let workingBranch = startingBranch;
  if (startingBranch === baseBranch) {
    let branchName = options.branch?.trim();
    if (!branchName) {
      const ai = await ensureAi();
      if (ai) {
        try {
          const diffSnippet = (await workingDiff(context.cwd, runner)).slice(0, 12_000);
          const slugResponse = await ai.generateText({
            system: 'You generate concise git branch names. Output ONLY a short kebab-case slug (lowercase letters, numbers, hyphens), max 40 characters, no quotes, no commentary.',
            prompt: `Suggest a kebab-case branch name slug summarizing these working-tree changes. Respond with ONLY the slug.\n\n${diffSnippet || '(no diff captured)'}`,
            progress: context.progress
          });
          branchName = sanitizeSlug(slugResponse.text);
        } catch (error) {
          context.progress?.info(`AI branch naming failed (${error instanceof Error ? error.message : String(error)}); using timestamp fallback.`);
        }
      }
      if (!branchName) {
        branchName = timestampBranch();
      }
    }
    context.progress?.info(`On default branch; creating new branch ${branchName}.`);
    if (!dryRun) {
      await checkoutNewBranch(context.cwd, branchName, runner);
    }
    workingBranch = branchName;
  }

  if (!options.message?.trim() && !allowAi) {
    throw new Error('No commit message provided and AI is disabled (--no-ai). Pass --message "..." or omit --no-ai.');
  }

  context.progress?.info('Staging all changes.');
  if (!dryRun) {
    await stageAll(context.cwd, runner);
  }

  let subject = options.message?.trim();
  let body: string | undefined;
  if (!subject) {
    const ai = await ensureAi();
    if (!ai) {
      throw new Error('No commit message provided and no AI backend available. Pass --message "..." or configure OPENAI_API_KEY/ANTHROPIC_API_KEY.');
    }
    const stagedDiff = dryRun ? await workingDiff(context.cwd, runner) : await cachedDiff(context.cwd, runner);
    const aiResponse = await ai.generateText({
      system: 'You write conventional-commit-style git commit messages. Respond with a JSON object: {"subject": string, "body": string}. Subject MUST be <=72 chars, no trailing period, imperative mood, optionally prefixed with type(scope): (e.g. "feat(api): ..."). Body is optional plain prose, may be empty.',
      prompt: `Write a commit message for these staged changes. Respond ONLY with JSON.\n\n${stagedDiff.slice(0, 16_000) || '(no diff captured)'}`,
      preferJson: true,
      progress: context.progress
    });
    const parsed = parseCommitJson(aiResponse.text);
    subject = parsed.subject;
    body = parsed.body;
  }

  const fullBody = [body?.trim(), COAUTHOR_TRAILER].filter(Boolean).join('\n\n');

  context.progress?.info(`Committing: ${subject}`);
  let commitSha = '(dry-run)';
  if (!dryRun) {
    commitSha = await commit(context.cwd, subject, fullBody, runner);
  }

  let prUrl = '(not pushed)';
  let prStatus: 'created' | 'updated' | 'skipped' = 'skipped';
  if (shouldPush) {
    context.progress?.info(`Pushing branch ${workingBranch} to origin.`);
    if (!dryRun) {
      await push(context.cwd, workingBranch, runner);
    }

    const existing = dryRun ? undefined : await prForBranch(context.cwd, workingBranch, runner);
    if (existing && existing.state === 'OPEN') {
      prUrl = existing.url;
      prStatus = 'updated';
      context.progress?.info(`Existing PR #${existing.number} updated by push.`);
    } else {
      const { title, prBody } = await buildPrTitleAndBody({
        runner,
        cwd: context.cwd,
        baseBranch,
        subject,
        commitBody: body,
        ai: await ensureAi(),
        progress: context.progress
      });
      context.progress?.info(`Creating PR with title: ${title}`);
      if (dryRun) {
        prUrl = '(dry-run)';
        prStatus = 'created';
      } else {
        prUrl = await createPr(context.cwd, title, prBody, baseBranch, runner);
        prStatus = 'created';
      }
    }
  }

  const prStatusLabel = prStatus === 'updated' ? 'updated existing' : prStatus === 'created' ? 'created' : 'n/a';
  const prLine = shouldPush
    ? `Pull request: ${prStatusLabel} → ${prUrl}`
    : 'Push: skipped (--no-push).';
  const summaryLines = [
    `Branch: \`${workingBranch}\`${workingBranch !== startingBranch ? ` (created from \`${startingBranch}\`)` : ''}`,
    `Commit: \`${commitSha.slice(0, 12)}\` — ${subject}`,
    prLine,
    aiProvider ? `AI backend: ${aiProvider.name}` : 'AI backend: none'
  ];

  const result: CheckResult = {
    name: 'check',
    status: 'pass',
    summary: shouldPush
      ? `Committed and ${prStatus === 'updated' ? 'updated PR' : prStatus === 'created' ? 'opened PR' : 'pushed'} for branch ${workingBranch}.`
      : `Committed on branch ${workingBranch}; push skipped.`,
    findings: [],
    sections: [{ title: 'vibin pr summary', body: summaryLines.map((line) => `- ${line}`).join('\n') }],
    startedAt,
    completedAt: new Date().toISOString()
  };

  const markdown = renderCheckResult(result);
  await writeReport(markdown, options);
  if (options.output) {
    context.progress?.info(`PR report written to ${options.output}.`);
  }
  return { result, markdown };
}

function sanitizeSlug(input: string): string {
  const trimmed = input.trim().split(/\s+/)[0] ?? '';
  const slug = trimmed
    .toLowerCase()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '');
  return slug;
}

function timestampBranch(): string {
  const now = new Date();
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `vibin/${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
}

const commitJsonSchema = z.object({
  subject: z.string().min(1),
  body: z.string().optional().default('')
});

function parseCommitJson(raw: string): { subject: string; body: string } {
  const text = raw.trim();
  // Try direct parse, then fenced code, then first {...} block.
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) candidates.push(fenced[1]);
  const inline = text.match(/\{[\s\S]*\}/);
  if (inline) candidates.push(inline[0]);
  for (const candidate of candidates) {
    try {
      const parsed = commitJsonSchema.parse(JSON.parse(candidate));
      const subject = parsed.subject.replace(/[\r\n]+.*$/s, '').trim().slice(0, 100);
      return { subject, body: parsed.body.trim() };
    } catch {
      // try next candidate
    }
  }
  // Fallback: treat first non-empty line as subject, rest as body.
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    throw new Error('AI commit message response was empty.');
  }
  return { subject: lines[0]!.slice(0, 100), body: lines.slice(1).join('\n') };
}

const prJsonSchema = z.object({
  title: z.string().min(1),
  body: z.string().optional().default('')
});

async function buildPrTitleAndBody(args: {
  runner: ShellRunner;
  cwd: string;
  baseBranch: string;
  subject: string;
  commitBody?: string;
  ai?: AiProvider;
  progress?: RunContext['progress'];
}): Promise<{ title: string; prBody: string }> {
  if (args.ai) {
    try {
      const diff = (await diffAgainst(args.cwd, args.baseBranch, args.runner)).slice(0, 16_000);
      const aiResponse = await args.ai.generateText({
        system: 'You write GitHub pull request titles and descriptions. Respond with a JSON object: {"title": string, "body": string}. Title <=72 chars, imperative mood. Body is GitHub-flavored markdown describing the change, motivation, and notable details.',
        prompt: `Write a PR title and body for these changes vs base branch ${args.baseBranch}. Latest commit subject: "${args.subject}". Respond ONLY with JSON.\n\n${diff || '(no diff captured)'}`,
        preferJson: true,
        progress: args.progress
      });
      const parsed = extractPrJson(aiResponse.text);
      if (parsed) {
        return { title: parsed.title.slice(0, 100), prBody: parsed.body || args.subject };
      }
    } catch (error) {
      args.progress?.info(`AI PR description failed (${error instanceof Error ? error.message : String(error)}); falling back to commit summary.`);
    }
  }
  const summary = await logSummary(args.cwd, args.baseBranch, args.runner).catch(() => '');
  const title = args.subject || (await lastCommitSubject(args.cwd, args.runner).catch(() => 'Update'));
  const body = [args.commitBody?.trim(), summary.trim() ? `## Commits\n\n${summary}` : '']
    .filter(Boolean)
    .join('\n\n') || title;
  return { title, prBody: body };
}

function extractPrJson(raw: string): { title: string; body: string } | undefined {
  const text = raw.trim();
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) candidates.push(fenced[1]);
  const inline = text.match(/\{[\s\S]*\}/);
  if (inline) candidates.push(inline[0]);
  for (const candidate of candidates) {
    try {
      return prJsonSchema.parse(JSON.parse(candidate));
    } catch {
      // try next
    }
  }
  return undefined;
}
