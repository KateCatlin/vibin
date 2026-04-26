import { execa } from 'execa';

export interface CommandRunOptions {
  timeout?: number;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (file: string, args: readonly string[], options?: CommandRunOptions) => Promise<CommandResult>;

export const defaultCommandRunner: CommandRunner = async (file, args, options = {}) => {
  const result = await execa(file, [...args], { reject: false, timeout: options.timeout });
  return {
    exitCode: result.exitCode ?? null,
    stdout: result.stdout,
    stderr: result.stderr
  };
};

export async function commandWorks(file: string, args: readonly string[], runner: CommandRunner = defaultCommandRunner): Promise<boolean> {
  try {
    const result = await runner(file, args, { timeout: 5_000 });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
