import path from 'node:path';
import { execa } from 'execa';
import type { Finding } from '../types.js';
import { collectProjectFiles, lineNumberForIndex, readTextFile } from '../utils/files.js';

const secretPatterns: Array<{ category: string; regex: RegExp; title: string }> = [
  { category: 'secrets', regex: /\bsk_live_[A-Za-z0-9]{16,}\b/g, title: 'Stripe live secret key appears in source' },
  { category: 'secrets', regex: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/g, title: 'GitHub token appears in source' },
  { category: 'secrets', regex: /\bAKIA[0-9A-Z]{16}\b/g, title: 'AWS access key id appears in source' },
  { category: 'secrets', regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, title: 'Slack token appears in source' },
  { category: 'secrets', regex: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, title: 'SendGrid API key appears in source' },
  {
    category: 'secrets',
    regex: /\b(?:api[_-]?key|secret|token|private[_-]?key)\b\s*[:=]\s*['"][^'"\n]{20,}['"]/gi,
    title: 'Hardcoded secret-like value appears in source'
  }
];

const serverOnlySecretUsageRegex =
  /\b(?:process\.env\.|import\.meta\.env\.|env\.)(?:SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE_KEY|DATABASE_URL|STRIPE_SECRET_KEY)\b/g;
const clientFileRegex = /(?:^|\/)(?:app|pages|src|client|components)\/.*\.(?:ts|tsx|js|jsx|vue|svelte)$/;
const routeFileRegex = /(?:route|routes|api|server|controller|handler).*\.(?:ts|tsx|js|jsx|py|rb|go)$/i;

export async function runSecurityScanners(cwd: string): Promise<Finding[]> {
  const [files, trackedEnvFindings, dependencyFindings] = await Promise.all([
    collectProjectFiles(cwd),
    findTrackedEnvFiles(cwd),
    findDependencyVulnerabilities(cwd)
  ]);

  const findings: Finding[] = [...trackedEnvFindings, ...dependencyFindings];

  for (const file of files) {
    const contents = await readTextFile(file);
    if (!contents) {
      continue;
    }

    findings.push(...findHardcodedSecrets(file.relativePath, contents));
    findings.push(...findClientSideSecretExposure(file.relativePath, contents));
    findings.push(...findCorsRisks(file.relativePath, contents));
    findings.push(...findSqlInjectionRisks(file.relativePath, contents));
    findings.push(...findAuthReviewCandidates(file.relativePath, contents));
  }

  return dedupeFindings(findings);
}

function findHardcodedSecrets(file: string, contents: string): Finding[] {
  const findings: Finding[] = [];
  for (const pattern of secretPatterns) {
    for (const match of contents.matchAll(pattern.regex)) {
      const line = lineNumberForIndex(contents, match.index ?? 0);
      findings.push({
        id: `secret:${file}:${line}:${pattern.title}`,
        title: pattern.title,
        severity: file.startsWith('.env') ? 'critical' : 'high',
        category: pattern.category,
        source: 'scanner',
        file,
        line,
        evidence: redact(match[0]),
        suggestion: 'Move this value into an untracked environment variable, rotate the exposed credential, and add a secret-scanning check to CI.'
      });
    }
  }

  return findings;
}

function findClientSideSecretExposure(file: string, contents: string): Finding[] {
  if (!clientFileRegex.test(file)) {
    return [];
  }

  return [...contents.matchAll(serverOnlySecretUsageRegex)].map((match) => ({
    id: `client-secret:${file}:${match[0]}`,
    title: 'Server-only secret referenced in client-side code',
    severity: 'critical',
    category: 'client-secret-exposure',
    source: 'scanner' as const,
    file,
    line: lineNumberForIndex(contents, match.index ?? 0),
    evidence: match[0],
    suggestion: 'Keep service-role keys and database credentials on the server. Route client requests through an authenticated server endpoint.'
  }));
}

