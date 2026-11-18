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
 * Type-check generated TypeScript in memory under full `strict` mode.
 * No files are written, so this is safe to use as a conversion gate.
 */
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
    lib: ['lib.es2022.d.ts'],
    skipLibCheck: true,
    noUncheckedIndexedAccess: true,
    noImplicitOverride: true,
    noFallthroughCasesInSwitch: true,
    ...extraOptions,
  };

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
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file === undefined || diagnostic.file === target);

  return {
    ok: diagnostics.length === 0,
    diagnostics: diagnostics.map(formatDiagnostic),
  };
}
