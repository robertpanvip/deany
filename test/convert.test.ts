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
import { collectJsFiles, convertPath } from '../src/fs.js';

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

test('R10-3: CommonJS tsconfig drops verbatimModuleSyntax so emitted exports compile', () => {
  // verbatimModuleSyntax + a CommonJS emit rejects every top-level `export`
  // with TS1287. deany emits `export`, so a generated CommonJS config must
  // drop that flag or it can never compile (review P1-21).
  const parse = (module: string) =>
    (JSON.parse(strictTsConfig({ module })) as { compilerOptions: Record<string, unknown> }).compilerOptions;
  assert.equal(parse('CommonJS')['verbatimModuleSyntax'], false);
  assert.equal(parse('NodeNext')['verbatimModuleSyntax'], false);
  assert.equal(parse('ESNext')['verbatimModuleSyntax'], true);

  // Verify the generated CommonJS config actually type-checks an exported
  // declaration — the exact case that produced TS1287 before the fix.
  const opts = ts.convertCompilerOptionsFromJson(parse('CommonJS'), '/workspace').options;
  const result = checkStrict('a.ts', 'export const x = 1;\n', opts);
  assert.ok(result.ok, result.diagnostics.join('\n'));
});

test('R12-4: weak name hint and any fallback never outrank real evidence', () => {
  // A numeric name only weakly suggests number; a real string call site must
  // override it. A neutral name with anchor-less `+` falls back to `any`.
  const overridden = convertJsWithResolver('a.js', [
    'export function add(a, b) { return a + b; }',
    "add('x', 'y');",
  ].join('\n'));
  assert.match(overridden, /function add\(a: string, b: string\)/);
  assert.ok(checkStrict('a.ts', overridden).ok);

  const anyFallback = convertJsWithResolver('a.js',
    'export function combine(a, b) { return a + b; }');
  assert.match(anyFallback, /function combine\(a: any, b: any\)/);
  assert.ok(checkStrict('a.ts', anyFallback).ok);
});

test('R13-1: anchor-less + return is string|number (block body and expression arrow)', () => {
  // JS `+` is numeric addition OR string concatenation, so a return with no
  // concrete operand type is honestly `string | number` — strictly more
  // informative than `unknown`, and safely assignable from any + result.
  const block = convertJsWithResolver('a.js',
    'export function combine(a, b) { return a + b; }');
  assert.match(block, /function combine\(a: any, b: any\): string \| number/);
  assert.ok(checkStrict('a.ts', block).ok);

  const arrow = convertJsWithResolver('a.js',
    'export const combine = (a, b) => a + b;');
  assert.match(arrow, /\(a: any, b: any\): string \| number => a \+ b/);
  assert.ok(checkStrict('a.ts', arrow).ok);
});

test('R13-2: a concrete + result is NOT widened to string|number', () => {
  // With a number anchor the + is provably numeric (a real return source), so
  // the string|number fallback must not fire. Covers the nested-JSDoc curry
  // case that regressed during development (inner c => a+b+c must stay number).
  const anchored = convertJsWithResolver('a.js',
    'export function inc(a) { return a + 1; }');
  assert.match(anchored, /function inc\(a: number\): number/);
  assert.ok(checkStrict('a.ts', anchored).ok);

  const curry = convertJsWithResolver('a.js', [
    '/** @returns {function(number): function(number): number} */',
    'function make(a) { return b => c => a + b + c; }',
    'const r = make(1)(2)(3);',
  ].join('\n'));
  assert.doesNotMatch(curry, /string \| number/);
  assert.ok(checkStrict('a.ts', curry).ok);
});

test('R13-3: non-+ opaque returns and JSDoc @returns keep their type', () => {
  const opaque = convertJsWithResolver('a.js',
    'export function count(xs) { return xs.length; }');
  assert.match(opaque, /\): unknown \{ return xs\.length; \}/);
  assert.ok(checkStrict('a.ts', opaque).ok);

  const jsdoc = convertJsWithResolver('a.js', [
    '/** @returns {boolean} */',
    'function combine(a, b) { return a + b; }',
  ].join('\n'));
  assert.match(jsdoc, /\): boolean \{ return a \+ b; \}/);
  assert.ok(checkStrict('a.ts', jsdoc).ok);
});

