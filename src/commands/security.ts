import type { CheckResult, RunContext } from '../types.js';
import { resolveAiProvider } from '../ai/providers.js';
import { renderCheckResult, sortFindings, statusForFindings, writeReport } from '../reporting/markdown.js';
import { runSecurityScanners } from '../security/scanners.js';

export interface SecurityOptions {
  output?: string;
}

export async function runSecurity(context: RunContext, options: SecurityOptions = {}): Promise<{ result: CheckResult; markdown: string }> {
  const startedAt = new Date().toISOString();
  context.progress?.info('Scanning source files, tracked env files, and dependencies.');
  const findings = sortFindings(await runSecurityScanners(context.cwd, context.progress));
  context.progress?.info(`Security scanners found ${findings.length} finding${findings.length === 1 ? '' : 's'}.`);
  context.progress?.info('Resolving AI backend for security review.');
  const ai = await resolveAiProvider(context.env, context.progress);
  context.progress?.info(`Requesting security review from ${ai.name}.`);
  const aiResponse = await ai.generateText({
    system:
      'You are vibin, a pragmatic pre-launch security reviewer for fast-moving app builders. Be direct, prioritize exploitable issues, and suggest concrete fixes.',
    prompt: [
      'Review these deterministic security findings and produce a concise ranked security review.',
      'Call out likely false positives, missing-auth concerns worth verifying, and the most important deploy blockers.',
      '',
      JSON.stringify({ cwd: context.cwd, findings }, null, 2)
    ].join('\n'),
    progress: context.progress
  });
  context.progress?.info(`Received security review from ${aiResponse.provider}.`);

  const status = statusForFindings(findings);
  const result: CheckResult = {
    name: 'security',
    status,
    summary:
      findings.length === 0
        ? 'No deterministic security issues were found; AI review completed for context.'
        : `${findings.length} security issue${findings.length === 1 ? '' : 's'} found. ${findings.filter((finding) => finding.severity === 'critical').length} critical.`,
    findings,
    sections: [{ title: `AI security review (${aiResponse.provider})`, body: aiResponse.text }],
    startedAt,
    completedAt: new Date().toISOString()
  };

  const markdown = renderCheckResult(result);
  await writeReport(markdown, options);
  if (options.output) {
    context.progress?.info(`Security report written to ${options.output}.`);
  }
  return { result, markdown };
}
