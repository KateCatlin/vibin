import { describe, expect, it } from 'vitest';
import { hyperlink, linkifyUrls, renderCliError, renderTerminalMarkdown } from '../src/terminal.js';

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

  it('wraps URLs in OSC 8 hyperlink escapes for clickable links', () => {
    const url = 'https://github.com/KateCatlin/vibin/pull/42';
    expect(linkifyUrls(`See ${url} now.`)).toBe(`See ${hyperlink(url, url)} now.`);
  });

  it('linkifies URLs in markdown when a TTY hyperlink-capable stream is provided', () => {
    const url = 'https://github.com/example/repo/pull/7';
    const output = renderTerminalMarkdown(`- Pull request: created → ${url}\n`, {
      color: false,
      stream: { isTTY: true },
      env: {}
    });

    expect(output).toContain('\u001b]8;;');
    expect(output).toContain(url);
  });

  it('skips hyperlinks when output is not a TTY', () => {
    const url = 'https://github.com/example/repo/pull/7';
    const markdown = `- Pull request: created → ${url}\n`;
    expect(renderTerminalMarkdown(markdown, { color: false, stream: { isTTY: false }, env: {} })).toBe(markdown);
  });
});
