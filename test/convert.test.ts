import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as ts from 'typescript';
import { checkStrict } from '../src/check.js';
import { strictTsConfig } from '../src/config.js';
import { convertSource } from '../src/convert.js';
import { createUsageResolver } from '../src/inferAny.js';

const jsCompilerOptions: ts.CompilerOptions = {
  allowJs: true, checkJs: true, noEmit: true, strict: true,
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true,
};
function convertJsWithResolver(fileName: string, source: string, opts: Parameters<typeof convertSource>[2] = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-'));
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, source, 'utf8');
  try {
    return convertSource(file, source, { banner: false, ...opts }, createUsageResolver([file], jsCompilerOptions)).output;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('annotates function parameters and return types from JSDoc', () => {
  const source = `
/**
 * @param {number} a
 * @param {number} [b=1]
 * @returns {number}
 */
function add(a, b = 1) { return a + b; }
`;
  const { output, diagnostics } = convertSource('add.js', source, { banner: false });
  assert.equal(diagnostics.length, 0);
  assert.match(output, /function add\(a: number, b: number = 1\): number/);
  assert.equal(checkStrict('add.ts', output).ok, true);
});

test('handles generics, JSDoc function types and nullable returns', () => {
  const source = `
/**
 * @template T
 * @param {Array.<T>} items
 * @param {function(T): boolean} predicate
 * @returns {T | undefined}
 */
function firstMatch(items, predicate) {
  for (const item of items) {
    if (predicate(item)) return item;
  }
  return undefined;
}
`;
  const { output } = convertSource('first.js', source, { banner: false });
  assert.match(output, /function firstMatch<T>\(items: Array<T>, predicate: \(arg0: T\) => boolean\): T \| undefined/);
  assert.equal(checkStrict('first.ts', output).ok, true);
});

test('annotates arrow functions, including unparenthesized ones', () => {
  const source = `
/**
 * @param {string} name
 * @returns {string}
 */
const greet = (name) => name;
/**
 * @param {string} text
 */
const shout = text => text.toUpperCase();
`;
  const { output } = convertSource('arrow.js', source, { banner: false });
  assert.match(output, /const greet = \(name: string\): string => name;/);
  assert.match(output, /const shout = \(text: string\): unknown => text\.toUpperCase\(\);/);
  assert.equal(checkStrict('arrow.ts', output).ok, true);
});

test('emits object types, typedef aliases and callback aliases', () => {
  const source = `
/**
 * @type {Object}
 * @property {string} name
 * @property {number} [age]
 */
const person = { name: 'Ada' };

/**
 * @callback Handler
 * @param {string} event
 * @returns {void}
 */

/**
 * @typedef {Object} Point
 * @property {number} x
 * @property {number} y
 */
`;
  const { output } = convertSource('types.js', source, { banner: false });
  assert.match(output, /const person: \{ name: string; age\?: number; \} = \{ name: 'Ada' \};/);
  assert.match(output, /type Handler = \(event: string\) => void;/);
  assert.match(output, /type Point = \{ x: number; y: number; \};/);
  assert.equal(checkStrict('types.ts', output).ok, true);
});

test('fills in unknown for undocumented declarations', () => {
  const source = `function passthrough(value) { return value; }`;
  const { output } = convertSource('implicit.js', source, { banner: false });
  assert.match(output, /function passthrough\(value: unknown\): unknown/);
  assert.equal(checkStrict('implicit.ts', output).ok, true);
});

test('wraps async return types and skips generator return annotations', () => {
  const source = `
/** @returns {number} */
async function load() { return 1; }
/** @returns {number} */
function* sequence() { yield 1; }
`;
  const { output } = convertSource('async.js', source, { banner: false });
  assert.match(output, /async function load\(\): Promise<number>/);
  assert.match(output, /function\* sequence\(\) \{ yield 1; \}/);
  assert.equal(checkStrict('async.ts', output).ok, true);
});

test('leaves contextual callbacks untouched so inference still works', () => {
  const source = `
/**
 * @param {number[]} values
 * @returns {number}
 */
function total(values) {
  return values.reduce((acc, value) => acc + value, 0);
}
`;
  const { output } = convertSource('callback.js', source, { banner: false });
  assert.match(output, /values\.reduce\(\(acc, value\) => acc \+ value, 0\)/);
  assert.doesNotMatch(output, /acc: unknown/);
  assert.equal(checkStrict('callback.ts', output).ok, true);
});

test('turns documented this assignments into declared class fields', () => {
  const source = `
class Box {
  constructor() {
    /** @type {string} */
    this.label = 'x';
  }
}
`;
  const { output } = convertSource('class.js', source, { banner: false });
  assert.match(output, /class Box \{\s+label!?: string;/);
  assert.equal(checkStrict('class.ts', output).ok, true);
});

test('promotes this.x = value to a class field without requiring JSDoc', () => {
  const source = `
class Counter {
  constructor() {
    this.count = 0;
    this.label = 'a';
  }
  get() {
    return this.count;
  }
}
`;
  const { output } = convertSource('class.js', source, { banner: false });
  assert.match(output, /count!?: number;/);
  assert.match(output, /label!?: string;/);
  assert.equal(checkStrict('class.ts', output).ok, true);
});

test('union of JSDoc function types compiles without TS1385', () => {
  const source = `
/**
 * @typedef {function(string): number | function(number): string} Handler
 */
let handler;
`;
  const { output } = convertSource('union.js', source, { banner: false });
  assert.match(output, /=> number\) \| \(\(arg0: number\) => string\)/);
  assert.equal(checkStrict('union.ts', output).ok, true);
});

test('unresolved JSDoc type names get fallback aliases', () => {
  const source = `
/**
 * @param {Mixed} val
 * @returns {Mixed}
 */
function coerce(val) { return val; }
`;
  const { output, diagnostics } = convertSource('dangling.js', source, { banner: false });
  assert.match(output, /^type Mixed = unknown;/m);
  assert.match(output, /val: Mixed/);
  assert.ok(diagnostics.some((d) => d.message.includes('Mixed')));
});

test('template type parameters are not given fallback aliases', () => {
  const source = `
/**
 * @template T
 * @param {T} x
 * @returns {T}
 */
function id(x) { return x; }
`;
  const { output } = convertSource('generic.js', source, { banner: false });
  assert.match(output, /function id<T>\(x: T\): T/);
  assert.doesNotMatch(output, /type T = unknown/);
});

test('generated tsconfig is strict and scriptc friendly', () => {
  const config: unknown = JSON.parse(strictTsConfig());
  assert.ok(typeof config === 'object' && config !== null);
  const parsed = config as { compilerOptions: Record<string, unknown> };
  assert.equal(parsed.compilerOptions['strict'], true);
  assert.equal(parsed.compilerOptions['verbatimModuleSyntax'], true);
  assert.equal(parsed.compilerOptions['noImplicitAny'], true);
});

test('attaches JSDoc to an exported function expression (module.exports = fn)', () => {
  const source = `
/**
 * @param {String|Number} val
 * @param {Object} [options]
 * @returns {String}
 */
module.exports = function format(val, options) { return String(val); };
`;
  const { output } = convertSource('index.js', source, { banner: false });
  assert.match(output, /module\.exports = function format\(val: (?:string \| number|number \| string), options\?: Record<string, unknown>\): string/);
  assert.doesNotMatch(output, /val: \{/);
});

test('does not double-annotate a variable initialized by a function', () => {
  const source = `const handler = (value) => value + 1;\n`;
  const { output } = convertSource('a.js', source, { banner: false });
  // The binding must not get a checker-derived function annotation that could
  // disagree with the parameter annotations on the arrow itself.
  assert.doesNotMatch(output, /const handler: \(/);
  assert.match(output, /\(value: unknown\)/);
});

test('checkStrict still reports diagnostics when the file name is not normalized', () => {
  // Regression: the old filter compared diagnostic.file.fileName to
  // ts.sys.resolvePath(name) as strings. On Windows these differ (forward vs
  // back slashes, case), so every diagnostic was filtered and the gate always
  // passed. The fix compares by SourceFile identity. A name containing `..`
  // exercises a path that TS normalizes, ensuring string equality is not
  // assumed anywhere in the filter.
  const bad = `const a: number = 'str';\n`;
  for (const name of ['case.ts', './case.ts', 'dir/../case.ts']) {
    const result = checkStrict(name, bad);
    assert.equal(result.ok, false, `expected a strict failure for ${name}`);
    assert.ok(result.diagnostics.some((d) => d.includes('TS2322')), `TS2322 lost for ${name}`);
  }
});

test('checkStrict accepts Node globals emitted verbatim from JS', () => {
  // deany keeps Node globals (module.exports / require / process) when
  // converting Node JS. TypeScript 6 no longer auto-includes @types/*, so the
  // strict gate must explicitly pull in node types when they are resolvable,
  // otherwise these emits are reported as spurious TS2591 errors.
  const output = [
    `declare const value: string;`,
    `const fs = require('fs');`,
    `module.exports = { value, cwd: process.cwd(), fs };`,
  ].join('\n');
  const result = checkStrict('case.ts', output);
  assert.equal(result.ok, true, result.diagnostics.join('\n'));
});

test('declare/ambient declarations never get a stacked annotation (double colon)', () => {
  // `declare` members already carry their types. Stacking an inferred annotation
  // produced `declare const X: unknown: number;` (TS1005) and `bar(): unknown: void`
  // (TS1144) — pure type declarations must be left untouched.
  const source = `
declare const X: number;
declare class D { foo: number; bar(): void; }
declare function g(a: string): void;
`;
  const { output, diagnostics } = convertSource('decl.js', source, { banner: false });
  assert.equal(diagnostics.length, 0);
  assert.doesNotMatch(output, /:\s*unknown\s*:/);
  assert.doesNotMatch(output, /:\s*unknown\s*:/);
  assert.match(output, /declare const X: number;/);
  assert.match(output, /bar\(\): void;/);
  assert.match(output, /declare function g\(a: string\): void;/);
  assert.equal(checkStrict('decl.ts', output).ok, true);
});

test('@template on a class emits class Box<T> (no dangling T)', () => {
  const source = `
/** @template T */
class Box {
  /** @param {T} v */
  constructor(v) { this.v = v; }
}
`;
  const output = convertJsWithResolver('box.js', source);
  assert.match(output, /class Box<T>/);
  assert.match(output, /constructor\(v: T\)/);
  assert.equal(checkStrict('box.ts', output).ok, true);
});

test('subclass members that really override a base member get override (noImplicitOverride)', () => {
  const source = `
class Base { greet() { return 'hi'; } }
class Child extends Base { greet() { return 'hello'; } }
class Other extends Base { distinct() { return 1; } }
`;
  const output = convertJsWithResolver('ov.js', source);
  assert.match(output, /class Child extends Base \{ override greet\(\)/);
  assert.doesNotMatch(output, /override distinct/);
  assert.equal(checkStrict('ov.ts', output).ok, true);
});

test('--no-typedef still emits fallback aliases so references do not dangle', () => {
  const source = `
/** @typedef {{name: string}} User */
/** @param {User} u */
function f(u) { return u; }
`;
  const { output } = convertSource('td.js', source, { banner: false, emitTypedefs: false });
  assert.doesNotMatch(output, /type User = \{/);
  assert.match(output, /type User = unknown;/);
  assert.equal(checkStrict('td.ts', output).ok, true);
});

test('fallback alias never collides with a real class/interface of the same name', () => {
  const source = `
class Foo {}
/** @returns {x is Foo} */
function check(x) { return true; }
`;
  const { output } = convertSource('alias.js', source, { banner: false });
  assert.doesNotMatch(output, /type Foo = unknown;/);
  assert.match(output, /function check\(x: unknown\): x is Foo/);
  assert.equal(checkStrict('alias.ts', output).ok, true);
});

test('curried arrow from nested @returns function type stays callable', () => {
  // Nested `function(N): function(N): R` used to normalize to broken syntax
  // (TS1005), and the inner returned arrows got `: unknown` return annotations
  // that contradicted the declared nested function type (TS2322).
  const source = `/** @returns {function(number): function(number): number} */
function make(a) { return b => c => a + b + c; }
const r = make(1)(2)(3);
`;
  const output = convertJsWithResolver('curry.js', source);
  assert.match(output, /make\(a: number\): \(arg0: number\) => \(arg0: number\) => number/);
  assert.doesNotMatch(output, /=> unknown =>/);
  assert.equal(checkStrict('curry.ts', output).ok, true);
});

test('a concrete object shape indexed dynamically keeps its shape and gains an index signature', () => {
  // `pick(o, k) { return o[k]; } pick({a:1,b:2}, 'a')`: o has a real shape from
  // the call site but is also indexed by an arbitrary key. Replacing it wholly
  // with Record would discard evidence; leaving it as `{a;b}` raised TS7053.
  // It must keep its properties plus a string index signature.
  const source = 'function pick(o, k) { return o[k]; }\nconst v = pick({ a: 1, b: 2 }, \'a\');\n';
  const output = convertJsWithResolver('pick.js', source);
  assert.match(output, /o: \{ a: number; b: number; \[key: string\]: unknown; \}/);
  assert.equal(checkStrict('pick.ts', output).ok, true);
});

test('converting an already-annotated file is idempotent (no stacked annotations)', () => {
  // Feeding a first-round product back in must not stack `: string: string`,
  // `(): unknown: number`, `x: unknown: number` etc. (TS1005). The "already
  // has a type" guards on parameters/returns/variables/properties handle this.
  const first = convertJsWithResolver('f.js', `
/** @param {string} a @returns {number} */
function f(a) { return a.length; }
/** @type {Array<number>} */
const xs = [1];
`);
  const second = convertJsWithResolver('f2.js', first);
  assert.equal(second, first);
  assert.doesNotMatch(second, /string: string|unknown: number|unknown: Array/);
  assert.equal(checkStrict('f.ts', second).ok, true);
});

test('re-promoting an existing class field does not duplicate it (TS2300)', () => {
  // A `this.v = v` field is promoted to `v!: type;`. Re-converting that output
  // used to append a second `v!: type;` -> duplicate identifier on 3rd run.
  const first = convertJsWithResolver('p.js', `
class P {
  /** @param {number} v */
  constructor(v) { this.v = v; }
}
`);
  const second = convertJsWithResolver('p2.js', first);
  const third = convertJsWithResolver('p3.js', second);
  assert.equal(second, first);
  assert.equal(third, second);
  assert.equal((second.match(/\bv!: number;/g) ?? []).length, 1);
  assert.equal(checkStrict('p.ts', second).ok, true);
});

test('a UTF-8 BOM does not skew annotation offsets', () => {
  // ts.createSourceFile counts a leading BOM as trivia, but EditBuffer worked
  // on the raw string, so annotations landed before the name
  // (`const : numbera = 1;`, TS1134 / `function f(: stringx)`, TS1138). The
  // entry point strips the BOM so string, AST offsets and edits agree.
  const source = `\ufeffconst a = 1;\n/** @param {string} x @returns {string} */\nfunction f(x) { return x; }\n`;
  const output = convertJsWithResolver('bom.js', source);
  assert.equal(output.charCodeAt(0) === 0xfeff, false, 'BOM should be stripped');
  assert.match(output, /const a: number = 1;/);
  assert.match(output, /function f\(x: string\): string/);
  assert.doesNotMatch(output, /:\s*\w+\s+\w+[:=]/); // no `numbera` / `stringx` skew
  assert.equal(checkStrict('bom.ts', output).ok, true);
});
