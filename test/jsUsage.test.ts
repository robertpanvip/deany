import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as ts from 'typescript';
import { convertSource } from '../src/convert.js';
import { createUsageResolver } from '../src/inferAny.js';
import { checkStrict } from '../src/check.js';
import { functionNameSuggestsReturnType } from '../src/inferAny/constants.js';

/** Convert JS then verify the emitted TypeScript compiles under --strict. */
function convertJsStrict(source: string): { output: string; strict: ReturnType<typeof checkStrict> } {
  const output = convertJs(source);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'js-strict-'));
  const file = path.join(dir, 'case.ts');
  fs.writeFileSync(file, output, 'utf8');
  try {
    return { output, strict: checkStrict(file, output) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

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

function convertJs(source: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'js-infer-'));
  const file = path.join(directory, 'case.js');
  fs.writeFileSync(file, source, 'utf8');
  try {
    const resolver = createUsageResolver([file], compilerOptions);
    const result = convertSource(file, source, { banner: false }, resolver);
    assert.equal(result.diagnostics.length, 0);
    return result.output;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('infers an undocumented JS variable from assignment', () => {
  const output = convertJs(`
let count;
count = 42;
`);
  assert.match(output, /let count: number;/);
});

test('infers an undocumented JS parameter from arithmetic use', () => {
  const output = convertJs(`
function addOne(value) {
  return value + 1;
}
`);
  assert.match(output, /function addOne\(value: number\): number/);
});

test('infers a JS variable from a typed call site', () => {
  const output = convertJs(`
/**
 * @param {number} n
 */
function takeNumber(n) { return n; }

let amount;
amount = 7;
takeNumber(amount);
`);
  assert.match(output, /let amount: number;/);
});

test('infers a JS array element type from assignment', () => {
  const output = convertJs(`
let names;
names = ['a', 'b'];
`);
  assert.match(output, /let names: Array<string>;/);
});

test('falls back to unknown when JS usage gives no evidence', () => {
  const output = convertJs(`
let mystery;
`);
  assert.match(output, /let mystery: unknown;/);
});

test('JSDoc still takes priority over usage inference', () => {
  const output = convertJs(`
/** @param {string} label */
function show(label) { return label + 1; }
`);
  assert.match(output, /function show\(label: string\)/);
});

test('propagates an inferred JS return type into a receiving variable', () => {
  const output = convertJs(`
function load() { return 42; }
let snapshot = load();
let alias = snapshot;
`);
  assert.match(output, /function load\(\): number/);
  assert.match(output, /let snapshot: number = load\(\);/);
  assert.match(output, /let alias: number = snapshot;/);
});

test('annotates JS functions without a value return as void', () => {
  const output = convertJs(`
function noop() {}
function bare() { return; }
async function later() { await Promise.resolve(1); }
function value() { return 42; }
`);
  assert.match(output, /function noop\(\): void/);
  assert.match(output, /function bare\(\): void/);
  assert.match(output, /async function later\(\): Promise<void>/);
  assert.match(output, /function value\(\): number/);
});

test('infers an undocumented JS variable as object from Object.defineProperty', () => {
  const output = convertJs(`
let config;
Object.defineProperty(config, 'key', { value: 1 });
`);
  assert.match(output, /let config: object;/);
});

// --- 2.1: map/set generic inference from mutations (no annotation, no JSDoc) ---
test('infers new Map() generics from set(key, value) mutations', () => {
  const output = convertJs(`
const m = new Map();
m.set('k', 1);
const v = m.get('k');
`);
  assert.match(output, /const m: Map<string, number> = new Map\(\);/);
  assert.match(output, /const v: number \| undefined = m\.get\('k'\);/);
});

test('infers new Set() element type from add(value) mutations', () => {
  const output = convertJs(`
const s = new Set();
s.add(1);
s.add('x');
`);
  assert.match(output, /const s: Set<\(?number \| string\)?> = new Set\(\);/);
});

test('infers map generics when set() arguments are themselves inferred calls', () => {
  const output = convertJs(`
const m = new Map();
m.set(makeKey(), makeValue());
function makeKey() { return 'k'; }
function makeValue() { return 1; }
`);
  // set() arguments are real calls with inferred types, so this should still
  // resolve to concrete slots rather than falling back to unknown.
  assert.match(output, /const m: Map<string, number> = new Map\(\);/);
});

// --- 2.2: constructor parameters inferred from new-expression call sites ---
test('infers undocumented constructor parameters and promoted fields from new Point(1, 2)', () => {
  const output = convertJs(`
class Point { constructor(x, y) { this.x = x; this.y = y; } }
const p = new Point(1, 2);
`);
  assert.match(output, /constructor\(x: number, y: number\)/);
  assert.match(output, /x!: number;/);
  assert.match(output, /y!: number;/);
});

test('constructor parameters respect mismatched call-site argument types', () => {
  const output = convertJs(`
class Box { constructor(value) { this.value = value; } }
new Box('text');
`);
  assert.match(output, /constructor\(value: string\)/);
  assert.match(output, /value!: string;/);
});

// --- 2.4: purely numeric operators infer number operands; + stays conservative ---
test('infers number operands from minus and divide without a call site', () => {
  const output = convertJs(`
function sub(a, b) { return a - b; }
function div(a, b) { return a / b; }
`);
  assert.match(output, /function sub\(a: number, b: number\): number/);
  assert.match(output, /function div\(a: number, b: number\): number/);
});

test('anchor-less + falls back to any params and string|number return; numeric name gives weak number params', () => {
  // `+` may be numeric addition or string concat. With a neutral function name
  // and no other evidence, the parameters fall back to `any` (faithful to the
  // original implicit-any JS) so `a + b` is legal under strict — NOT `unknown`,
  // which would be TS18046. A numeric-accumulator name (`add`) is a weak hint
  // that makes the PARAMETERS `number`, still overridable by real evidence.
  // The RETURN is `string | number` for an anchor-less `+`: that is the honest
  // JS result type and strictly more informative than `unknown`, while safe for
  // both numeric and string operands. (Round 13; round 12 kept it `unknown`.)
  const neutral = convertJs(`
function combine(a, b) { return a + b; }
`);
  assert.match(neutral, /function combine\(a: any, b: any\): string \| number/);

  const named = convertJs(`
function add(a, b) { return a + b; }
`);
  // Named `add`: params get the weak `number` hint; the + now has a number
  // anchor so the return is the concrete `number` (real evidence wins over the
  // string|number fallback).
  assert.match(named, /function add\(a: number, b: number\): number/);
});

test('an opaque return branch keeps the function return unknown, not a lie', () => {
  // `return x[0]` is opaque while x is implicit any. Dropping that branch
  // would let `return x` define an over-narrow return type, which strict mode
  // rejects (TS2322) because the opaque element is really returned.
  const output = convertJs(`
function head(x) {
  if (Array.isArray(x)) return x[0];
  return x;
}
`);
  assert.match(output, /function head\(x: (?:Array<number> \| unknown\[\]|unknown\[\])\): unknown/);
});

test('opaque in-operator return widens the function return instead of narrowing', () => {
  const output = convertJs(`
function len(x) {
  if ('length' in x) return x.length;
  return 0;
}
`);
  assert.match(output, /function len\(x:.*\): (?:unknown|number \| unknown|unknown \| number)/);
});

test('an unknowable call result collapses the whole function return to bare unknown', () => {
  // `typeof x === 'function'` narrows x to a bare Function; `x()` can return
  // literally anything, so it is opaque/unknown. Because `unknown | T` is just
  // `unknown`, the honest return type is `unknown` — NOT a misleading union
  // like `boolean | null | string | unknown` that claims the other branches
  // are knowable. The parameter must still recover its four clean members.
  const output = convertJs(`
function f(x) {
  if (typeof x === 'string') return x.toUpperCase();
  if (typeof x === 'number') return x.toFixed(2);
  if (typeof x === 'boolean') return !x;
  if (typeof x === 'function') return x();
  return null;
}
`);
  assert.match(output, /function f\(x: Function \| boolean \| number \| string\): unknown/);
  assert.doesNotMatch(output, /\): (?:[^)]*\|[^)]*unknown|unknown \|)/);
});

