import * as fs from 'node:fs';
import * as path from 'node:path';
import { convertSource } from './convert.js';
import type { UsageResolver } from './inferAny.js';
import type { ConvertOptions, ConvertResult } from './types.js';

const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.git', '.codebuddy']);

/** Recursively collect `.js` files, skipping generated dependency directories. */
export function collectJsFiles(input: string): string[] {
  const stat = fs.statSync(input);
  if (stat.isFile()) {
    return [input];
  }
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) {
          walk(path.join(directory, entry.name));
        }
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        found.push(path.join(directory, entry.name));
      }
    }
  };
  walk(input);
  return found.sort();
}

/** Recursively collect `.ts` files (excluding declarations), skipping generated directories. */
export function collectTsFiles(input: string): string[] {
  const stat = fs.statSync(input);
  if (stat.isFile()) {
    return input.endsWith('.ts') && !input.endsWith('.d.ts') ? [input] : [];
  }
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) {
          walk(path.join(directory, entry.name));
        }
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        found.push(path.join(directory, entry.name));
      }
    }
  };
  walk(input);
  return found.sort();
}

/** Default output path for one input file: `foo.js` -> `foo.ts`. */
export function defaultOutputPath(input: string, sourceDir?: string, outDir?: string): string {
  const relative = sourceDir === undefined ? path.basename(input) : path.relative(sourceDir, input);
  const tsName = relative.replace(/\.js$/, '.ts');
  return outDir === undefined ? tsName : path.join(outDir, tsName);
}

export interface BatchResult {
  readonly results: readonly ConvertResult[];
  readonly written: readonly string[];
}

/** Convert a file or a directory tree and write the generated `.ts` files. */
export function convertPath(
  input: string,
  output: string | undefined,
  options: Partial<ConvertOptions>,
  resolver?: UsageResolver,
): BatchResult {
  const stat = fs.statSync(input);
  const sourceDir = stat.isDirectory() ? input : undefined;
  const outDir = stat.isDirectory() ? (output ?? `${input}-ts`) : undefined;
  const files = collectJsFiles(input);
  const results: ConvertResult[] = [];
  const written: string[] = [];

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const target =
      sourceDir === undefined
        ? (output ?? defaultOutputPath(file))
        : defaultOutputPath(file, sourceDir, outDir);
    const result = convertSource(
      resolver === undefined ? path.basename(file) : path.resolve(file),
      source,
      options,
      resolver,
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, result.output, 'utf8');
    results.push(result);
    written.push(target);
  }

  return { results, written };
}
