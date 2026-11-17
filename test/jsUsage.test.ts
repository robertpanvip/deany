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
