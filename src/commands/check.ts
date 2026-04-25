import type { CheckResult, RunContext } from '../types.js';
import { runSecurity } from './security.js';
import { runUi } from './ui.js';
import { runUsers } from './users.js';
import { combineStatus, renderCombinedReport, writeReport } from '../reporting/markdown.js';

export interface CheckOptions {
  url?: string;
  startCommand?: string;
  goal?: string;
  output?: string;
}

export async function runCheck(context: RunContext, options: CheckOptions = {}): Promise<{ result: CheckResult; markdown: string; results: CheckResult[] }> {
  const startedAt = new Date().toISOString();
  context.progress?.info('Running security check (1/3).');
  const security = await runSecurity(context);
  context.progress?.info(`Security check completed with ${security.result.status.toUpperCase()}.`);
  context.progress?.info('Running UI check (2/3).');
  const ui = await runUi(context, { ...options, commandName: 'check' });
  context.progress?.info(`UI check completed with ${ui.result.status.toUpperCase()}.`);
  context.progress?.info('Running fake-user check (3/3).');
  const users = await runUsers(context, { ...options, commandName: 'check' });
  context.progress?.info(`Fake-user check completed with ${users.result.status.toUpperCase()}.`);
  const results = [security.result, ui.result, users.result];
  context.progress?.info('Rendering combined pre-launch report.');
  const markdown = renderCombinedReport(results);
  await writeReport(markdown, options);
  if (options.output) {
    context.progress?.info(`Combined report written to ${options.output}.`);
  }

  return {
    result: {
      name: 'check',
      status: combineStatus(results),
      summary: `Ran security, ui, and users checks. Overall status: ${combineStatus(results).toUpperCase()}.`,
      findings: results.flatMap((result) => result.findings),
      sections: [],
      startedAt,
      completedAt: new Date().toISOString()
    },
    markdown,
    results
  };
}
