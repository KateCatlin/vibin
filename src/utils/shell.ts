import { execa } from 'execa';

export interface ShellRunOptions {
  cwd?: string;
  timeout?: number;
  input?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ShellResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type ShellRunner = (file: string, args: readonly string[], options?: ShellRunOptions) => Promise<ShellResult>;

export const defaultShellRunner: ShellRunner = async (file, args, options = {}) => {
  const result = await execa(file, [...args], {
    reject: false,
    cwd: options.cwd,
    timeout: options.timeout,
    input: options.input,
    env: options.env
  });
  return {
    exitCode: result.exitCode ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  };
};