function findCorsRisks(file: string, contents: string): Finding[] {
  const riskyCors = [
    /cors\s*\(\s*\)/g,
    /origin\s*:\s*['"]\*['"]/g,
    /Access-Control-Allow-Origin['"]?\s*,\s*['"]\*['"]/g
  ];

  return riskyCors.flatMap((regex) =>
    [...contents.matchAll(regex)].map((match) => ({
      id: `cors:${file}:${lineNumberForIndex(contents, match.index ?? 0)}:${match[0]}`,
      title: 'Overly permissive CORS configuration',
      severity: 'medium' as const,
      category: 'cors',
      source: 'scanner' as const,
      file,
      line: lineNumberForIndex(contents, match.index ?? 0),
      evidence: match[0],
      suggestion: 'Restrict allowed origins to known production domains and avoid wildcard CORS on credentialed or sensitive endpoints.'
    }))
  );
}

function findSqlInjectionRisks(file: string, contents: string): Finding[] {
  const riskySql = [
    /\b(?:query|execute|raw|sql)\s*\([^)]*`[^`]*\$\{[^}]+}/g,
    /\b(?:query|execute|raw|sql)\s*\([^)]*['"][^'"]*(?:SELECT|INSERT|UPDATE|DELETE)[^'"]*['"]\s*\+/gi
  ];

  return riskySql.flatMap((regex) =>
    [...contents.matchAll(regex)].map((match) => ({
      id: `sql:${file}:${lineNumberForIndex(contents, match.index ?? 0)}:${match[0].slice(0, 40)}`,
      title: 'Possible SQL injection via dynamic query construction',
      severity: 'high' as const,
      category: 'sql-injection',
      source: 'scanner' as const,
      file,
      line: lineNumberForIndex(contents, match.index ?? 0),
      evidence: compact(match[0]),
      suggestion: 'Use parameterized queries or an ORM query builder instead of string interpolation or concatenation.'
    }))
  );
}

function findAuthReviewCandidates(file: string, contents: string): Finding[] {
  if (!routeFileRegex.test(file) || !/(admin|billing|checkout|account|dashboard|settings|delete|update|create)/i.test(contents)) {
    return [];
  }

  if (/\b(auth|authorize|requireUser|requireAuth|getServerSession|currentUser|verifyToken|session)\b/i.test(contents)) {
    return [];
  }

  return [
    {
      id: `auth-candidate:${file}`,
      title: 'Sensitive-looking route needs an auth check review',
      severity: 'medium',
      category: 'missing-auth',
      source: 'scanner',
      file,
      evidence: 'Route-like file contains sensitive action words but no obvious auth/session guard.',
      suggestion: 'Confirm this route enforces authentication and authorization before performing sensitive actions.'
    }
  ];
}

async function findTrackedEnvFiles(cwd: string): Promise<Finding[]> {
  const result = await execa('git', ['ls-files'], { cwd, reject: false, timeout: 10_000 });
  if (result.exitCode !== 0) {
    return [];
  }

  return result.stdout
    .split('\n')
    .filter((file) => /^\.env(?:\.|$)|\/\.env(?:\.|$)/.test(file))
    .map((file) => ({
      id: `tracked-env:${file}`,
      title: '.env file is tracked by git',
      severity: 'critical' as const,
      category: 'tracked-env',
      source: 'scanner' as const,
      file,
      evidence: 'git ls-files includes this environment file.',
      suggestion: 'Remove the file from git history if secrets were committed, rotate exposed secrets, and keep only safe examples such as .env.example tracked.'
    }));
}

async function findDependencyVulnerabilities(cwd: string): Promise<Finding[]> {
  const packageJson = path.join(cwd, 'package.json');
  try {
    await import('node:fs/promises').then((fs) => fs.access(packageJson));
  } catch {
    return [];
  }

  const result = await execa('npm', ['audit', '--json'], { cwd, reject: false, timeout: 45_000 });
  if (!result.stdout.trim()) {
    return [];
  }

  try {
    const audit = JSON.parse(result.stdout) as {
      vulnerabilities?: Record<string, { severity?: string; title?: string; via?: unknown[] }>;
      metadata?: { vulnerabilities?: Record<string, number> };
    };

    return Object.entries(audit.vulnerabilities ?? {}).flatMap(([name, vulnerability]) => {
      const severity = normalizeNpmSeverity(vulnerability.severity);
      if (severity === 'info') {
        return [];
      }

      return [
        {
          id: `dependency:${name}`,
          title: `Known-vulnerable dependency: ${name}`,
          severity,
          category: 'dependency-vulnerability',
          source: 'dependency' as const,
          evidence: vulnerability.title ?? `npm audit reports ${vulnerability.severity ?? 'unknown'} severity`,
          suggestion: 'Run npm audit fix where safe, upgrade the affected package, or replace it if no patched version exists.'
        }
      ];
    });
  } catch {
    return [];
  }
}

function normalizeNpmSeverity(severity: string | undefined): Finding['severity'] {
  if (severity === 'critical' || severity === 'high' || severity === 'medium' || severity === 'low') {
    return severity;
  }

  return 'info';
}

function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    if (seen.has(finding.id)) {
      return false;
    }

    seen.add(finding.id);
    return true;
  });
}

function redact(value: string): string {
  if (value.length <= 12) {
    return '[redacted]';
  }

  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').slice(0, 180);
}
