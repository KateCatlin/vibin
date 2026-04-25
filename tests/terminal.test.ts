import { describe, expect, it } from 'vitest';
import { renderCliError, renderTerminalMarkdown } from '../src/terminal.js';

describe('terminal styling', () => {
  it('leaves markdown plain when color is disabled', () => {
    const markdown = '# 🚀 vibin report\n\n**Status:** ✅ PASS\n';

    expect(renderTerminalMarkdown(markdown, { color: false })).toBe(markdown);
  });

  it('colorizes markdown readouts when color is enabled', () => {
    const output = renderTerminalMarkdown('## 🔎 Findings\n1. **🚨 [CRITICAL] Secret**\n', { color: true });

    expect(output).toContain('\u001b[');
    expect(output).toContain('CRITICAL');
  });

  it('formats operational failures with a visible icon', () => {
    expect(renderCliError('No AI backend found.', { color: false })).toBe('💥 vibin failed: No AI backend found.');
  });
});
