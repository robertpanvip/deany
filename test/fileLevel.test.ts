import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import * as ts from 'typescript';
import { checkStrict } from '../src/check.js';
import { convertSource } from '../src/convert.js';
import { createUsageResolver, inferAnyInProject } from '../src/inferAny.js';

/**
 * File-level end-to-end tests.
 *
 * Every test case below reads a COMPLETE source file from `test/fixtures/`
 * from disk, runs the full pipeline against it, and verifies both that the
 * output is `tsc --strict` clean and that specific semantic decisions were
 * made. This complements the many inline-snippet unit tests by exercising
 * whole-file interactions (multiple declarations, exports, cross-file symbol
 * resolution, sibling `.d.ts` contracts) that only appear at file scope.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');

const jsCompilerOptions: ts.CompilerOptions = {
  allowJs: true,
  checkJs: true,
  noEmit: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  skipLibCheck: true,
};

const tsCompilerOptions: ts.CompilerOptions = {
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  skipLibCheck: true,
  noEmit: true,
};

/** Copy one or more fixture files into a fresh temp dir, returning their paths. */
function stage(...names: string[]): { dir: string; paths: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-level-'));
  const paths = names.map((name) => {
    const dest = path.join(dir, path.basename(name));
    fs.copyFileSync(path.join(fixtures, name), dest);
    return dest;
  });
  return { dir, paths };
}

function assertStrict(fileName: string, output: string): void {
  const result = checkStrict(fileName, output);
  assert.ok(result.ok, `expected strict-clean output, got:\n${result.diagnostics.join('\n')}`);
}

function convertFile(file: string): string {
  const source = fs.readFileSync(file, 'utf8');
  const resolver = createUsageResolver([file], jsCompilerOptions);
  return convertSource(file, source, { banner: false }, resolver).output;
}

