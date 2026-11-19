import * as fs from 'node:fs';
import * as path from 'node:path';
import { convertSource } from './convert.js';
import type { UsageResolver } from './inferAny.js';
import { loadDeclarations } from './dts.js';
import type { ConvertOptions, ConvertResult } from './types.js';

// Only genuine dependency/VCS directories are skipped. `dist` used to be here
// unconditionally, which silently dropped any user source folder named `dist`,
// and `.codebuddy` was an author-machine leftover. A generated output folder is
// the caller's responsibility (it chooses the output path); discovery must not
// hide valid inputs.
const SKIP_DIRECTORIES = new Set(['node_modules', '.git']);
const JS_EXTENSIONS = ['.js', '.mjs', '.cjs', '.jsx'];

function isJsFile(name: string): boolean {
  return JS_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** Recursively collect JavaScript sources (.js/.mjs/.cjs/.jsx). */
export function collectJsFiles(input: string): string[] {
  const stat = fs.statSync(input);
  if (stat.isFile()) {
    return isJsFile(input) ? [input] : [];
  }
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) {
          walk(path.join(directory, entry.name));
        }
      } else if (entry.isFile() && isJsFile(entry.name)) {
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

/** Default output path for one input file: `foo.js`/`foo.mjs` -> `foo.ts`. */
export function defaultOutputPath(input: string, sourceDir?: string, outDir?: string): string {
  const relative = sourceDir === undefined ? path.basename(input) : path.relative(sourceDir, input);
  const tsName = relative.replace(/\.(js|mjs|cjs|jsx)$/, '.ts');
  return outDir === undefined ? tsName : path.join(outDir, tsName);
}

export interface FileError {
  readonly file: string;
  readonly message: string;
}

export interface BatchResult {
  readonly results: readonly ConvertResult[];
  readonly written: readonly string[];
  /** Files that could not be processed; the batch continued past each one. */
  readonly errors: readonly FileError[];
}

/** Convert a file or a directory tree and write the generated `.ts` files. */
export function convertPath(
  input: string,
  output: string | undefined,
  options: Partial<ConvertOptions>,
  resolver?: UsageResolver,
  useDts = true,
): BatchResult {
  const stat = fs.statSync(input);
  const sourceDir = stat.isDirectory() ? input : undefined;
  const outDir = stat.isDirectory() ? (output ?? `${input}-ts`) : undefined;
  const files = collectJsFiles(input);
  const results: ConvertResult[] = [];
  const written: string[] = [];
  const errors: FileError[] = [];

  for (const file of files) {
    try {
      const source = fs.readFileSync(file, 'utf8');
      const target =
        sourceDir === undefined
          ? (output ?? defaultOutputPath(file))
          : defaultOutputPath(file, sourceDir, outDir);
      // A sibling `<name>.d.ts` is the authoritative contract for this JS file.
      // Its signatures are combined with the implementation during conversion
      // unless the caller opts out with --no-dts.
      const declarations = useDts ? loadDeclarations(file) : undefined;
      const result = convertSource(
        resolver === undefined ? path.basename(file) : path.resolve(file),
        source,
        options,
        resolver,
        declarations,
      );
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, result.output, 'utf8');
      results.push(result);
      written.push(target);
    } catch (error) {
      // One pathological file (e.g. a huge input that trips a TypeScript
      // RangeError) must not abort the whole batch. Record and continue.
      errors.push({ file, message: error instanceof Error ? error.message : String(error) });
    }
  }

  return { results, written, errors };
}
