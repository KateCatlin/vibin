import { promises as fs } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execaCommand } from 'execa';
import type { BrowserTargetOptions, ProgressReporter } from '../types.js';

export const DEFAULT_APP_READY_TIMEOUT_MS = 20_000;

const READINESS_RETRY_MS = 750;
const READINESS_PROGRESS_INTERVAL_MS = 5_000;
const READINESS_ATTEMPT_TIMEOUT_MS = 3_000;
const LOCAL_CONNECTION_TIMEOUT_MS = 1_000;
const START_OUTPUT_TAIL_CHARS = 2_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type ConnectionStatus = 'open' | 'closed' | 'timeout' | 'error' | 'skipped';
type BrowserCommandName = NonNullable<BrowserTargetOptions['commandName']>;

interface ReadinessState {
  attempts: number;
  lastError: string;
  lastStatus?: number;
}

interface StartCommandDiagnostics {
  command: string;
  exitSummary(): string | undefined;
  outputTail(): string;
}

interface WaitForUrlOptions {
  progress?: ProgressReporter;
  cwd?: string;
  startCommand?: string;
  commandName?: BrowserCommandName;
  startDiagnostics?: StartCommandDiagnostics;
  fetchImpl?: FetchLike;
  checkConnection?: (url: URL) => Promise<ConnectionStatus>;
}