// ---------------------------------------------------------------------------
// 1. convert: complete JSDoc-annotated module
// ---------------------------------------------------------------------------
test('file-level: convert a complete JSDoc module is strict-clean and preserves its contracts', () => {
  const { dir, paths } = stage('convert/math-utils.js');
  try {
    const file = paths[0];
    const out = convertFile(file);
    assertStrict(path.join(dir, 'math-utils.ts'), out);

    // Generics, typedefs and callbacks from JSDoc survive as real TS constructs.
    assert.match(out, /function firstMatch<T>\(items: Array<T>, predicate: \(arg0: T\) => boolean\): T \| undefined/);
    assert.match(out, /type Point = \{ x: number; y: number; \};/);
    assert.match(out, /type Reducer = \(acc: number, value: number\) => number;/);
    // Class field promotion and default/rest params.
    assert.match(out, /value!: number;/);
    assert.match(out, /constructor\(start: number = 0\)/);
    assert.match(out, /function sum\(\.\.\.ns: number\[\]\): number/);
    // The named export list is intact.
    assert.match(out, /export \{ add, firstMatch, magnitude, shout, Counter, sum \};/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. convert: complete implicit-any JS module (usage-based inference)
// ---------------------------------------------------------------------------
test('file-level: convert a complete JSDoc-light JS module infers every binding from usage', () => {
  const { dir, paths } = stage('convert/js-infer.js');
  try {
    const file = paths[0];
    const out = convertFile(file);
    assertStrict(path.join(dir, 'js-infer.ts'), out);

    assert.match(out, /let count: number;/);
    assert.match(out, /function addOne\(value: number\): number/);
    assert.match(out, /let names: Array<string>;/);
    assert.match(out, /let amount: number;/);
    // With zero usage evidence the tool stays honest: `unknown`, never a guess.
    assert.match(out, /let mystery: unknown;/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. infer-any: complete TS module — strict, byte-idempotent, S4-aware
// ---------------------------------------------------------------------------
test('file-level: infer-any a complete TS module is strict-clean, idempotent, and S4-aware', () => {
  const { dir, paths } = stage('infer-any/data-model.ts');
  try {
    const file = paths[0];
    const [result] = inferAnyInProject([file], tsCompilerOptions);
    assert.ok(result !== undefined);
    assertStrict(file, result.output);

    // Assignment / initializer / return evidence.
    assert.match(result.output, /let count: number;/);
    assert.match(result.output, /const title: string = 'hello';/);
    assert.match(result.output, /function getValue\(\): number/);
    // Conflicting evidence is preserved as a union, not guessed.
    assert.match(result.output, /let unresolved: \(number \| string\);/);
    // Public API parameter stays `any`; internal call site does not narrow it.
    assert.match(result.output, /export function greet\(who: any\): void/);

    // Byte-level idempotency: re-running on the emitted file changes nothing.
    const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-level-2-'));
    try {
      const secondFile = path.join(secondDir, 'data-model.ts');
      fs.writeFileSync(secondFile, result.output, 'utf8');
      const [again] = inferAnyInProject([secondFile], tsCompilerOptions);
      assert.ok(again !== undefined);
      assert.equal(again.output, result.output, 'infer-any must be byte-idempotent on a whole file');
    } finally {
      fs.rmSync(secondDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. cross-file project: evidence propagates across module boundaries
// ---------------------------------------------------------------------------
test('file-level: cross-file project propagates call-site evidence across imports', () => {
  const { dir, paths } = stage('cross-file/util.ts', 'cross-file/app.ts');
  try {
    const [utilFile, appFile] = paths;
    const results = inferAnyInProject([utilFile, appFile], tsCompilerOptions);
    assert.equal(results.length, 2);
    const utilOut = results.find((r) => r.fileName === utilFile)?.output ?? '';
    const appOut = results.find((r) => r.fileName === appFile)?.output ?? '';

    assertStrict(utilFile, utilOut);
    assertStrict(appFile, appOut);

    // `double` is narrowed by the imported call site in app.ts.
    assert.match(utilOut, /export function double\(x: number\): number/);
    // A public param used only in a weak string context stays `any` (S4).
    assert.match(utilOut, /export function greet\(name: any\): string/);
    // Structural method evidence (.toFixed(2)) narrows to number.
    assert.match(utilOut, /export function toFixed2\(value: number\): string/);
    // Callers in app.ts receive the propagated return types.
    assert.match(appOut, /const a: number = double\(21\);/);
    assert.match(appOut, /const b: string = greet\('Ada'\);/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. sibling .d.ts generic contract: type params are injected onto impl
// ---------------------------------------------------------------------------
test('file-level: sibling .d.ts generic contract injects type parameters onto the implementation', () => {
  const { dir, paths } = stage('dts-generic/api.ts', 'dts-generic/api.d.ts');
  try {
    const [implFile] = paths;
    const [result] = inferAnyInProject([implFile, paths[1]], tsCompilerOptions);
    assert.ok(result !== undefined);
    assertStrict(implFile, result.output);

    // Single- and multi-parameter generics from the contract are restored,
    // including the tuple return type — the emitted file compiles cleanly.
    assert.match(result.output, /export function identity<T>\(x: T\): T/);
    assert.match(result.output, /export function pair<T, U>\(first: T, second: U\): \[T, U\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. convert is byte-idempotent on a complete file (re-running does no damage)
// ---------------------------------------------------------------------------
test('file-level: converting the emitted file again is byte-identical', () => {
  const { dir, paths } = stage('convert/js-infer.js');
  try {
    const file = paths[0];
    const first = convertFile(file);
    const secondFile = path.join(dir, 'js-infer-again.js');
    fs.writeFileSync(secondFile, first, 'utf8');
    const second = convertFile(secondFile);
    assert.equal(second, first, 'convert must be byte-idempotent on a whole file');
    assertStrict(path.join(dir, 'js-infer-again.ts'), second);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. determinism: the same whole file always produces the same bytes
// ---------------------------------------------------------------------------
test('file-level: inference is deterministic across independent runs', () => {
  const { dir, paths } = stage('infer-any/data-model.ts');
  const other = stage('infer-any/data-model.ts');
  try {
    const [a] = inferAnyInProject([paths[0]], tsCompilerOptions);
    const [b] = inferAnyInProject([other.paths[0]], tsCompilerOptions);
    assert.ok(a !== undefined && b !== undefined);
    assert.equal(b.output, a.output);
    assert.deepEqual(b.sites.map((s) => [s.line, s.inferred, s.reason]), a.sites.map((s) => [s.line, s.inferred, s.reason]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(other.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8b. review round 5: d.ts variable identity + spread/constructor tuples
// ---------------------------------------------------------------------------
test('file-level: d.ts variable contract stays on the export; spreads become tuples', () => {
  const { dir, paths } = stage('dts-variable/api.ts', 'dts-variable/api.d.ts');
  try {
    const [implFile, dtsFile] = paths;
    const [result] = inferAnyInProject([implFile, dtsFile], tsCompilerOptions);
    assert.ok(result !== undefined);
    assertStrict(implFile, result.output);

    const out = result.output;
    // The exported `config` keeps its d.ts contract; the same-named local in
    // run() is inferred from its own write, not leaked the contract (R5-2).
    assert.match(out, /export const config: Record<string, string>/);
    assert.equal((out.match(/Record<string, string>/g) ?? []).length, 1);
    assert.match(out, /const config: \{ local\?: number; \} = \{\};/);
    // Both the call spread and the constructor spread resolve to the target
    // signature's fixed-argument tuple (R5-1a/b).
    assert.match(out, /function invoke\(args: \[number, string\]\)/);
    assert.match(out, /function build\(args: \[number, string\]\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8. mixed multi-file project: all emitted files stay strict-clean together
// ---------------------------------------------------------------------------
test('file-level: a mixed multi-file project emits all strict-clean files without cross-talk', () => {
  const { dir, paths } = stage(
    'infer-any/data-model.ts',
    'cross-file/util.ts',
    'cross-file/app.ts',
    'dts-generic/api.ts',
    'dts-generic/api.d.ts',
  );
  try {
    const results = inferAnyInProject(paths, tsCompilerOptions);
    assert.equal(results.length, paths.length);
    for (const result of results) {
      assertStrict(result.fileName, result.output);
    }
    // Spot-check that each module kept its own distinct inference outcome.
    const byName = (base: string) => results.find((r) => path.basename(r.fileName) === base)?.output ?? '';
    assert.match(byName('data-model.ts'), /let count: number;/);
    assert.match(byName('util.ts'), /export function double\(x: number\): number/);
    assert.match(byName('app.ts'), /const a: number = double\(21\);/);
    assert.match(byName('api.ts'), /export function identity<T>\(x: T\): T/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