test('R12-1: untyped reduce receiver gets a generic accumulator signature', () => {
  // With no call site or JSDoc, `list.reduce((a,b)=>a+b, 0)` used to freeze the
  // callback params at `unknown` (TS18046). The receiver now carries a generic
  // signature `<T>(cb, init: T) => T` so TS infers T from the real `init` value
  // — no concrete element type is guessed (review round 12 / idea 2).
  const out = convertJsWithResolver('a.js',
    'export function total(list) { return list.reduce((a, b) => a + b, 0); }');
  assert.match(out, /reduce: <T>\(cb: \(a: T, b: T, i: number\) => T, init: T\) => T/);
  assert.match(out, /list\.reduce\(\(a, b\) => a \+ b, 0\)/);
  assert.doesNotMatch(out, /\(a: unknown, b: unknown\)/);
  const strict = checkStrict('a.ts', out);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('R12-2: generic reduce signature also works with a 3-parameter callback', () => {
  const out = convertJsWithResolver('a.js',
    'export function total(list) { return list.reduce((a, b, i) => a + b, 0); }');
  assert.match(out, /list\.reduce\(\(a, b, i\) => a \+ b, 0\)/);
  const strict = checkStrict('a.ts', out);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('R12-3: reduceRight uses the same generic signature', () => {
  const out = convertJsWithResolver('a.js',
    'export function total(list) { return list.reduceRight((a, b) => a + b, 0); }');
  assert.match(out, /reduceRight: <T>\(cb:/);
  assert.ok(checkStrict('a.ts', out).ok);
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
  // The old `/=> unknown =>/` missed the real regression, which emitted a
  // colon-form `: unknown` on inner arrows: `(b: number): unknown => ...`.
  assert.doesNotMatch(output, /:\s*unknown\b/);
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

test('regex literal in a parameter default does not confuse paren finding', () => {
  // Regression: findParens used a hand-written char scanner that treated the
  // `)` inside a regex literal like `/\)/` as the parameter list's closing
  // paren, inserting the return type in the wrong place (TS1005).
  // The AST's CloseParenToken gives the real closing paren regardless of regex.
  const source = `/**
 * @param {RegExp} re
 * @returns {boolean}
 */
function test(re = /\\)\\//) {
  return re.test('abc');
}
`;
  const output = convertJsWithResolver('regex.js', source);
  // The full regex literal `/\)\//` must survive intact and the return type
  // must follow the real close paren. A hand-written scanner put `: boolean`
  // inside the regex, corrupting both (TS1005). Use an exact raw string match
  // rather than a regex, so `\` and `)` need no fragile double escaping.
  assert.ok(
    output.includes(String.raw`function test(re: RegExp = /\)\//): boolean {`),
    `unexpected output:\n${output}`,
  );
  assert.equal(checkStrict('regex.ts', output).ok, true);
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
  // The old `/:\s*\w+\s+\w+[:=]/` never matched the real skew (`const : numbera`
  // / `f(: stringx)`). Detect the actual symptom: a colon where an identifier
  // should be — right after a decl keyword or an opening paren.
  assert.doesNotMatch(output, /(?:\b(?:const|let|var)\s*:|\(\s*:)/);
  assert.equal(checkStrict('bom.ts', output).ok, true);
});

test('--check retries with @types/node for modern node: specifiers', () => {
  // Regression (P1-7): TS2591 for `import path from 'node:path'` names neither
  // `process` nor `Buffer`, so the old global-name whitelist missed it and the
  // @types/node retry never fired — every ESM project using node: was flagged.
  const result = checkStrict(
    'case.ts',
    `import path from 'node:path';\nexport const p = path.join('a', 'b');\n`,
  );
  assert.equal(result.ok, true, result.diagnostics.join('\n'));
});

test('directory discovery includes mjs/cjs/jsx and does not skip dist or .codebuddy', () => {
  // Regression (P1-8): only .js was collected (mjs/cjs/jsx silently ignored),
  // SKIP_DIRECTORIES hardcoded the author's .codebuddy folder and skipped every
  // directory merely named `dist`.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-'));
  try {
    for (const name of ['a.js', 'b.mjs', 'c.cjs', 'd.jsx', 'skip.txt']) {
      fs.writeFileSync(path.join(dir, name), '');
    }
    for (const sub of ['dist', '.codebuddy']) {
      fs.mkdirSync(path.join(dir, sub));
      fs.writeFileSync(path.join(dir, sub, 'e.js'), '');
    }
    const found = collectJsFiles(dir).map((f) => path.basename(f)).sort();
    assert.deepEqual(found, ['a.js', 'b.mjs', 'c.cjs', 'd.jsx', 'e.js', 'e.js'].sort());
    assert.ok(!found.includes('skip.txt'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('batch conversion isolates a crashing file and still converts the rest', () => {
  // Regression (P2-9): a single pathological file (deep nesting -> TS
  // RangeError) used to abort the whole directory and dump a raw stack. The
  // batch must catch per-file errors, keep going, and report them in errors[].
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-isolate-'));
  try {
    fs.writeFileSync(path.join(dir, 'good.js'), 'const x = 1;\n', 'utf8');
    fs.writeFileSync(
      path.join(dir, 'evil.js'),
      'function f(a = ' + '('.repeat(20000) + '1' + ')'.repeat(20000) + ') {}',
      'utf8',
    );
    const out = path.join(dir, 'out');
    const result = convertPath(dir, out, { banner: false });
    assert.equal(result.written.length, 1, 'the good file should still be written');
    assert.equal(result.errors.length, 1, 'the crashing file should be recorded');
    assert.match(result.errors[0]?.file ?? '', /evil\.js$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Review 0.1.17: real reproductions fixed in this round ---
test('R17-1: no-resolver API emits void for empty / side-effect-only bodies', () => {
  // The library API (no UsageResolver) used to stamp `: unknown` on an empty
  // body — misleading and it forced callers to handle a value never returned.
  const noop = convertSource('a.js', 'function noop(a) {}', { banner: false }).output;
  assert.match(noop, /function noop\(a: unknown\): void \{\}/);
  const arrow = convertSource('a.js', 'const f = (n) => {};', { banner: false }).output;
  assert.match(arrow, /const f = \(n: unknown\): void => \{\}/);
  const method = convertSource('a.js', 'class A { m() {} }', { banner: false }).output;
  assert.match(method, /m\(\): void \{\}/);
  // A body that DOES return a value must keep the honest unknown fallback.
  const valued = convertSource('a.js', 'function id(a) { return a; }', { banner: false }).output;
  assert.match(valued, /function id\(a: unknown\): unknown/);
});

test('R17-15: constructor this.x assignments promote fields even when the RHS is unresolved', () => {
  // Promoting an unresolved `this.x = x` to `x!: unknown` removes the TS2339
  // on every later `this.x` read. It is an honest fallback: the actual type
  // cannot be recovered here (the checker has no standalone type for x). A
  // concrete-type consumer like Math.hypot may still need a JSDoc annotation
  // on x — that is a separate, deeper inference problem.
  const out = convertJsWithResolver('a.js',
    'export class Pt { constructor(x, y) { this.x = x; this.y = y; } dist() { return this.x; } }');
  assert.match(out, /x!: unknown;/);
  assert.match(out, /y!: unknown;/);
  const strict = checkStrict('a.ts', out);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('R17-16: an empty-array field widens to Array<unknown>, not Array<never>', () => {
  const out = convertJsWithResolver('a.js',
    'export class Bag { constructor() { this.items = []; } add(i) { this.items.push(i); } }');
  assert.match(out, /items!: Array<unknown>/);
  assert.doesNotMatch(out, /Array<never>/);
  const strict = checkStrict('a.ts', out);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('R10-1: call-site empty array does not freeze a parameter at Array<never>', () => {
  // `addAll([], [1,2,3])` used to give `arr` the strong source `never[]` from
  // the `[]` argument, so `arr.push(i)` failed with TS2345 ("number not
  // assignable to never"). The call-site empty-array literal must get the same
  // widening as an initializer empty array: synthesize Array<T> from the
  // callee's own push writes, or the safe Array<unknown> fallback.
  const out = convertJsWithResolver('a.js', [
    'export function addAll(arr, items) { for (const i of items) { arr.push(i); } return arr; }',
    'addAll([], [1, 2, 3]);',
  ].join('\n'));
  assert.doesNotMatch(out, /Array<never>/);
  assert.match(out, /function addAll\(arr: Array<unknown>/);
  const strict = checkStrict('a.ts', out);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('R10-2: call-site empty array + concrete push widens to the written element type', () => {
  // When the callee pushes a concrete literal, the call-site `[]` must still
  // widen from the real write rather than freezing at `never[]`.
  const out = convertJsWithResolver('a.js', [
    'export function collect(xs) { xs.push("x"); return xs; }',
    'collect([]);',
  ].join('\n'));
  assert.match(out, /function collect\(xs: Array<string>/);
  assert.doesNotMatch(out, /Array<never>/);
  const strict = checkStrict('a.ts', out);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('R17-14: an argument passed to a rest parameter takes the element type', () => {
  // console.log(msg) / Math.max(v,1) used to make msg: any[] / v: number[]
  // (TS2345). The rest slot constrains to the ELEMENT type, not the array.
  const out = convertJsWithResolver('a.js', [
    'export function logIt(msg) { console.log(msg); }',
    'export function mx(v) { return Math.max(v, 1); }',
  ].join('\n'));
  assert.match(out, /function logIt\(msg: unknown\)/);
  assert.match(out, /function mx\(v: number\)/);
  assert.doesNotMatch(out, /msg: Array/);
  assert.doesNotMatch(out, /v: Array/);
});

test('R17-19a: checkStrict includes DOM globals so console does not spuriously fail', () => {
  const result = checkStrict('a.ts', "function f() { console.log('x'); }\n");
  assert.ok(result.ok, result.diagnostics.join('\n'));
});

// --- Review 0.1.17 batch 2: JSDoc / declaration reproductions ---
test('R17b-9: @template constraint converts to a valid generic declaration', () => {
  const out = convertSource('a.js',
    '/**\n * @template T extends object\n * @param {T} x\n */\nfunction f(x) { return x; }',
    { banner: false }).output;
  assert.match(out, /function f<T extends object>\(x: T\)/);
  assert.doesNotMatch(out, /<T, extends, object>/);
  assert.doesNotMatch(out, /type T = unknown/);
  assert.ok(checkStrict('a.ts', out).ok, checkStrict('a.ts', out).diagnostics.join('\n'));
});

test('R17b-11: lowercase @typedef {object} folds @property tags into the alias', () => {
  const out = convertSource('a.js',
    '/**\n * @typedef {object} Opts\n * @property {number} port\n */\n/** @param {Opts} o */ function f(o) { return o.port; }',
    { banner: false }).output;
  assert.match(out, /type Opts = \{ port: number; \}/);
  assert.ok(checkStrict('a.ts', out).ok, checkStrict('a.ts', out).diagnostics.join('\n'));
});

test('R17b-12: @enum emits one type alias that coexists with the value', () => {
  const out = convertSource('a.js',
    '/** @enum {number} */\nconst Color = { RED: 0, BLUE: 1 };\n/** @param {Color} c */ function f(c) { return c; }',
    { banner: false }).output;
  assert.equal((out.match(/type Color/g) ?? []).length, 1);
  assert.match(out, /type Color = number/);
  assert.ok(checkStrict('a.ts', out).ok, checkStrict('a.ts', out).diagnostics.join('\n'));
});

test('R17b-13: an optional param followed by a required param stays legal', () => {
  const out = convertSource('a.js',
    '/**\n * @param {string} [a]\n * @param {number} b\n */\nfunction f(a, b) { return b; }',
    { banner: false }).output;
  assert.match(out, /function f\(a: string \| undefined, b: number\)/);
  assert.doesNotMatch(out, /a\?: string, b:/);
  assert.ok(checkStrict('a.ts', out).ok, checkStrict('a.ts', out).diagnostics.join('\n'));
});

test('R17b-18: a // comment between JSDoc and declaration keeps the doc bound', () => {
  const out = convertSource('a.js', '/** @type {number} */\n// helper\nconst k = 1;', { banner: false }).output;
  assert.match(out, /const k: number = 1/);
  assert.ok(checkStrict('a.ts', out).ok, checkStrict('a.ts', out).diagnostics.join('\n'));
});

// --- Review 0.1.17 batch 3: data-loss protection ---
test('R17c-4: batch conversion refuses to overwrite a hand-written .ts (P0-4)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overwrite-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.js'), 'function f(a){return a}\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'a.ts'), '// MY HANDWRITTEN TS\nexport const keep = 42;\n', 'utf8');
    // Default: skip the hand-written target with a clear error, keep its bytes.
    const skipped = convertPath(dir, dir, { banner: true });
    assert.equal(skipped.written.length, 0);
    assert.equal(skipped.errors.length, 1);
    assert.match(skipped.errors[0]?.message ?? '', /refusing to overwrite.*use --force/);
    assert.match(fs.readFileSync(path.join(dir, 'a.ts'), 'utf8'), /MY HANDWRITTEN/);
    // --force: overwrite.
    const forced = convertPath(dir, dir, { banner: true }, undefined, true, true);
    assert.equal(forced.written.length, 1);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, 'a.ts'), 'utf8'), /MY HANDWRITTEN/);
    // Re-running on our own generated output is allowed without force (idempotent).
    const again = convertPath(dir, dir, { banner: true });
    assert.equal(again.written.length, 1);
    assert.equal(again.errors.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
