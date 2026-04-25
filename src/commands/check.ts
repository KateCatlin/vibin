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
  const security = await runSecurity(context);
  const ui = await runUi(context, options);
  const users = await runUsers(context, options);
  const results = [security.result, ui.result, users.result];
  const markdown = renderCombinedReport(results);
  await writeReport(markdown, options);

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
