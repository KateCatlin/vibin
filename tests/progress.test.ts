import { describe, expect, it } from 'vitest';
import { createProgressReporter } from '../src/progress.js';

describe('createProgressReporter', () => {
  it('writes timestamped progress lines to the configured stream', () => {
    let now = 1_000;
    const chunks: string[] = [];
    const reporter = createProgressReporter({
      now: () => now,
      stream: {
        write(chunk) {
          chunks.push(chunk);
        }
      }
    });

    reporter?.info('Starting security check.');
    now = 2_250;
    reporter?.info('Security check complete.');

    expect(chunks).toEqual(['🛡️ vibin 0.0s │ Starting security check.\n', '✅ vibin 1.3s │ Security check complete.\n']);
  });

  it('adds ANSI color when the stream supports it', () => {
    const chunks: string[] = [];
    const reporter = createProgressReporter({
      now: () => 1_000,
      stream: {
        isTTY: true,
        write(chunk) {
          chunks.push(chunk);
        }
      }
    });

    reporter?.info('Security check completed with PASS.');

    expect(chunks[0]).toContain('\u001b[');
    expect(chunks[0]).toContain('✅');
  });

  it('can be disabled', () => {
    const reporter = createProgressReporter({ enabled: false });

    expect(reporter).toBeUndefined();
  });
});
