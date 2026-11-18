import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { convertSource } from '../src/convert.js';
import { checkStrict } from '../src/check.js';
import { loadDeclarations, findSiblingDts } from '../src/dts.js';

function withPair(
  js: string,
  dts: string | undefined,
  run: (jsPath: string, declarations: ReturnType<typeof loadDeclarations>) => void,
): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dts-test-'));
  const jsPath = path.join(dir, 'lib.js');
  fs.writeFileSync(jsPath, js, 'utf8');
  if (dts !== undefined) {
    fs.writeFileSync(path.join(dir, 'lib.d.ts'), dts, 'utf8');
  }
  try {
    run(jsPath, loadDeclarations(jsPath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('findSiblingDts pairs lib.js with lib.d.ts only when present', () => {
  withPair('module.exports = {};', 'export const x: number;', (jsPath) => {
    assert.ok(findSiblingDts(jsPath)?.endsWith('lib.d.ts'));
  });
  withPair('module.exports = {};', undefined, (jsPath) => {
    assert.equal(findSiblingDts(jsPath), undefined);
  });
});

test('restores function signatures from a sibling d.ts without JSDoc', () => {
  const js = `
function add(a, b) { return a + b; }
function label(value) { return '#' + value; }
const VERSION = '1.0.0';
module.exports = { add, label, VERSION };
`;
  const dts = `
export function add(a: number, b: number): number;
export function label(value: string): string;
export const VERSION: string;
`;
  withPair(js, dts, (_jsPath, declarations) => {
    const { output } = convertSource('lib.js', js, { banner: false }, undefined, declarations);
    assert.match(output, /function add\(a: number, b: number\): number/);
    assert.match(output, /function label\(value: string\): string/);
    assert.match(output, /const VERSION: string = '1\.0\.0'/);
    assert.equal(checkStrict('lib.ts', output).ok, true);
  });
});

test('restores generics and emits referenced interfaces verbatim', () => {
  const js = `
function configure(opts) { return { ok: true, opts: opts }; }
module.exports = { configure };
`;
  const dts = `
export interface Options { retry?: number; label?: string; }
export interface Result { ok: boolean; opts: Options; }
export declare function configure(opts: Options): Result;
`;
  withPair(js, dts, (_jsPath, declarations) => {
    const { output } = convertSource('lib.js', js, { banner: false }, undefined, declarations);
    assert.match(output, /interface Options \{ retry\?: number; label\?: string; \}/);
    assert.match(output, /interface Result \{ ok: boolean; opts: Options; \}/);
    assert.match(output, /function configure\(opts: Options\): Result/);
    assert.equal(checkStrict('lib.ts', output).ok, true);
  });

  // Generic signature, matched by name; body kept from JS.
  const js2 = `
function wrap(value) { return [value]; }
module.exports = { wrap };
`;
  const dts2 = `
export declare function wrap<T>(value: T): T[];
`;
  withPair(js2, dts2, (_jsPath, declarations) => {
    const { output } = convertSource('lib.js', js2, { banner: false }, undefined, declarations);
    assert.match(output, /function wrap<T>\(value: T\): T\[\]/);
    assert.equal(checkStrict('lib.ts', output).ok, true);
  });
});

test('d.ts signature overrides JSDoc, and no declarations falls back to JSDoc', () => {
  const js = `
/** @param {string} x */
function f(x) { return x; }
module.exports = { f };
`;
  const dts = `export declare function f(x: number): number;\n`;
  withPair(js, dts, (_jsPath, declarations) => {
    const withDts = convertSource('lib.js', js, { banner: false }, undefined, declarations).output;
    assert.match(withDts, /function f\(x: number\): number/);
    const withoutDts = convertSource('lib.js', js, { banner: false }, undefined, undefined).output;
    // No `@returns` in the JSDoc, so the return stays `unknown` — the JSDoc
    // param type is used, proving the d.ts provider was not applied.
    assert.match(withoutDts, /function f\(x: string\)/);
    assert.doesNotMatch(withoutDts, /function f\(x: number\)/);
  });
});

test('class methods and fields are restored from a d.ts class declaration', () => {
  const js = `
class Counter {
  constructor() { this.n = 0; }
  inc(by) { this.n = this.n + by; }
  get() { return this.n; }
}
module.exports = { Counter };
`;
  const dts = `
export declare class Counter {
  n: number;
  inc(by: number): void;
  get(): number;
}
`;
  withPair(js, dts, (_jsPath, declarations) => {
    const { output } = convertSource('lib.js', js, { banner: false }, undefined, declarations);
    assert.match(output, /inc\(by: number\): void/);
    assert.match(output, /get\(\): number/);
  });
});
