import type { CheckResult, Finding, RunContext } from '../types.js';
import { resolveAiProvider } from '../ai/providers.js';
import { withApp } from '../browser/app.js';
import { collectPageSnapshots } from '../browser/snapshots.js';
import { renderCheckResult, statusForFindings, writeReport } from '../reporting/markdown.js';

export interface UiOptions {
  url?: string;
  startCommand?: string;
  commandName?: 'ui' | 'check';
  output?: string;
}

export async function runUi(context: RunContext, options: UiOptions = {}): Promise<{ result: CheckResult; markdown: string }> {
  const startedAt = new Date().toISOString();
  context.progress?.info('Preparing app for UI review.');
  const snapshots = await withApp(
    { cwd: context.cwd, url: options.url, startCommand: options.startCommand, commandName: options.commandName ?? 'ui', progress: context.progress },
    (url) => collectPageSnapshots(url, 4, context.progress)
  );
  context.progress?.info(`Captured ${snapshots.length} page snapshot${snapshots.length === 1 ? '' : 's'}.`);
  context.progress?.info('Resolving AI backend for UI critique.');
  const ai = await resolveAiProvider(context.env, context.progress);
  context.progress?.info(`Requesting UI critique from ${ai.name}.`);
  const findings: Finding[] = snapshots.flatMap((snapshot) => [
    ...snapshot.consoleErrors.map((error, index) => ({
      id: `console:${snapshot.url}:${index}`,
      title: 'Console error observed while reviewing UI',
      severity: 'medium' as const,
      category: 'browser-console',
      source: 'browser' as const,
      evidence: `${snapshot.url}: ${error}`,
      suggestion: 'Fix browser console errors before launch; they often correspond to broken UI states or missing assets.'
    })),
    ...(snapshot.brokenImages > 0
      ? [
          {
            id: `broken-images:${snapshot.url}`,
            title: 'Broken images observed on page',
            severity: 'medium' as const,
            category: 'visual-regression',
            source: 'browser' as const,
            evidence: `${snapshot.brokenImages} broken image(s) found on ${snapshot.url}`,
            suggestion: 'Replace missing image assets or add fallbacks so the page does not look unfinished.'
          }
        ]
      : [])
  ]);

  const aiResponse = await ai.generateText({
    system:
      'You are vibin, an honest design critic for pre-launch web apps. Judge beauty, modernity, simplicity, and cross-page consistency. Be specific and kind but not soft.',
    prompt: [
      'Review these page snapshots and write a markdown UI critique.',
      'Score beauty, modernity, simplicity, and cross-page consistency from 1-5.',
      'Give concrete suggestions a fast-moving builder can act on before launch.',
      '',
      JSON.stringify({ snapshots }, null, 2)
    ].join('\n'),
    progress: context.progress
  });
  context.progress?.info(`Received UI critique from ${aiResponse.provider}.`);

  const result: CheckResult = {
    name: 'ui',
    status: statusForFindings(findings),
    summary: `Reviewed ${snapshots.length} page snapshot${snapshots.length === 1 ? '' : 's'} for design quality and consistency.`,
    findings,
    sections: [
      {
        title: `Design critique (${aiResponse.provider})`,
        body: aiResponse.text
      },
      {
        title: 'Captured pages',
        body: snapshots
          .map((snapshot) => `- ${snapshot.title || 'Untitled'} — ${snapshot.url}${snapshot.screenshotPath ? ` (${snapshot.screenshotPath})` : ''}`)
          .join('\n')
      }
    ],
    startedAt,
    completedAt: new Date().toISOString()
  };

  const markdown = renderCheckResult(result);
  await writeReport(markdown, options);
  if (options.output) {
    context.progress?.info(`UI report written to ${options.output}.`);
  }
  return { result, markdown };
}
