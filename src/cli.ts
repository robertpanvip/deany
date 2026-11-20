#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { checkStrict } from './check.js';
import { strictTsConfig } from './config.js';
import { convertPath, collectJsFiles, collectTsFiles } from './fs.js';
import { inferAnyInProject, readCompilerOptions, createUsageResolver } from './inferAny.js';
import type { ConvertOptions } from './types.js';

const USAGE = `deany — eliminate any: infer strict TypeScript from JSDoc and real usage

Usage:
  deany <input.js|dir> [options]
  deany infer-any <input.ts|dir> --out <path> [options]

  (jsdoc2ts is a backwards-compatible alias for deany)

Options (conversion):
  -o, --out <path>       Output .ts file (single input) or directory (input directory)
      --check            Type-check generated files under tsc --strict before finishing
      --init-config      Write a strict tsconfig.json next to the generated output
      --no-banner        Do not prepend a generated-file banner
      --no-typedef       Do not emit type aliases for @typedef / @callback
      --no-annotate      Leave undocumented parameters/returns without annotations
      --no-infer-usage   Do not infer types from usage for JS declarations
      --no-dts           Ignore a sibling <name>.d.ts instead of using its signatures
      --force            Overwrite an existing output file even if it is not deany-generated
      --no-callback-params  Do not annotate callbacks that lack contextual typing
      --array-shorthand  Emit T[] instead of Array<T>
      --loose            Keep any/*/? as any instead of unknown
      --default-type <t> Fallback type (default: unknown)

Options (infer-any):
  -o, --out <path>       Output .ts file or directory for inferred sources
      --project <path>   tsconfig.json used for type checking
      --check            Strict type-check inferred sources
      --assertions       Also report any inside type assertions
      --quiet            Only print inferred changes, hide unresolved sites
  -h, --help             Show this help

Examples:
  deany src --out ts-src --check --init-config
  deany infer-any src --out ts-inferred --project tsconfig.json --check
`;

type MutableOptions = { -readonly [K in keyof ConvertOptions]?: ConvertOptions[K] };

interface CliArgs {
  readonly input: string;
  readonly output: string;
  readonly options: Partial<ConvertOptions>;
  readonly check: boolean;
  readonly initConfig: boolean;
  readonly inferUsage: boolean;
  readonly useDts: boolean;
  readonly force: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs | undefined {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return undefined;
  }

  let output: string | undefined;
  let check = false;
  let initConfig = false;
  let inferUsage = true;
  let useDts = true;
  let force = false;
  const options: MutableOptions = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    switch (arg) {
      case '-o':
      case '--out':
        output = argv[i + 1];
        i += 1;
        break;
      case '--check':
        check = true;
        break;
      case '--init-config':
        initConfig = true;
        break;
      case '--no-banner':
        options.banner = false;
        break;
      case '--no-typedef':
        options.emitTypedefs = false;
        break;
      case '--no-annotate':
        options.annotateUntyped = false;
        break;
      case '--no-infer-usage':
        inferUsage = false;
        break;
      case '--no-dts':
        useDts = false;
        break;
      case '--force':
        force = true;
        break;
      case '--no-callback-params':
        options.annotateUntypedCallbacks = false;
        break;
      case '--array-shorthand':
        options.arrayShorthand = true;
        break;
      case '--loose':
        options.unknownForLoose = false;
        break;
      case '--default-type':
        options.defaultType = argv[i + 1];
        i += 1;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown option: ${arg}`);
        }
        positional.push(arg);
    }
  }

  if (output === undefined || output.length === 0) {
    throw new Error('Missing --out <path>.');
  }
  if (positional.length !== 1) {
    throw new Error('Exactly one input file or directory is required.');
  }
  if (options.defaultType !== undefined && options.defaultType.length === 0) {
    throw new Error('--default-type requires a non-empty type.');
  }

  return { input: positional[0] ?? '', output, options, check, initConfig, inferUsage, useDts, force };
}

interface InferArgs {
  readonly input: string;
  readonly output: string;
  readonly project?: string;
  readonly check: boolean;
  readonly assertions: boolean;
  readonly quiet: boolean;
}

function parseInferArgs(argv: readonly string[]): InferArgs | undefined {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return undefined;
  }

  let output: string | undefined;
  let project: string | undefined;
  let check = false;
  let assertions = false;
  let quiet = false;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    switch (arg) {
      case '-o':
      case '--out':
        output = argv[i + 1];
        i += 1;
        break;
      case '--project':
        project = argv[i + 1];
        i += 1;
        break;
      case '--check':
        check = true;
        break;
      case '--assertions':
        assertions = true;
        break;
      case '--quiet':
        quiet = true;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown option: ${arg}`);
        }
        positional.push(arg);
    }
  }

  if (output === undefined || output.length === 0) {
    throw new Error('Missing --out <path>.');
  }
  if (positional.length !== 1) {
    throw new Error('Exactly one input file or directory is required.');
  }
  return { input: positional[0] ?? '', output, project, check, assertions, quiet };
}