export async function withApp<T>(
  options: BrowserTargetOptions,
  callback: (url: string) => Promise<T>
): Promise<T> {
  const url = options.url ?? 'http://localhost:3000';
  let child: ReturnType<typeof execaCommand> | undefined;
  let startDiagnostics: StartCommandDiagnostics | undefined;

  try {
    if (options.startCommand) {
      options.progress?.info('Starting app with the provided start command.');
      child = execaCommand(options.startCommand, {
        cwd: options.cwd,
        reject: false,
        stdout: 'pipe',
        stderr: 'pipe'
      });
      startDiagnostics = captureStartCommandDiagnostics(child, options.startCommand);
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_APP_READY_TIMEOUT_MS;
    options.progress?.info(`Waiting up to ${formatDuration(timeoutMs)} for ${url} to respond.`);
    await waitForUrl(url, timeoutMs, {
      progress: options.progress,
      cwd: options.cwd,
      startCommand: options.startCommand,
      commandName: options.commandName,
      startDiagnostics
    });
    options.progress?.info(`${url} is reachable.`);
    return await callback(url);
  } finally {
    if (child?.pid && !child.killed) {
      options.progress?.info('Stopping app started by vibin.');
      child.kill('SIGTERM');
    }
  }
}

export async function waitForUrl(url: string, timeoutMs: number, progressOrOptions?: ProgressReporter | WaitForUrlOptions): Promise<void> {
  const options = normalizeWaitOptions(progressOrOptions);
  const fetchImpl = options.fetchImpl ?? fetch;
  const started = Date.now();
  const deadline = started + timeoutMs;
  const state: ReadinessState = { attempts: 0, lastError: '' };
  let nextProgressAt = started + READINESS_PROGRESS_INTERVAL_MS;

  while (Date.now() < deadline) {
    try {
      state.attempts += 1;
      const response = await fetchWithTimeout(fetchImpl, url, Math.min(READINESS_ATTEMPT_TIMEOUT_MS, Math.max(1, deadline - Date.now())));
      if (response.status < 500) {
        return;
      }

      state.lastStatus = response.status;
      state.lastError = `HTTP ${response.status}`;
    } catch (error) {
      state.lastError = readableError(error);
    }

    if (options.progress && Date.now() >= nextProgressAt) {
      const elapsedSeconds = Math.round((Date.now() - started) / 1000);
      options.progress.info(`Still waiting for ${url} (${elapsedSeconds}s elapsed of ${formatDuration(timeoutMs)}; last error: ${state.lastError || 'none yet'}).`);
      nextProgressAt += READINESS_PROGRESS_INTERVAL_MS;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await delay(Math.min(READINESS_RETRY_MS, remainingMs));
    }
  }

  throw new Error(await buildAppUnreachableMessage(url, timeoutMs, state, options));
}

function normalizeWaitOptions(progressOrOptions: ProgressReporter | WaitForUrlOptions | undefined): WaitForUrlOptions {
  if (!progressOrOptions) {
    return {};
  }

  if ('info' in progressOrOptions) {
    return { progress: progressOrOptions };
  }

  return progressOrOptions;
}

async function fetchWithTimeout(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { redirect: 'manual', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function buildAppUnreachableMessage(url: string, timeoutMs: number, state: ReadinessState, options: WaitForUrlOptions): Promise<string> {
  const parsedUrl = parseUrl(url);
  const connectionStatus =
    parsedUrl && isLocalhostUrl(parsedUrl) ? await (options.checkConnection ?? checkLocalConnection)(parsedUrl).catch(() => 'error' as const) : 'skipped';
  const diagnosis = diagnoseUnreachableApp(parsedUrl, connectionStatus, state, options);
  const suggestion = await suggestFix(url, parsedUrl, connectionStatus, state, options);
  const lines = [`I couldn't open your app at ${url} after ${formatDuration(timeoutMs)}.`, `What I found: ${diagnosis}`, `Try this: ${suggestion}`];
  const outputTail = options.startDiagnostics?.outputTail().trim();

  if (outputTail) {
    lines.push('', 'Last start-command output:', indent(outputTail));
  }

  return lines.join('\n');
}

function diagnoseUnreachableApp(
  parsedUrl: URL | undefined,
  connectionStatus: ConnectionStatus,
  state: ReadinessState,
  options: WaitForUrlOptions
): string {
  const exitSummary = options.startDiagnostics?.exitSummary();
  if (exitSummary) {
    return `your start command ${exitSummary} before the app became reachable.`;
  }

  if (state.lastStatus && state.lastStatus >= 500) {
    return `the app answered, but returned HTTP ${state.lastStatus}. That usually means the dev server is crashing or still starting.`;
  }

  if (!parsedUrl) {
    return 'the app URL does not look valid.';
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return `the URL uses ${parsedUrl.protocol}, but browser checks need an http:// or https:// URL.`;
  }

  if (connectionStatus === 'closed') {
    return `nothing seems to be listening on ${formatHostPort(parsedUrl)}.`;
  }

  if (connectionStatus === 'timeout') {
    return `${formatHostPort(parsedUrl)} did not answer the connection check.`;
  }

  if (connectionStatus === 'open') {
    return `${formatHostPort(parsedUrl)} accepts connections, but it did not return a usable HTTP response.`;
  }

  return `${state.lastError || 'the URL never returned a successful response'} after ${state.attempts} attempt${state.attempts === 1 ? '' : 's'}.`;
}

async function suggestFix(
  url: string,
  parsedUrl: URL | undefined,
  connectionStatus: ConnectionStatus,
  state: ReadinessState,
  options: WaitForUrlOptions
): Promise<string> {
  const exitSummary = options.startDiagnostics?.exitSummary();
  if (exitSummary && options.startCommand) {
    return `run ${quoteCommand(options.startCommand)} by itself to see the full error, fix it, then run vibin again.`;
  }

  if (state.lastStatus && state.lastStatus >= 500) {
    return 'check the dev-server terminal for the crash or build error, fix it, then run vibin again.';
  }

  if (!parsedUrl || !['http:', 'https:'].includes(parsedUrl.protocol)) {
    return 'pass a valid app URL like --url http://localhost:3000.';
  }

  if (options.startCommand && connectionStatus === 'closed') {
    return `make sure ${quoteCommand(options.startCommand)} starts the app on ${formatHostPort(parsedUrl)}, or pass --url with the port it actually uses.`;
  }

  const suggestedCommand = options.cwd ? await suggestedStartCommand(options.cwd) : undefined;
  if (suggestedCommand) {
    const commandName = options.commandName ?? 'ui';
    return `try vibin ${commandName} --start-command ${quoteCommand(suggestedCommand)} --url ${url}. If your app uses a different port, replace the --url value.`;
  }

  if (connectionStatus === 'closed') {
    return 'start your dev server first, then run vibin again. If your app uses a different port, pass --url with that address.';
  }

  return 'make sure your dev server is running and the --url value points to the browser URL you can open locally.';
}

async function suggestedStartCommand(cwd: string): Promise<string | undefined> {
  try {
    const packageJson = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
    const scripts = packageJson.scripts ?? {};
    for (const scriptName of ['dev', 'start', 'preview']) {
      if (typeof scripts[scriptName] === 'string') {
        return scriptName === 'start' ? 'npm start' : `npm run ${scriptName}`;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function captureStartCommandDiagnostics(child: ReturnType<typeof execaCommand>, command: string): StartCommandDiagnostics {
  let output = '';
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const append = (chunk: Buffer | string) => {
    output = `${output}${chunk.toString()}`.slice(-START_OUTPUT_TAIL_CHARS);
  };

  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });

  return {
    command,
    exitSummary() {
      if (!exited) {
        return undefined;
      }

      if (exited.signal) {
        return `exited after receiving ${exited.signal}`;
      }

      return `exited with code ${exited.code ?? 'unknown'}`;
    },
    outputTail() {
      return output;
    }
  };
}

async function checkLocalConnection(url: URL): Promise<ConnectionStatus> {
  const port = portForUrl(url);
  if (!port) {
    return 'skipped';
  }

  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection({ host: normalizedHostname(url), port });
    const settle = (status: ConnectionStatus) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve(status);
    };

    socket.setTimeout(LOCAL_CONNECTION_TIMEOUT_MS);
    socket.on('connect', () => settle('open'));
    socket.on('timeout', () => settle('timeout'));
    socket.on('error', (error: NodeJS.ErrnoException) => {
      settle(error.code === 'ECONNREFUSED' ? 'closed' : 'error');
    });
  });
}

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function isLocalhostUrl(url: URL): boolean {
  return ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(normalizedHostname(url));
}

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '');
}

function portForUrl(url: URL): number | undefined {
  if (url.port) {
    return Number(url.port);
  }

  if (url.protocol === 'http:') {
    return 80;
  }

  if (url.protocol === 'https:') {
    return 443;
  }

  return undefined;
}

function formatHostPort(url: URL): string {
  return `${normalizedHostname(url)}:${portForUrl(url) ?? 'unknown'}`;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${seconds}s`;
}

function readableError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  if (error.name === 'AbortError') {
    return 'request timed out';
  }

  if (error.cause instanceof Error) {
    return error.cause.message;
  }

  return error.message;
}

function quoteCommand(command: string): string {
  return `"${command.replace(/(["\\$`])/g, '\\$1')}"`;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}
