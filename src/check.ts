import * as ts from 'typescript';

export interface CheckResult {
  readonly ok: boolean;
  readonly diagnostics: readonly string[];
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  const where =
    diagnostic.file !== undefined && diagnostic.start !== undefined
      ? (() => {
          const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
          return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1}`;
        })()
      : (diagnostic.file?.fileName ?? 'compiler options');
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  return `${where} - TS${diagnostic.code}: ${message}`;
}

/**
 * Diagnostics that indicate a missing ambient/global type rather than a real
 * error in the generated code. TypeScript 6 no longer auto-includes every
 * `@types/*` package, so Node globals (`module`, `require`, `process`,
 * `NodeJS.*`) are not visible unless `@types/node` is referenced. deany emits
 * those globals verbatim when converting Node JS, so treating them as errors
 * would make the strict gate fail spuriously.
 */
const AMBIENT_MISSING_CODES = new Set<number>([
  2304, // Cannot find name 'X'.
  2503, // Cannot find namespace 'X'.
  2580, // Cannot find name 'X'. Do you need to install type definitions...
  2591, // Cannot find name 'X'. Do you need to install @types/node...
]);

function mentionsNodeGlobal(diagnostic: ts.Diagnostic): boolean {
  if (!AMBIENT_MISSING_CODES.has(diagnostic.code)) {
    return false;
  }
  const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  // TS2591 for a modern `node:` specifier reads: "Cannot find name 'node:path'.
  // Do you need to install type definitions for node?" — it names neither
  // `process` nor `Buffer`, so the global-name whitelist misses it and the
  // @types/node retry never fires. The "type definitions for node" phrase is
  // the reliable marker across both bare globals and `node:` imports.
  if (/type definitions for node/i.test(text)) {
    return true;
  }
  return /\b(module|require|process|global|Buffer|__dirname|__filename|NodeJS)\b/.test(text);
}

/** Try to resolve `@types/node` from the checked file's location. */
function hasNodeTypes(fileName: string, options: ts.CompilerOptions): boolean {
  try {
    const resolved = ts.resolveTypeReferenceDirective(
      'node',
      fileName,
      options,
      ts.sys,
    );
    return (
      resolved?.resolvedTypeReferenceDirective?.resolvedFileName !== undefined
    );
  } catch {
    return false;
  }
}

function collectDiagnostics(
  fileName: string,
  output: string,
  options: ts.CompilerOptions,
): readonly ts.Diagnostic[] {
  const resolved = ts.sys.resolvePath(fileName);
  const host = ts.createCompilerHost(options);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  const baseFileExists = host.fileExists.bind(host);
  const baseReadFile = host.readFile.bind(host);

  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    ts.sys.resolvePath(name) === resolved
      ? ts.createSourceFile(name, output, languageVersion, true, ts.ScriptKind.TS)
      : baseGetSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
  host.fileExists = (name) => ts.sys.resolvePath(name) === resolved || baseFileExists(name);
  host.readFile = (name) =>
    ts.sys.resolvePath(name) === resolved ? output : baseReadFile(name);

  const program = ts.createProgram({ rootNames: [resolved], options, host });
  // Compare by SourceFile identity, not by file-name string. On Windows the
  // compiler normalizes `fileName` to forward slashes while `ts.sys.resolvePath`
  // yields backslashes (and case can differ), so a string comparison silently
  // filters out every diagnostic and makes this gate always pass. The in-memory
  // host serves exactly one source file, so identity is both precise and
  // platform-independent.
  const target = program.getSourceFile(resolved);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file === undefined || diagnostic.file === target);
}

export function checkStrict(
  fileName: string,
  output: string,
  extraOptions: ts.CompilerOptions = {},
): CheckResult {
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    // `dom` supplies browser globals (console, setTimeout, ...) that converted
    // JS commonly references. Without it --check reports spurious TS2584 for
    // perfectly valid code (review 0.1.17 P1-19a).
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    skipLibCheck: true,
    noUncheckedIndexedAccess: true,
    noImplicitOverride: true,
    noFallthroughCasesInSwitch: true,
    ...extraOptions,
  };

  let diagnostics = collectDiagnostics(fileName, output, options);
  // TS6 no longer auto-includes @types/*. If the failures include missing Node
  // globals and @types/node is resolvable from this file, retry once with it
  // explicitly referenced. The extra pass is skipped when node types are
  // already visible (e.g. the caller supplied `types` via extraOptions).
  if (
    diagnostics.some(mentionsNodeGlobal) &&
    options.types === undefined &&
    hasNodeTypes(ts.sys.resolvePath(fileName), options)
  ) {
    diagnostics = collectDiagnostics(fileName, output, { ...options, types: ['node'] });
  }

  return {
    ok: diagnostics.length === 0,
    diagnostics: diagnostics.map(formatDiagnostic),
  };
}
