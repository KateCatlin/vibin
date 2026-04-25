import type { CheckResult, RunContext } from '../types.js';
import { resolveAiProvider } from '../ai/providers.js';
import { renderCheckResult, sortFindings, statusForFindings, writeReport } from '../reporting/markdown.js';
import { runSecurityScanners } from '../security/scanners.js';

export interface SecurityOptions {
  output?: string;
}

export async function runSecurity(context: RunContext, options: SecurityOptions = {}): Promise<{ result: CheckResult; markdown: string }> {
  const startedAt = new Date().toISOString();
  const findings = sortFindings(await runSecurityScanners(context.cwd));
  const ai = await resolveAiProvider(context.env);
  const aiResponse = await ai.generateText({
    system:
      'You are vibin, a pragmatic pre-launch security reviewer for fast-moving app builders. Be direct, prioritize exploitable issues, and suggest concrete fixes.',
    prompt: [
      'Review these deterministic security findings and produce a concise ranked security review.',
      'Call out likely false positives, missing-auth concerns worth verifying, and the most important deploy blockers.',
      '',
      JSON.stringify({ cwd: context.cwd, findings }, null, 2)
    ].join('\n')
  });

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
  return { result, markdown };
}