// --- Round 15: function-name -> RETURN TYPE weak hints ---------------------

test('R15-1: function-name return hints map boolean/array/string (+ get prefix)', () => {
  // Predicate prefixes win; a `get` prefix is stripped before matching.
  assert.equal(functionNameSuggestsReturnType('isReady'), 'boolean');
  assert.equal(functionNameSuggestsReturnType('hasItems'), 'boolean');
  assert.equal(functionNameSuggestsReturnType('canEdit'), 'boolean');
  assert.equal(functionNameSuggestsReturnType('shouldRetry'), 'boolean');
  assert.equal(functionNameSuggestsReturnType('enabled'), 'boolean');
  assert.equal(functionNameSuggestsReturnType('valid'), 'boolean');
  assert.equal(functionNameSuggestsReturnType('getItems'), 'unknown[]');
  assert.equal(functionNameSuggestsReturnType('getNames'), 'unknown[]');
  assert.equal(functionNameSuggestsReturnType('listUsers'), 'unknown[]');
  assert.equal(functionNameSuggestsReturnType('getName'), 'string');
  assert.equal(functionNameSuggestsReturnType('getText'), 'string');
  assert.equal(functionNameSuggestsReturnType('getTitle'), 'string');
  // Neutral names give no return hint.
  assert.equal(functionNameSuggestsReturnType('combine'), undefined);
  assert.equal(functionNameSuggestsReturnType('head'), undefined);
});

