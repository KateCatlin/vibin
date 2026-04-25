import { promises as fs } from 'node:fs';
import path from 'node:path';

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  'vendor'
]);

const TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.env',
  '.go',
  '.html',
  '.js',
  '.jsx',
  '.json',
  '.mjs',
  '.php',
  '.prisma',
  '.py',
  '.rb',
  '.rs',
  '.sql',
  '.ts',
  '.tsx',
  '.vue',
  '.yaml',
  '.yml'
]);

export interface ProjectFile {
  absolutePath: string;
  relativePath: string;
}

export async function collectProjectFiles(cwd: string): Promise<ProjectFile[]> {
  const files: ProjectFile[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          await walk(path.join(current, entry.name));
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const absolutePath = path.join(current, entry.name);
      const relativePath = path.relative(cwd, absolutePath);
      if (isLikelyTextFile(relativePath)) {
        files.push({ absolutePath, relativePath });
      }
    }
  }

  await walk(cwd);
  return files;
}

export async function readTextFile(file: ProjectFile, maxBytes = 250_000): Promise<string | undefined> {
  const stat = await fs.stat(file.absolutePath);
  if (stat.size > maxBytes) {
    return undefined;
  }

  return fs.readFile(file.absolutePath, 'utf8');
}

export function lineNumberForIndex(contents: string, index: number): number {
  return contents.slice(0, index).split('\n').length;
}

function isLikelyTextFile(relativePath: string): boolean {
  const basename = path.basename(relativePath);
  if (basename.startsWith('.env')) {
    return true;
  }

  return TEXT_EXTENSIONS.has(path.extname(relativePath));
}
