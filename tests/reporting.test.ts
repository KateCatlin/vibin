import { describe, expect, it } from 'vitest';
import type { CheckResult } from '../src/types.js';
import { combineStatus, exitCodeForResult, statusForFindings } from '../src/reporting/markdown.js';

describe('reporting', () => {
  it('fails when critical findings exist', () => {
    const status = statusForFindings([
      {
        id: 'secret',
        title: 'Secret',
        severity: 'critical',
        category: 'secrets',
        source: 'scanner',
        suggestion: 'Rotate it.'
      }
    ]);

    expect(status).toBe('fail');
  });

  it('uses a non-zero exit code for failed checks', () => {
    const result: CheckResult = {
      name: 'security',
      status: 'fail',
      summary: 'failed',
      findings: [],
      sections: [],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    };

    expect(exitCodeForResult(result)).toBe(1);
  });

  it('combines statuses by most severe result', () => {
    expect(
      combineStatus([
        { name: 'security', status: 'pass', summary: '', findings: [], sections: [], startedAt: '', completedAt: '' },
        { name: 'ui', status: 'warn', summary: '', findings: [], sections: [], startedAt: '', completedAt: '' },
        { name: 'users', status: 'fail', summary: '', findings: [], sections: [], startedAt: '', completedAt: '' }
      ])
    ).toBe('fail');
  });
});
