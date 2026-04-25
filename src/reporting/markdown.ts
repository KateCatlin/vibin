import { promises as fs } from 'node:fs';
import path from 'node:path';
import { emojiForCheck, emojiForSectionTitle, emojiForSeverity, formatPlainStatus } from '../terminal.js';
import type { CheckResult, CheckStatus, CommonOutputOptions, Finding, Severity } from '../types.js';

const severityRank: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4
};

const statusRank: Record<CheckStatus, number> = {
  error: 0,
  fail: 1,
  warn: 2,
  pass: 3
};

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((left, right) => severityRank[left.severity] - severityRank[right.severity]);
}

export function statusForFindings(findings: Finding[]): CheckStatus {
  if (findings.some((finding) => finding.severity === 'critical')) {
    return 'fail';
  }

  if (findings.some((finding) => finding.severity === 'high' || finding.severity === 'medium')) {
    return 'warn';
  }

  return 'pass';
}

export function exitCodeForResult(result: CheckResult): number {
  return result.status === 'fail' || result.status === 'error' ? 1 : 0;
}

export function combineStatus(results: CheckResult[]): CheckStatus {
  return [...results].sort((left, right) => statusRank[left.status] - statusRank[right.status])[0]?.status ?? 'pass';
}

export function renderCheckResult(result: CheckResult): string {
  const lines = [
    `# ${emojiForCheck(result.name)} vibin ${result.name} report`,
    '',
    `**Status:** ${formatPlainStatus(result.status)}`,
    '',
    result.summary,
    ''
  ];

  const findings = sortFindings(result.findings);
  if (findings.length > 0) {
    lines.push('## 🔎 Findings', '');
    findings.forEach((finding, index) => {
      lines.push(`${index + 1}. **${emojiForSeverity(finding.severity)} [${finding.severity.toUpperCase()}] ${finding.title}**`);
      if (finding.file) {
        lines.push(`   - File: \`${finding.file}${finding.line ? `:${finding.line}` : ''}\``);
      }
      lines.push(`   - Category: ${finding.category}`);
      if (finding.evidence) {
        lines.push(`   - Evidence: ${finding.evidence}`);
      }
      lines.push(`   - Suggested fix: ${finding.suggestion}`, '');
    });
  }

  for (const section of result.sections) {
    lines.push(`## ${emojiForSectionTitle(section.title)} ${section.title}`, '', section.body.trim(), '');
  }

  return lines.join('\n').trimEnd() + '\n';
}

export function renderCombinedReport(results: CheckResult[]): string {
  const status = combineStatus(results);
  const blockers = sortFindings(results.flatMap((result) => result.findings)).filter(
    (finding) => finding.severity === 'critical' || finding.severity === 'high'
  );

  const lines = [
    '# 🚀 vibin pre-launch report',
    '',
    `**Overall status:** ${formatPlainStatus(status)}`,
    '',
    '## ✨ Executive summary',
    '',
    ...results.map((result) => `- ${emojiForCheck(result.name)} **${result.name}:** ${formatPlainStatus(result.status)} — ${result.summary}`),
    ''
  ];

  if (blockers.length > 0) {
    lines.push('## 🚧 Launch blockers and high-priority issues', '');
    blockers.forEach((finding, index) => {
      lines.push(`${index + 1}. **${emojiForSeverity(finding.severity)} [${finding.severity.toUpperCase()}] ${finding.title}**`);
      if (finding.file) {
        lines.push(`   - File: \`${finding.file}${finding.line ? `:${finding.line}` : ''}\``);
      }
      lines.push(`   - Suggested fix: ${finding.suggestion}`, '');
    });
  }

  for (const result of results) {
    lines.push('---', '', renderCheckResult(result).replace(/^# .+\n\n/, ''));
  }

  return lines.join('\n').trimEnd() + '\n';
}

export async function writeReport(markdown: string, options: CommonOutputOptions): Promise<void> {
  if (!options.output) {
    return;
  }

  const outputPath = path.resolve(options.output);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, markdown, 'utf8');
}