function convertMain(argv: readonly string[]): number {
  let args: CliArgs | undefined;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  if (args === undefined) {
    return 0;
  }
  if (!fs.existsSync(args.input)) {
    process.stderr.write(`error: input does not exist: ${args.input}\n`);
    return 2;
  }

  const jsFiles = collectJsFiles(args.input).map((file) => path.resolve(file));
  const resolver =
    args.inferUsage && jsFiles.length > 0
      ? createUsageResolver(jsFiles, {
          allowJs: true,
          checkJs: true,
          noEmit: true,
          strict: true,
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          skipLibCheck: true,
        })
      : undefined;

  const { results, written, errors } = convertPath(
    args.input,
    args.output,
    args.options,
    resolver,
    args.useDts,
    args.force,
  );
  for (const result of results) {
    for (const diagnostic of result.diagnostics) {
      process.stderr.write(`${result.fileName}: ${diagnostic.message}\n`);
    }
  }
  for (const file of written) {
    process.stdout.write(`converted -> ${file}\n`);
  }
  // Per-file failures are isolated: report them all at the end instead of
  // letting the first one dump a raw stack trace and abort the batch.
  if (errors.length > 0) {
    for (const error of errors) {
      process.stderr.write(`error: skipped ${error.file}: ${error.message}\n`);
    }
    process.stderr.write(`${errors.length} file(s) failed; ${written.length} converted.\n`);
  }

  if (args.initConfig) {
    const directory = fs.statSync(args.output).isDirectory()
      ? args.output
      : path.dirname(args.output);
    const configPath = path.join(directory, 'tsconfig.json');
    fs.writeFileSync(configPath, strictTsConfig(), 'utf8');
    process.stdout.write(`config   -> ${configPath}\n`);
  }

  if (args.check) {
    let failed = false;
    for (const file of written) {
      const result = checkStrict(file, fs.readFileSync(file, 'utf8'));
      if (!result.ok) {
        failed = true;
        for (const diagnostic of result.diagnostics) {
          process.stderr.write(`${diagnostic}\n`);
        }
      }
    }
    if (failed) {
      process.stderr.write('strict type check failed.\n');
      return 1;
    }
    process.stdout.write('strict type check passed.\n');
  }

  // Partial failures still make the command fail overall, without having
  // aborted the successful conversions.
  return errors.length > 0 ? 1 : 0;
}

function inferMain(argv: readonly string[]): number {
  let args: InferArgs | undefined;
  try {
    args = parseInferArgs(argv);
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  if (args === undefined) {
    return 0;
  }
  if (!fs.existsSync(args.input)) {
    process.stderr.write(`error: input does not exist: ${args.input}\n`);
    return 2;
  }

  const files = collectTsFiles(args.input);
  if (files.length === 0) {
    process.stderr.write('error: no .ts files found.\n');
    return 2;
  }
  const rootNames = files.map((file) => path.resolve(file));
  const compilerOptions: ts.CompilerOptions =
    args.project === undefined
      ? {
          strict: true,
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          skipLibCheck: true,
          noEmit: true,
        }
      : readCompilerOptions(path.resolve(args.project));

  const inputIsDirectory = fs.statSync(args.input).isDirectory();
  const results = inferAnyInProject(rootNames, compilerOptions, {
    includeAssertions: args.assertions,
  });

  let changedFiles = 0;
  let inferredSites = 0;
  let unresolved = 0;
  const written: string[] = [];

  // The fixed point is computed once for the whole program, so every result
  // carries the same diagnostics object. Warn once when it did not converge:
  // a long reverse dependency chain can hit the round cap and leave some
  // bindings only partially inferred — silently emitting that result is worse
  // than telling the caller to raise the cap or restructure the chain.
  const convergence = results[0]?.diagnostics;
  if (convergence !== undefined && !convergence.converged) {
    process.stderr.write(
      `warning: fixed-point inference did not converge after ${convergence.maxRounds} rounds ` +
        `(${convergence.rounds} executed); output for long dependency chains may be incomplete.\n`,
    );
  }

  for (const result of results) {
    const relative = inputIsDirectory ? path.relative(path.resolve(args.input), result.fileName) : path.basename(result.fileName);
    const target = inputIsDirectory ? path.join(args.output, relative) : args.output;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (result.output !== fs.readFileSync(result.fileName, 'utf8')) {
      changedFiles += 1;
    }
    fs.writeFileSync(target, result.output, 'utf8');
    written.push(target);

    for (const site of result.sites) {
      if (site.inferred !== undefined) {
        inferredSites += 1;
        process.stdout.write(`${result.fileName}:${site.line} any -> ${site.inferred}\n`);
      } else {
        unresolved += 1;
        if (!args.quiet) {
          process.stdout.write(`${result.fileName}:${site.line} keep any (${site.reason ?? 'unknown'})\n`);
        }
      }
    }
  }

  process.stdout.write(`files: ${written.length}, changed: ${changedFiles}, inferred sites: ${inferredSites}, unresolved: ${unresolved}\n`);

  if (args.check) {
    let failed = false;
    for (const file of written) {
      const check = checkStrict(file, fs.readFileSync(file, 'utf8'));
      if (!check.ok) {
        failed = true;
        for (const diagnostic of check.diagnostics) {
          process.stderr.write(`${diagnostic}\n`);
        }
      }
    }
    if (failed) {
      process.stderr.write('strict type check failed.\n');
      return 1;
    }
    process.stdout.write('strict type check passed.\n');
  }

  return 0;
}

function main(): number {
  const argv = process.argv.slice(2);
  if (argv[0] === 'infer-any') {
    return inferMain(argv.slice(1));
  }
  return convertMain(argv);
}

process.exitCode = main();
