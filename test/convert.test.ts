import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkStrict } from '../src/check.js';
import { strictTsConfig } from '../src/config.js';
import { convertSource } from '../src/convert.js';

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
  assert.match(output, /class Box \{\s+label: string;/);
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
