import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as ts from 'typescript';
import { convertSource } from '../src/convert.js';
import { createUsageResolver } from '../src/inferAny.js';

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

test('does not infer number operands from + (may be string concatenation)', () => {
  const output = convertJs(`
function add(a, b) { return a + b; }
`);
  assert.match(output, /function add\(a: unknown, b: unknown\): unknown/);
});
