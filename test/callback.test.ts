import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as ts from 'typescript';
import { convertSource } from '../src/convert.js';
import { checkStrict } from '../src/check.js';
import { createUsageResolver } from '../src/inferAny.js';
import { callbackReceiverHasJSDocType } from '../src/convert/callback.js';
import { parseJsDocBlocks } from '../src/jsdoc.js';

const compilerOptions: ts.CompilerOptions = {
  allowJs: true,
  checkJs: true,
  noEmit: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  skipLibCheck: true,
};

/** Convert JS through the full usage-resolver pipeline (as the CLI does). */
function convertWithResolver(source: string, withResolver = true): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'callback-'));
  const file = path.join(directory, 'case.js');
  fs.writeFileSync(file, source, 'utf8');
  try {
    const resolver = withResolver ? createResolver(file) : undefined;
    const result = convertSource(file, source, { banner: false }, resolver);
    return result.output;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function createResolver(file: string) {
  return createUsageResolver([file], compilerOptions);
}

test('annotates callback params that lack contextual typing', () => {
  const output = convertWithResolver(`
function eachUnknown(fn) {}
eachUnknown(function(value, key, collection) {});
`);
  assert.match(output, /function\(value: unknown, key: unknown, collection: unknown\)/);
});

test('leaves contextually-typed map callback params unannotated', () => {
  const output = convertWithResolver(`
const arr = [1, 2, 3];
arr.map(x => x + 1);
`);
  // `x` gets its type from Array.map; adding `: unknown` would break inference.
  assert.match(output, /arr\.map\(x => x \+ 1\)/);
  assert.doesNotMatch(output, /x: unknown/);
});

test('annotates implicit-any single-arg arrow by adding parentheses', () => {
  const output = convertWithResolver(`
function eachUnknown(fn) {}
eachUnknown(x => x);
`);
  // Must become `(x: unknown) => x`, not `x: unknown => x` (syntax error).
  assert.match(output, /\(x: unknown\) => x/);
  // The annotation must not introduce any TS7006 (implicit any) diagnostics.
  const check = checkStrict('case.ts', output);
  assert.equal(check.diagnostics.some((d) => d.includes('TS7006')), false);
});

test('callback annotations remove implicit-any diagnostics', () => {
  const output = convertWithResolver(`
function eachUnknown(fn) {}
eachUnknown(function(value, key) { return value; });
`);
  assert.match(output, /function\(value: unknown, key: unknown\)/);
  const check = checkStrict('case.ts', output);
  assert.equal(check.diagnostics.some((d) => d.includes('TS7006')), false);
});

test('JSDoc-typed receiver is matched by symbol, not by same name in another scope', () => {
  // Regression: callbackReceiverHasJSDocType used to match `declName.text ===
  // receiverName` across the whole file, so `bar(nums)` (no JSDoc) was wrongly
  // treated as typed because `foo(nums)` elsewhere had `@param {number[]}`.
  // That skipped annotating bar's callback and could leave `x` an implicit any.
  const source = `
/** @param {number[]} nums */
function foo(nums) { return nums.map(x => x * 2); }
function bar(nums) { return nums.map(x => x.length); }
`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'callback-symbol-'));
  const file = path.join(directory, 'case.js');
  fs.writeFileSync(file, source, 'utf8');
  try {
    const resolver = createUsageResolver([file], compilerOptions);
    // Nodes must come from the resolver's own program: symbols are checker-specific,
    // so mixing a separately-created program's nodes would break identity matches.
    const sourceFile = resolver.getSourceFile(file)!;
    const blocks = parseJsDocBlocks(source);

    const arrows: ts.ArrowFunction[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isArrowFunction(n)) arrows.push(n);
      ts.forEachChild(n, visit);
    };
    visit(sourceFile);
    assert.equal(arrows.length, 2);

    // foo's arrow: receiver really is the JSDoc-typed `nums` -> true.
    assert.equal(callbackReceiverHasJSDocType(arrows[0]!, resolver, sourceFile, source, blocks), true);
    // bar's arrow: same name `nums`, but a different symbol with no JSDoc -> false.
    assert.equal(callbackReceiverHasJSDocType(arrows[1]!, resolver, sourceFile, source, blocks), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('--no-callback-params equivalent: option disables annotation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'callback-off-'));
  const file = path.join(directory, 'case.js');
  const source = `
function eachUnknown(fn) {}
eachUnknown(function(value, key) {});
`;
  fs.writeFileSync(file, source, 'utf8');
  try {
    const resolver = createUsageResolver([file], compilerOptions);
    const result = convertSource(
      file,
      source,
      { banner: false, annotateUntypedCallbacks: false },
      resolver,
    );
    assert.match(result.output, /function\(value, key\)/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
