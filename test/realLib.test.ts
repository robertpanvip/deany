import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as ts from 'typescript';
import { checkStrict } from '../src/check.js';
import { convertSource } from '../src/convert.js';
import { createUsageResolver, inferAnyInProject } from '../src/inferAny.js';

const jsOptions: ts.CompilerOptions = {
  allowJs: true,
  checkJs: true,
  noEmit: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  skipLibCheck: true,
};

const tsOptions: ts.CompilerOptions = {
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  skipLibCheck: true,
  noEmit: true,
};

function convertJs(source: string): { output: string; diagnostics: readonly string[] } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'real-lib-c js-'));
  const file = path.join(directory, 'case.js');
  fs.writeFileSync(file, source, 'utf8');
  try {
    const resolver = createUsageResolver([file], jsOptions);
    const result = convertSource(file, source, { banner: false }, resolver);
    const strict = checkStrict(file, result.output);
    return { output: result.output, diagnostics: strict.diagnostics };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function inferTs(source: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'real-lib-infer-'));
  const file = path.join(directory, 'case.ts');
  fs.writeFileSync(file, source, 'utf8');
  try {
    const [result] = inferAnyInProject([file], tsOptions);
    return result?.output ?? '';
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('typeof === "function" does not emit the illegal type `function`', () => {
  const output = inferTs(`
function ctorName(val: any) {
  const ctor = val.constructor;
  if (typeof ctor === 'function') return ctor.name;
  return null;
}
`);
  assert.doesNotMatch(output, /:\s*function\b/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('a destructured/probed variable inferred from typeof function is a legal TS type', () => {
  const output = inferTs(`
function probe(x: any) {
  if (typeof x === 'function') return x;
  return null;
}
`);
  assert.doesNotMatch(output, /:\s*function\b/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('catch clause variables are not given an object-shape annotation (TS1196)', () => {
  const { output, diagnostics } = convertJs(`
function kindOf(val) {
  try {
    if (typeof val.length === 'number') return true;
  } catch (err) {
    if (err.message.indexOf('callee') !== -1) return true;
  }
  return false;
}
`);
  assert.doesNotMatch(output, /catch\s*\(\s*\w+\s*:\s*\{/);
  assert.ok(!diagnostics.some((d) => d.includes('TS1196')), diagnostics.join('\n'));
});

test('Object.defineProperty object slot works on a real mimic-fn style function', () => {
  const { output } = convertJs(`
const mimicFn = (to, from) => {
  for (const prop of Reflect.ownKeys(from)) {
    Object.defineProperty(to, prop, Object.getOwnPropertyDescriptor(from, prop));
  }
  return to;
};
module.exports = mimicFn;
`);
  assert.match(output, /\(to: object, from: object\)/);
});

test('infers a callable type for a parameter called as a function (p-try)', () => {
  const output = inferTs(`
function pTry(fn: any, ...args: any[]) {
  return new Promise(resolve => {
    resolve(fn(...args));
  });
}
`);
  assert.match(output, /fn: \(\.\.\.args: unknown\[\]\) => unknown/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('a callee-called any parameter that is also passed around keeps a callable type', () => {
  const output = inferTs(`
function invoke(fn: any) { return fn(1, 2); }
`);
  assert.match(output, /fn: \(\.\.\.args: unknown\[\]\) => unknown/);
});

test('new on an any parameter infers a construct signature', () => {
  const output = inferTs(`
function create(Ctor: any) { return new Ctor(); }
`);
  assert.doesNotMatch(output, /Ctor: unknown/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('a callee-called any with a concrete call-site argument keeps the concrete signature', () => {
  const output = inferTs(`
function apply(fn: any) { return fn(1); }
declare function inc(n: number): number;
apply(inc);
`);
  // The concrete signature from the call site must win over the generic callable hint.
  assert.match(output, /fn: \(n: number\) => number/);
});
