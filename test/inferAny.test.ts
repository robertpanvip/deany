import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as ts from 'typescript';
import { inferAnyInProject } from '../src/inferAny.js';

const compilerOptions: ts.CompilerOptions = {
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  skipLibCheck: true,
  noEmit: true,
};

function infer(source: string): { output: string; sites: readonly { inferred?: string; reason?: string }[] } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'infer-any-'));
  const file = path.join(directory, 'case.ts');
  fs.writeFileSync(file, source, 'utf8');
  try {
    const [result] = inferAnyInProject([file], compilerOptions);
    assert.ok(result !== undefined);
    return { output: result.output, sites: result.sites };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('infers a variable type from assignments and call-site arguments', () => {
  const { output, sites } = infer(`
declare function takeNumber(n: number): void;
let value: any;
value = 42;
takeNumber(value);
`);
  assert.match(output, /let value: number;/);
  assert.equal(sites.filter((site) => site.inferred === 'number').length, 1);
});

test('infers from an initializer', () => {
  const { output } = infer(`const name: any = 'Ada';\n`);
  assert.match(output, /const name: string =/);
});

test('infers a function return type from return statements', () => {
  const { output } = infer(`function load(): any { return 123; }\n`);
  assert.match(output, /function load\(\): number/);
});

test('infers a parameter type from external call sites', () => {
  const { output } = infer(`
function greet(who: any): void {}
greet('world');
`);
  assert.match(output, /function greet\(who: string\)/);
});

test('infers a class property type from constructor assignment', () => {
  const { output } = infer(`
class Box {
  value: any;
  constructor() { this.value = 'ok'; }
}
`);
  assert.match(output, /value: string;/);
});

test('keeps any when usage evidence conflicts', () => {
  const { output, sites } = infer(`
let mixed: any;
mixed = 1;
mixed = 'a';
`);
  assert.match(output, /let mixed: any;/);
  assert.equal(sites.length, 1);
  assert.match(sites[0]?.reason ?? '', /ambiguous/);
});

test('ignores type assertions by default', () => {
  const { output } = infer(`const raw: unknown = 1;\nconst n = raw as any;\n`);
  assert.match(output, /raw as any/);
});

test('parenthesizes inferred union types', () => {
  const { output } = infer(`
declare const flag: boolean;
function pick(): any { return flag ? 1 : 'a'; }
`);
  assert.match(output, /function pick\(\): \((?:number \| string|string \| number)\)/);
});

test('propagates an inferred return type into a variable that receives the call', () => {
  const { output, sites } = infer(`
function load(): any { return 123; }
let snapshot: any = load();
`);
  assert.match(output, /function load\(\): number/);
  assert.match(output, /let snapshot: number = load\(\);/);
  assert.equal(sites.filter((site) => site.inferred === 'number').length, 2);
});

test('propagates transitively across a chain of receivers (fixed point)', () => {
  const { output } = infer(`
function load(): any { return 'ok'; }
let first: any = load();
let second: any = first;
let third: any = second;
`);
  assert.match(output, /function load\(\): string/);
  assert.match(output, /let first: string = load\(\);/);
  assert.match(output, /let second: string = first;/);
  assert.match(output, /let third: string = second;/);
});

test('propagates a return type to a variable assigned in a separate statement', () => {
  const { output } = infer(`
function load(): any { return true; }
let flag: any;
flag = load();
`);
  assert.match(output, /function load\(\): boolean/);
  assert.match(output, /let flag: boolean;/);
});

test('propagates an inferred return type across file boundaries', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'infer-cross-'));
  const a = path.join(directory, 'a.ts');
  const b = path.join(directory, 'b.ts');
  fs.writeFileSync(a, `export function load(): any { return 42; }\n`, 'utf8');
  fs.writeFileSync(
    b,
    `import { load } from './a.js';\nexport const snapshot: any = load();\n`,
    'utf8',
  );
  try {
    const results = inferAnyInProject([a, b], compilerOptions);
    assert.equal(results.length, 2);
    const producer = results.find((result) => result.fileName === a);
    const consumer = results.find((result) => result.fileName === b);
    assert.match(producer?.output ?? '', /function load\(\): number/);
    assert.match(consumer?.output ?? '', /const snapshot: number = load\(\);/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
