import { z } from 'zod';
import type { CheckResult, Finding, RunContext } from '../types.js';
import { extractJsonObject, resolveAiProvider } from '../ai/providers.js';
import { withApp } from '../browser/app.js';
import { getCurrentPageSnapshot, openBrowserPage } from '../browser/snapshots.js';
import { renderCheckResult, statusForFindings, writeReport } from '../reporting/markdown.js';

const actionSchema = z.object({
  action: z.enum(['click', 'fill', 'select', 'wait', 'navigate', 'stop']),
  target: z.string().optional(),
  value: z.string().optional(),
  reason: z.string(),
  expected: z.string().optional()
});

export interface UsersOptions {
  url?: string;
  startCommand?: string;
  commandName?: 'users' | 'check';
  goal?: string;
  output?: string;
  maxSteps?: number;
}

export async function runUsers(context: RunContext, options: UsersOptions = {}): Promise<{ result: CheckResult; markdown: string }> {
  const startedAt = new Date().toISOString();
  const goal = options.goal ?? 'understand the product and complete the primary call to action';
  context.progress?.info('Resolving AI backend for fake-user testing.');
  const ai = await resolveAiProvider(context.env, context.progress);
  const steps: string[] = [];
  const findings: Finding[] = [];

  context.progress?.info('Preparing app for fake-user testing.');
  await withApp({ cwd: context.cwd, url: options.url, startCommand: options.startCommand, commandName: options.commandName ?? 'users', progress: context.progress }, async (url) => {
    const { browser, page, consoleErrors } = await openBrowserPage(url, context.progress);
    try {
      for (let index = 0; index < (options.maxSteps ?? 8); index += 1) {
        context.progress?.info(`Capturing browser state for fake-user step ${index + 1}.`);
        const snapshot = await getCurrentPageSnapshot(page, consoleErrors);
        context.progress?.info(`Requesting next fake-user action from ${ai.name}.`);
        const response = await ai.generateText({
          system:
            'You are vibin, a fake user testing agent. Choose one realistic browser action at a time. Return only JSON matching {action,target,value,reason,expected}.',
          prompt: [
            `Goal: ${goal}`,
            `Step: ${index + 1}`,
            'Available actions: click, fill, select, wait, navigate, stop.',
            'Use visible labels or accessible names for targets. Stop when the goal is complete, impossible, or confusing.',
            '',
            JSON.stringify(snapshot, null, 2)
          ].join('\n'),
          preferJson: true,
          progress: context.progress
        });
        const action = actionSchema.parse(extractJsonObject(response.text));

        if (action.action === 'stop') {
          context.progress?.info(`Fake user stopped after ${index + 1} step${index === 0 ? '' : 's'}.`);
          steps.push(`Stopped: ${action.reason}`);
          if (!/complete|done|success|finished/i.test(action.reason)) {
            findings.push({
              id: `user-friction:stop:${index}`,
              title: 'Fake user could not confidently complete the goal',
              severity: 'high',
              category: 'user-friction',
              source: 'ai',
              evidence: action.reason,
              suggestion: 'Clarify the flow, labels, and success states so a new user can complete the goal without guessing.'
            });
          }
          break;
        }

        steps.push(`Step ${index + 1}: ${action.action} ${action.target ?? ''}${action.value ? ` = ${action.value}` : ''}. ${action.reason}`);
        context.progress?.info(`Executing fake-user action: ${action.action}${action.target ? ` ${action.target}` : ''}.`);
        const executed = await executeAction(page, action);
        if (!executed) {
          context.progress?.info('Fake-user action was not actionable.');
          const evidence = `I expected ${action.expected ?? 'the requested action to work'} but got no matching control for ${action.target ?? action.action}.`;
          findings.push({
            id: `user-friction:${index}`,
            title: 'Expected control was not actionable',
            severity: 'medium',
            category: 'user-friction',
            source: 'browser',
            evidence,
            suggestion: 'Make the intended next action visible, clearly labeled, and reachable by accessible selectors.'
          });
          steps.push(evidence);
          break;
        }
      }
    } finally {
      await browser.close();
    }
  });

  const status = statusForFindings(findings);
  const result: CheckResult = {
    name: 'users',
    status,
    summary: `Attempted fake-user goal: "${goal}". ${findings.length} friction point${findings.length === 1 ? '' : 's'} found.`,
    findings,
    sections: [{ title: `User-testing narration (${ai.name})`, body: steps.length > 0 ? steps.join('\n') : 'No steps were recorded.' }],
    startedAt,
    completedAt: new Date().toISOString()
  };

  const markdown = renderCheckResult(result);
  await writeReport(markdown, options);
  if (options.output) {
    context.progress?.info(`Users report written to ${options.output}.`);
  }
  return { result, markdown };
}

async function executeAction(
  page: import('playwright').Page,
  action: z.infer<typeof actionSchema>
): Promise<boolean> {
  try {
    if (action.action === 'wait') {
      await page.waitForTimeout(1_000);
      return true;
    }

    if (action.action === 'navigate' && action.value) {
      await page.goto(action.value, { waitUntil: 'networkidle', timeout: 30_000 });
      return true;
    }

    if (!action.target) {
      return false;
    }

    if (action.action === 'click') {
      const locator = page.getByRole('button', { name: new RegExp(action.target, 'i') }).or(page.getByRole('link', { name: new RegExp(action.target, 'i') }));
      await locator.first().click({ timeout: 5_000 });
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      return true;
    }

    if (action.action === 'fill' && action.value !== undefined) {
      const locator = page.getByLabel(new RegExp(action.target, 'i')).or(page.getByPlaceholder(new RegExp(action.target, 'i')));
      await locator.first().fill(action.value, { timeout: 5_000 });
      return true;
    }

    if (action.action === 'select' && action.value !== undefined) {
      await page.getByLabel(new RegExp(action.target, 'i')).first().selectOption({ label: action.value }, { timeout: 5_000 });
      return true;
    }

    return false;
  } catch {
    return false;
  }
}
