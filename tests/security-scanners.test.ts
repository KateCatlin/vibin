import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSecurityScanners } from '../src/security/scanners.js';

describe('runSecurityScanners', () => {
  it('finds hardcoded secret-like values', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'vibin-security-'));
    await writeFile(path.join(cwd, 'app.ts'), "const apiKey = '123456789012345678901234567890';\n", 'utf8');

    const findings = await runSecurityScanners(cwd);

    expect(findings.some((finding) => finding.category === 'secrets')).toBe(true);
  });

  it('flags server-only secrets referenced from client code', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'vibin-client-secret-'));
    await writeFile(path.join(cwd, 'package.json'), '{"name":"fixture"}', 'utf8');
    await import('node:fs/promises').then((fs) => fs.mkdir(path.join(cwd, 'src'), { recursive: true }));
    await writeFile(path.join(cwd, 'src', 'component.tsx'), 'console.log(process.env.SUPABASE_SERVICE_ROLE_KEY);', 'utf8');

    const findings = await runSecurityScanners(cwd);

    expect(findings.some((finding) => finding.category === 'client-secret-exposure')).toBe(true);
  });
});
