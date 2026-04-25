import type { ProgressReporter } from './types.js';
import { formatProgressLine, type TerminalStyleOptions } from './terminal.js';

export interface ProgressReporterOptions extends TerminalStyleOptions {
  enabled?: boolean;
  now?: () => number;
  stream?: {
    isTTY?: boolean;
    write(chunk: string): unknown;
  };
}

export function createProgressReporter(options: ProgressReporterOptions = {}): ProgressReporter | undefined {
  if (options.enabled === false) {
    return undefined;
  }

  const now = options.now ?? Date.now;
  const stream = options.stream ?? process.stderr;
  const startedAt = now();
  const colorOptions = { color: options.color, env: options.env, stream };

  return {
    info(message: string) {
      const elapsedSeconds = ((now() - startedAt) / 1000).toFixed(1);
      stream.write(`${formatProgressLine(message, elapsedSeconds, colorOptions)}\n`);
    }
  };
}

export async function withProgressHeartbeat<T>(
  progress: ProgressReporter | undefined,
  message: string,
  work: Promise<T>,
  intervalMs = 10_000
): Promise<T> {
  if (!progress) {
    return work;
  }

  const timer = setInterval(() => {
    progress.info(message);
  }, intervalMs);

  try {
    return await work;
  } finally {
    clearInterval(timer);
  }
}