test('R15-2: boolean/array/string function names set the return type with an asserted opaque return', () => {
  // The name decides the return; an opaque `return x` (implicit-any param ->
  // unknown) gets an `as` assertion so the concrete return stays strict-legal.
  const bool = convertJsStrict(`function isReady(x) { return x; }\n`);
  assert.match(bool.output, /function isReady\(x: unknown\): boolean \{ return x as boolean; \}/);
  assert.ok(bool.strict.ok, bool.strict.diagnostics.join('\n'));

  const str = convertJsStrict(`function getName(o) { return o.name; }\n`);
  assert.match(str.output, /function getName\(o: [^)]*\): string \{ return o\.name as string; \}/);
  assert.ok(str.strict.ok, str.strict.diagnostics.join('\n'));

  const arr = convertJsStrict(`function getItems(x) { return x; }\n`);
  assert.match(arr.output, /function getItems\(x: unknown\): unknown\[\] \{ return x as unknown\[\]; \}/);
  assert.ok(arr.strict.ok, arr.strict.diagnostics.join('\n'));
});

test('R15-3: real return evidence overrides the name hint (no bogus assertion)', () => {
  // `return this.ready = true` gives a real boolean source; the name hint is
  // not applied, so no `as` is inserted and the natural type stands.
  const out = convertJs(`
class C { constructor(){ this.ready = true; } isReady() { return this.ready; } }
`);
  assert.match(out, /isReady\(\): boolean \{ return this\.ready; \}/);
  assert.doesNotMatch(out, /as boolean/);
  // A `getItems` whose body returns a concrete boolean must NOT be forced to
  // an array — real evidence wins over the name.
  const conflict = convertJs(`function getItems() { return true; }\n`);
  assert.match(conflict, /function getItems\(\): boolean/);
  assert.doesNotMatch(conflict, /unknown\[\]/);
});

test('R15-4: numeric function names hint parameters only, never the return', () => {
  // `count` is a numeric name: its parameter gets the number hint, but the
  // return is NOT forced to number by the name (opaque `.length` stays unknown).
  const count = convertJsStrict(`function count(items) { return items.length; }\n`);
  assert.match(count.output, /function count\(items:/);
  assert.doesNotMatch(count.output, /\): number/);
  assert.ok(count.strict.ok, count.strict.diagnostics.join('\n'));
  // sum(a,b) with `+`: parameters get number, the `+` has a number anchor, so
  // the concrete number return is real evidence (round 13), not a name guess.
  const sum = convertJsStrict(`function sum(a, b) { return a + b; }\n`);
  assert.match(sum.output, /function sum\(a: number, b: number\): number/);
  assert.ok(sum.strict.ok, sum.strict.diagnostics.join('\n'));
});

test('R15-5: expression-bodied arrow return hint is asserted too', () => {
  const out = convertJsStrict(`const isReady = x => x;\n`);
  assert.match(out.output, /const isReady = \(x: unknown\): boolean => x as boolean/);
  assert.ok(out.strict.ok, out.strict.diagnostics.join('\n'));
});

test('R15-6: opaque-return assertion excludes nested function returns and handles composite/async', () => {
  // The opaque value returned through a nested call is asserted; the nested
  // function's own return is left to its own signature (no double assertion).
  const nested = convertJsStrict(`function isReady(x){ return (function inner(v){ return v; })(x); }\n`);
  assert.ok(nested.strict.ok, nested.strict.diagnostics.join('\n'));
  assert.match(nested.output, /\) as boolean/);
  // A compound expression is parenthesized before asserting.
  const compound = convertJsStrict(`function getReady(a, b){ return a && b; }\n`);
  assert.ok(compound.strict.ok, compound.strict.diagnostics.join('\n'));
  // async: the assertion uses the inner type, the signature wraps in Promise.
  const asyncCase = convertJsStrict(`async function isReady(x){ return x; }\n`);
  assert.match(asyncCase.output, /Promise<boolean>\{ return x as boolean; \}/);
  assert.ok(asyncCase.strict.ok, asyncCase.strict.diagnostics.join('\n'));
  // Mixed concrete+opaque branches keep the honest `unknown` return (no name
  // hint applied), so no assertion is injected.
  const mixed = convertJsStrict(`function isReady(x){ if(x) return x; return false; }\n`);
  assert.match(mixed.output, /\): unknown/);
  assert.ok(mixed.strict.ok, mixed.strict.diagnostics.join('\n'));
});
