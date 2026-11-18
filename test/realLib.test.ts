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

test('index access and for-in infer an indexable object for an any binding (xtend)', () => {
  const output = inferTs(`
function extend(target: any) {
  for (let i = 1; i < arguments.length; i++) {
    const source: any = arguments[i];
    for (const key in source) {
      target[key] = source[key];
    }
  }
  return target;
}
`);
  assert.match(output, /target: Record<PropertyKey, unknown>/);
  assert.match(output, /source: Record<PropertyKey, unknown>/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('Object(value) boxes to an indexable object so JS copy loops stay strict', () => {
  const { diagnostics, output } = convertJs(`
function toObject(val) {
  if (val === null || val === undefined) throw new TypeError('nope');
  return Object(val);
}
function assign(target, source) {
  var to = toObject(target);
  var from = Object(source);
  for (var key in from) {
    to[key] = from[key];
  }
  return to;
}
module.exports = assign;
`);
  assert.ok(!diagnostics.some((d) => d.includes('TS2407') || d.includes('TS18046')), diagnostics.join('\n'));
  assert.match(output, /to: Record<PropertyKey, unknown>/);
});

test('element access on an any binding infers an indexable object', () => {
  const output = inferTs(`
function get(x: any, k: string) { return x[k]; }
`);
  assert.match(output, /x: Record<PropertyKey, unknown>/);
});

test('a concrete array source is not overwritten by the indexable-object hint', () => {
  const output = inferTs(`
function first(x: any) { return x[0]; }
first([1, 2, 3]);
`);
  assert.match(output, /x: (Array<number>|number\[\])/);
});

test('an empty object literal used as a dictionary becomes indexable (JS)', () => {
  const { output, diagnostics } = convertJs(`
function build() {
  var bag = {};
  bag['x'] = 1;
  bag[0] = 2;
  return bag;
}
`);
  assert.match(output, /bag: Record<PropertyKey, unknown>/);
  assert.ok(!diagnostics.some((d) => d.includes('TS7053')), diagnostics.join('\n'));
});

test('a boxed primitive stays its concrete type rather than an invented any', () => {
  // Boxed primitives are not assignable to Record<PropertyKey, unknown>, so a
  // `wrapped[k] = v` write cannot be made strict without inventing `any`. Keep
  // the concrete `String` type (the remaining TS2542 is an inherent limit).
  const { output } = convertJs(`
function probe() {
  var wrapped = new String('abc');
  wrapped[5] = 'de';
  return wrapped;
}
`);
  assert.match(output, /wrapped: String/);
  assert.doesNotMatch(output, /wrapped: any/);
});

// --- A-tier evidence: strong signals, low risk ---

test('a parameter default value infers the parameter type', () => {
  const output = inferTs(`
function f(x: any = 5) { return x; }
`);
  assert.match(output, /x: number = 5/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('bitwise operators infer a numeric operand', () => {
  const output = inferTs(`
function trunc(x: any) { return x | 0; }
function flip(y: any) { return ~y; }
function shift(a: any, b: any) { return a << b; }
`);
  assert.match(output, /x: number/);
  assert.match(output, /y: number/);
  assert.match(output, /a: number/);
  assert.match(output, /b: number/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('relational comparison infers number or string operands', () => {
  const output = inferTs(`
function gt(x: any) { return x > 10; }
function lt(y: any) { return y < 'z'; }
`);
  assert.match(output, /x: \(?number \| string\)?/);
  assert.match(output, /y: \(?number \| string\)?/);
});

test('the right operand of the in operator infers an object', () => {
  const output = inferTs(`
function has(o: any) { return 'foo' in o; }
`);
  assert.match(output, /o: object/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

// --- B-tier evidence: structural signals, medium risk ---

test('for-of target infers an iterable even without a call-site source', () => {
  const output = inferTs(`
function fo(x: any) { for (const v of x) void v; }
`);
  assert.match(output, /x: (unknown\[\]|Iterable<unknown>)/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('array destructuring infers an array source', () => {
  const output = inferTs(`
function d(x: any) { const [a, b] = x; return a; }
`);
  assert.match(output, /x: (unknown\[\]|Iterable<unknown>)/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('object destructuring infers an object shape on the source', () => {
  const output = inferTs(`
function d(x: any) { const { foo, bar } = x; return foo; }
`);
  assert.match(output, /x: \{ (bar|foo): unknown; (bar|foo): unknown; \}/);
});

test('await operand infers a thenable', () => {
  const output = inferTs(`
async function a(x: any) { return await x; }
`);
  assert.match(output, /x: (PromiseLike<unknown>|Promise<unknown>|unknown)/);
  assert.doesNotMatch(output, /x: any/);
});

test('logical fallback and ternary branches infer a union', () => {
  const output = inferTs(`
function fb(x: any) { return x || 'fallback'; }
function tern(x: any) { return true ? x : 42; }
`);
  assert.match(output, /x: string/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

// --- Strong evidence not yet recognized: exponentiation / annotated assignment target / spread / logical assignment ---

test('exponentiation infers a numeric operand', () => {
  const output = inferTs(`
function pow(x: any) { return x ** 2; }
`);
  assert.match(output, /x: number/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('assignment into an annotated target constrains the source', () => {
  const output = inferTs(`
function f(x: any) { const n: number = x; return n; }
`);
  assert.match(output, /x: number/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('array and call spread targets infer an iterable', () => {
  const output = inferTs(`
function spread(x: any) { return [...x]; }
function invoke(f: Function, args: any) { return f(...args); }
`);
  assert.match(output, /x: (unknown\[\]|Iterable<unknown>)/);
  assert.match(output, /args: (unknown\[\]|Iterable<unknown>)/);
});

test('logical assignment infers the assigned value type', () => {
  const output = inferTs(`
function or(x: any) { x ||= 5; }
function nn(x: any) { x ??= 'fb'; }
function and(x: any) { x &&= true; }
`);
  assert.match(output, /x: number/);
  assert.match(output, /x: string/);
  assert.match(output, /x: boolean/);
});

test('logical assignment infers the type in JS implicit-any mode', () => {
  const { output, diagnostics } = convertJs(`
function probe(x) { x ||= 7; return x; }
`);
  assert.match(output, /x: number/);
  assert.ok(!diagnostics.some((d) => d.includes('TS18046')), diagnostics.join('\n'));
});

// --- Array element shape from iteration callback property chains ---

test('Array.isArray + map deep property chain infers an array of shaped objects (TS)', () => {
  const output = inferTs(`
function f(x: any) {
  if (Array.isArray(x)) {
    x.map(function (item) { return item.a.b.c; });
  }
}
`);
  assert.match(output, /x: Array<\{ a: \{ b: \{ c: unknown; \}; \}; \}>/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('iteration callback element shape merges multiple property chains', () => {
  const output = inferTs(`
function f(xs: any) {
  if (Array.isArray(xs)) {
    xs.forEach(function (it) { void it.name; void it.age.year; });
  }
}
`);
  assert.match(output, /xs: Array<\{ age: \{ year: unknown; \}; name: unknown; \}>/);
});

test('Array.isArray + forEach deep chain infers element shape in JS implicit-any mode', () => {
  const { output, diagnostics } = convertJs(`
function f(xs) {
  if (Array.isArray(xs)) {
    xs.forEach(function (item) { void item.a.b; });
  }
}
`);
  assert.match(output, /xs: Array<\{ a: \{ b: unknown; \}; \}>/);
  // Re-check the emitted code as TypeScript: a redundant `item: unknown`
  // annotation would shadow the element shape and reintroduce TS18046.
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
  assert.ok(
    !diagnostics.some((d) => d.includes('TS18046') || d.includes('TS2339')),
    diagnostics.join('\n'),
  );
});

test('a non-iteration method call adds a custom member without inventing an element shape', () => {
  const output = inferTs(`
function f(x: any) { if (Array.isArray(x)) { x.custom(function (item) { void item.a; }); } }
`);
  // The custom method is a real member and is kept with a typed callback, but
  // the array's element type is NOT guessed from the callback (stays unknown[]).
  assert.match(output, /unknown\[\] & \{ custom:/);
  assert.match(output, /custom: \(callback: \(arg: \{ a: unknown; \}\) => void\) => unknown/);
  assert.doesNotMatch(output, /Array<\{ a:/);
});

test('typeof object narrowing + method call stays strict-clean in JS implicit-any mode', () => {
  const { output, diagnostics } = convertJs(`
function f(x) {
  if (typeof x === 'object' && x !== null) { x.render(); }
}
`);
  assert.match(output, /x: object & \{ render:/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
  assert.ok(!diagnostics.some((d) => d.includes('TS2339')), diagnostics.join('\n'));
});

test('in-operator narrowing + method call stays strict-clean in JS implicit-any mode', () => {
  const { output } = convertJs(`
function f(x) {
  if ('render' in x) { x.render(); }
}
`);
  assert.match(output, /x: object & \{ render:/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('empty array literal absorbs push element types (p-limit promises queue)', () => {
  const { output } = convertJs(`
function f() {
  const promises = [];
  promises.push(Promise.resolve(1));
  return promises;
}
`);
  assert.match(output, /const promises: Array<Promise<number>>/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('empty array pushed with opaque any/await values becomes Array<unknown> not Array<never> (p-map-series)', () => {
  const { output, diagnostics } = convertJs(`
async function f(mapper, iterable) {
  const result = [];
  for (const value of iterable) {
    result.push(await mapper(await value, 0));
  }
  return result;
}
`);
  assert.match(output, /const result: Array<unknown>/);
  assert.doesNotMatch(output, /Array<never>/);
  assert.ok(!diagnostics.some((d) => d.includes('TS2345')), diagnostics.join('\n'));
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('object literal absorbs fields written after construction as optional (p-limit queueItem)', () => {
  const { output } = convertJs(`
function f(reject) {
  const queueItem = { reject };
  queueItem.run = () => {};
  return queueItem;
}
`);
  assert.match(output, /queueItem: \{ reject: any; run\?: \(/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('relational comparison is a constraint, not a union source (p-limit activeCount)', () => {
  const { output } = convertJs(`
function f(limit) {
  let activeCount = 0;
  if (activeCount < limit && activeCount > 0) { activeCount++; }
  return activeCount;
}
`);
  assert.match(output, /let activeCount: number = 0/);
  assert.doesNotMatch(output, /let activeCount: number \| string/);
});

// --- CommonJS require: self-referential module type (inherits / once / wrappy) ---

test('require() initializer uses a non-self-referential module type query (inherits)', () => {
  const output = inferTs(`
declare var module: any;
var util: any = require('util');
if (typeof util.inherits !== 'function') throw '';
module.exports = util.inherits;
`);
  assert.match(output, /var util: typeof import\("util"\)/);
  assert.doesNotMatch(output, /var util: typeof util\b/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('require() with member access stays strict-clean and does not degrade to unknown (fs)', () => {
  const output = inferTs(`
var fs: any = require('fs');
fs.writeFileSync('a', 'b');
`);
  assert.match(output, /var fs: typeof import\("fs"\)/);
  assert.doesNotMatch(output, /var fs: unknown/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('JS implicit-any require() initializer also emits a module type query', () => {
  const { output } = convertJs(`
try {
  var util = require('util');
  if (typeof util.inherits !== 'function') throw '';
  module.exports = util.inherits;
} catch (e) {
  module.exports = {};
}
`);
  assert.match(output, /var util: typeof import\("util"\)/);
  assert.doesNotMatch(output, /var util: typeof util\b/);
});

test('destructured parameter defaults synthesize an optional object shape (decamelize/p-locate)', () => {
  const { output, diagnostics } = convertJs(`
export function f(text, { separator = '_', preserve = false, count = 1 } = {}) {
  return text + separator + preserve + count;
}
`);
  assert.match(output, /\{ separator\?: string; preserve\?: boolean; count\?: number; \}/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('destructured parameter with renamed and quoted keys stays strict-clean', () => {
  const { output } = convertJs(`
export function f({ a: renamed = 1, 'kebab-key': k = 'x', } = {}) {
  return renamed + k;
}
`);
  // The property name (not the local binding) is the object field.
  assert.match(output, /\{ a\?: number; "kebab-key"\?: string; \}/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('void return does not leak into value parameters (p-reduce next/initialValue)', () => {
  const { output } = convertJs(`
export function outer(init, reducer) {
  const inner = a => { return; };
  inner(init);
  return reducer(init);
}
`);
  assert.match(output, /function outer\(init: unknown, reducer:/);
  assert.match(output, /\(a: unknown\): void =>/);
  assert.doesNotMatch(output, /init: void/);
  assert.doesNotMatch(output, /a: void/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('dotted @param tags compose an object shape instead of a bare object (bytes)', () => {
  const { output } = convertJs(`
/**
 * @param {object} [options]
 * @param {number} [options.decimalPlaces=2]
 * @param {string} [options.thousandsSeparator=]
 */
export function format(options) {
  var thousandsSeparator = (options && options.thousandsSeparator) || '';
  var decimalPlaces = (options && options.decimalPlaces !== undefined) ? options.decimalPlaces : 2;
  return thousandsSeparator + decimalPlaces;
}
`);
  assert.match(output, /options\?: \{ decimalPlaces\?: number; thousandsSeparator\?: string; \}/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('required dotted @param tags produce required object fields', () => {
  const { output } = convertJs(`
/**
 * @param {object} options
 * @param {string} options.name
 */
export function greet(options) {
  return 'hi ' + options.name;
}
`);
  assert.match(output, /options: \{ name: string; \}/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});
