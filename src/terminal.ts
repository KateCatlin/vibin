import type { CheckStatus, Severity } from './types.js';

export interface TerminalStyleOptions {
  color?: boolean;
  env?: NodeJS.ProcessEnv;
  stream?: {
    isTTY?: boolean;
  };
}

const reset = '\u001b[0m';
const styles = {
  bold: ['\u001b[1m', reset],
  dim: ['\u001b[2m', reset],
  red: ['\u001b[31m', reset],
  green: ['\u001b[32m', reset],
  yellow: ['\u001b[33m', reset],
  blue: ['\u001b[34m', reset],
  magenta: ['\u001b[35m', reset],
  cyan: ['\u001b[36m', reset],
  gray: ['\u001b[90m', reset]
} as const;

type StyleName = keyof typeof styles;

export function shouldUseColor(options: TerminalStyleOptions = {}): boolean {
  if (options.color !== undefined) {
    return options.color;
  }

  const env = options.env ?? process.env;
  if ('NO_COLOR' in env || env.TERM === 'dumb') {
    return false;
  }

  const forceColor = env.FORCE_COLOR;
  if (forceColor) {
    return forceColor !== '0' && forceColor.toLowerCase() !== 'false';
  }

  return options.stream?.isTTY === true;
}

export function emojiForCheck(name: string): string {
  if (name === 'security') {
    return '🛡️';
  }

  if (name === 'ui') {
    return '🎨';
  }

  if (name === 'users') {
    return '🧑‍🚀';
  }

  if (name === 'check') {
    return '🚀';
  }

  return '✨';
}

export function emojiForStatus(status: CheckStatus): string {
  switch (status) {
    case 'pass':
      return '✅';
    case 'warn':
      return '⚠️';
    case 'fail':
      return '⛔';
    case 'error':
      return '💥';
  }
}

export function emojiForSeverity(severity: Severity): string {
  switch (severity) {
    case 'critical':
      return '🚨';
    case 'high':
      return '🔥';
    case 'medium':
      return '⚠️';
    case 'low':
      return '💡';
    case 'info':
      return 'ℹ️';
  }
}

export function formatPlainStatus(status: CheckStatus): string {
  return `${emojiForStatus(status)} ${status.toUpperCase()}`;
}

export function emojiForSectionTitle(title: string): string {
  const normalized = title.toLowerCase();
  if (normalized.includes('security')) {
    return '🛡️';
  }

  if (normalized.includes('design') || normalized.includes('ui')) {
    return '🎨';
  }

  if (normalized.includes('captured') || normalized.includes('snapshot') || normalized.includes('page')) {
    return '📸';
  }

  if (normalized.includes('user')) {
    return '🧑‍🚀';
  }

  if (normalized.includes('summary')) {
    return '✨';
  }

  return '📝';
}

export function formatProgressLine(message: string, elapsedSeconds: string, options: TerminalStyleOptions = {}): string {
  const color = shouldUseColor(options);
  const icon = emojiForProgressMessage(message);
  const prefix = [
    icon,
    applyStyle('vibin', color, 'bold', 'cyan'),
    applyStyle(`${elapsedSeconds}s`, color, 'dim')
  ].join(' ');
  return `${prefix} ${applyStyle('│', color, 'gray')} ${highlightMessage(message, color)}`;
}

export function renderTerminalMarkdown(markdown: string, options: TerminalStyleOptions = {}): string {
  const color = shouldUseColor(options);
  const hyperlinks = shouldUseHyperlinks(options);
  if (!color && !hyperlinks) {
    return markdown;
  }

  return markdown
    .split('\n')
    .map((line) => {
      const colorized = color ? colorizeMarkdownLine(line, color) : line;
      return hyperlinks ? linkifyUrls(colorized) : colorized;
    })
    .join('\n');
}

export function shouldUseHyperlinks(options: TerminalStyleOptions = {}): boolean {
  const env = options.env ?? process.env;
  if ('NO_COLOR' in env || env.TERM === 'dumb') {
    return false;
  }
  if (env.FORCE_HYPERLINK === '0' || env.FORCE_HYPERLINK?.toLowerCase() === 'false') {
    return false;
  }
  if (env.FORCE_HYPERLINK) {
    return true;
  }
  if (options.stream?.isTTY !== true) {
    return false;
  }
  return terminalSupportsHyperlinks(env);
}

function terminalSupportsHyperlinks(env: NodeJS.ProcessEnv): boolean {
  // macOS Terminal.app does NOT support OSC 8 hyperlinks, and emitting them
  // breaks its own URL auto-detection (which makes plain URLs Cmd+clickable).
  // Only opt in for terminals known to render OSC 8 hyperlinks correctly.
  const termProgram = env.TERM_PROGRAM;
  if (termProgram === 'Apple_Terminal') {
    return false;
  }
  if (
    termProgram === 'iTerm.app' ||
    termProgram === 'vscode' ||
    termProgram === 'WezTerm' ||
    termProgram === 'Hyper' ||
    termProgram === 'ghostty' ||
    termProgram === 'tabby' ||
    termProgram === 'rio'
  ) {
    return true;
  }
  if (env.TERM === 'xterm-kitty' || env.TERM === 'alacritty' || env.TERM === 'wezterm') {
    return true;
  }
  if (env.WT_SESSION) {
    return true; // Windows Terminal
  }
  if (env.DOMTERM) {
    return true;
  }
  if (env.VTE_VERSION) {
    const vte = Number.parseInt(env.VTE_VERSION, 10);
    if (Number.isFinite(vte) && vte >= 5000) {
      return true;
    }
  }
  return false;
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>()\[\]'"`]+[^\s<>()\[\]'"`.,;:!?]/g;

export function linkifyUrls(text: string): string {
  return text.replace(URL_PATTERN, (url) => hyperlink(url, url));
}

export function hyperlink(url: string, label: string): string {
  return `\u001b]8;;${url}\u0007${label}\u001b]8;;\u0007`;
}

export function renderCliError(message: string, options: TerminalStyleOptions = {}): string {
  const color = shouldUseColor(options);
  return `${applyStyle('💥 vibin failed:', color, 'bold', 'red')} ${message}`;
}

function colorizeMarkdownLine(line: string, color: boolean): string {
  if (line.startsWith('# ')) {
    return applyStyle(line, color, 'bold', 'magenta');
  }

  if (line.startsWith('## ')) {
    return applyStyle(line, color, 'bold', 'cyan');
  }

  if (line === '---') {
    return applyStyle(line, color, 'gray');
  }

  return highlightMessage(line, color)
    .replace(/(\*\*Status:\*\*|\*\*Overall status:\*\*)/g, applyStyle('$1', color, 'bold'))
    .replace(/(\*\*Suggested fix:\*\*|Suggested fix:)/g, applyStyle('$1', color, 'blue'))
    .replace(/^(\d+\.)/g, applyStyle('$1', color, 'magenta'))
    .replace(/^(- )/g, applyStyle('$1', color, 'cyan'));
}

function highlightMessage(message: string, color: boolean): string {
  return message
    .replace(/\b(PASS)\b/g, applyStyle('$1', color, 'bold', 'green'))
    .replace(/\b(WARN)\b/g, applyStyle('$1', color, 'bold', 'yellow'))
    .replace(/\b(FAIL|ERROR)\b/g, applyStyle('$1', color, 'bold', 'red'))
    .replace(/\[(CRITICAL)\]/g, `[${applyStyle('$1', color, 'bold', 'red')}]`)
    .replace(/\[(HIGH)\]/g, `[${applyStyle('$1', color, 'bold', 'red')}]`)
    .replace(/\[(MEDIUM)\]/g, `[${applyStyle('$1', color, 'bold', 'yellow')}]`)
    .replace(/\[(LOW|INFO)\]/g, `[${applyStyle('$1', color, 'bold', 'blue')}]`);
}

function applyStyle(text: string, color: boolean, ...styleNames: StyleName[]): string {
  if (!color) {
    return text;
  }

  return `${styleNames.map((styleName) => styles[styleName][0]).join('')}${text}${reset}`;
}

function emojiForProgressMessage(message: string): string {
  const normalized = message.toLowerCase();
  if (/(failed|failure|timed out|not actionable|error)/.test(normalized)) {
    return '💥';
  }

  if (/(completed?|finished|received|reachable|written|stopped)/.test(normalized)) {
    return '✅';
  }

  if (/(waiting|still waiting)/.test(normalized)) {
    return '⏳';
  }

  if (/(ai|backend|copilot|openai|anthropic|model)/.test(normalized)) {
    return '🤖';
  }

  if (/(browser|snapshot|captur|desktop|mobile|opening)/.test(normalized)) {
    return '📸';
  }

  if (/\bui\b|design/.test(normalized)) {
    return '🎨';
  }

  if (/(fake-user|fake user|user action|goal)/.test(normalized)) {
    return '🧑‍🚀';
  }

  if (/\busers\b/.test(normalized)) {
    return '🧑‍🚀';
  }

  if (/(security|scann|audit|secret|dependencies)/.test(normalized)) {
    return '🛡️';
  }

  if (/\bcheck\b|pre-launch/.test(normalized)) {
    return '🚀';
  }

  if (/(report|render)/.test(normalized)) {
    return '📝';
  }

  if (/(app|url|start|stop)/.test(normalized)) {
    return '🌐';
  }

  return '✨';
}
