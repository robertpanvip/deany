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

test('infers void for a function with no value-returning statement', () => {
  const { output } = infer(`
function noop(): any { const x = 1; }
function bare(): any { return; }
`);
  assert.match(output, /function noop\(\): void/);
  assert.match(output, /function bare\(\): void/);
});

test('wraps inferred returns in Promise for async functions', () => {
  const { output } = infer(`
async function noop(): any { await Promise.resolve(1); }
async function value(): any { return 123; }
`);
  assert.match(output, /async function noop\(\): Promise<void>/);
  assert.match(output, /async function value\(\): Promise<number>/);
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

test('merges conflicting usage evidence into a union type', () => {
  const { output, sites } = infer(`
let mixed: any;
mixed = 1;
mixed = 'a';
`);
  assert.match(output, /let mixed: \(?number \| string\)?;/);
  assert.equal(sites.length, 1);
  assert.equal(sites[0]?.inferred, 'number | string');
});

test('flattens and de-duplicates unions coming from multiple sources', () => {
  const { output } = infer(`
declare const u: number | string;
let v: any;
v = u;
v = booleanValue;
declare const booleanValue: boolean;
`);
  const decl = output.match(/let v: \(?([^;]+?)\)?;/)?.[1] ?? '';
  const members = decl.split(' | ').map((m) => m.trim());
  assert.deepEqual(members.sort(), ['boolean', 'number', 'string']);
});

test('intersects contravariant constraints from multiple call sites', () => {
  const { output } = infer(`
declare function take(v: number | string): void;
declare function take2(v: boolean | string): void;
let v: any;
take(v);
take2(v);
`);
  // string is the only type accepted by both call sites (intersection).
  assert.match(output, /let v: string;/);
});

test('parenthesizes a function type merged into a union', () => {
  const { output } = infer(`
let handler: any;
handler = function (): number { return 1; };
handler = 'later';
`);
  assert.doesNotMatch(output, /let handler: any;/);
  assert.match(output, /\(\(\) => number\) \| string|string \| \(\(\) => number\)/);
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

test('does not double-wrap an array element any (any[] shorthand)', () => {
  const { output } = infer(`const arr: any[] = [1, 2];\n`);
  assert.match(output, /const arr: number\[\] = \[1, 2\];/);
  assert.doesNotMatch(output, /Array<number>\[\]/);
});

test('does not double-wrap Array<any> generic form', () => {
  const { output } = infer(`const arr: Array<any> = [1, 2];\n`);
  assert.match(output, /const arr: Array<number> = \[1, 2\];/);
  assert.doesNotMatch(output, /Array<Array<number>>/);
});

test('keeps any for an empty array instead of inferring never', () => {
  const { output } = infer(`const arr: any[] = [];\n`);
  assert.match(output, /const arr: any\[\] = \[\];/);
  assert.doesNotMatch(output, /never/);
});

test('projects array element any through assignments and returns', () => {
  const assigned = infer(`let a: any[]; a = [1, 2];\n`).output;
  assert.match(assigned, /let a: number\[\];/);
  const returned = infer(`function f(): any[] { return [1, 2]; }\n`).output;
  assert.match(returned, /function f\(\): number\[\]/);
});

test('projects a generic slot such as Map<string, any>', () => {
  const { output } = infer(`const m: Map<string, any> = new Map<string, number>();\n`);
  assert.match(output, /const m: Map<string, number>/);
});

test('unions element types written via push/unshift into an any[] slot', () => {
  const { output } = infer(`const a: any[] = [1]; a.push('x'); a.unshift(true);\n`);
  assert.match(output, /const a: \(boolean \| number \| string\)\[\]/);
  assert.doesNotMatch(output, /const a: number\[\]/);
});

test('unions element types written via index assignment into an any[] slot', () => {
  const { output } = infer(`const a: any[] = [1]; a[1] = 'x';\n`);
  assert.match(output, /const a: \(number \| string\)\[\]/);
});

test('infers an empty any[] from push mutations instead of keeping any', () => {
  const { output } = infer(`const a: any[] = []; a.push('x');\n`);
  assert.match(output, /const a: string\[\]/);
});

test('infers a Map value slot from set(key, value) mutations', () => {
  const { output } = infer(`const m: Map<string, any> = new Map(); m.set('a', 42); m.set('b', 'x');\n`);
  assert.match(output, /const m: Map<string, \(number \| string\)>/);
  assert.doesNotMatch(output, /\bany\b/);
});

test('infers a Set element slot from add(value) mutations', () => {
  const { output } = infer(`const s: Set<any> = new Set(); s.add(1); s.add('x');\n`);
  assert.match(output, /const s: Set<\(number \| string\)>/);
  assert.doesNotMatch(output, /\bany\b/);
});

test('does not treat read-only container accesses as element evidence', () => {
  const { output } = infer(`const a: any[] = [1]; console.log(a.length, a.map);\n`);
  assert.match(output, /const a: number\[\]/);
});

test('nested any annotation still infers the whole type when not nested', () => {
  const { output } = infer(`let x: any = [1, 2];\n`);
  assert.match(output, /let x: Array<number> = \[1, 2\];/);
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

test('infers an any parameter union from typeof narrowing in the body', () => {
  const { output } = infer(`
function format(x: any) {
  if (typeof x === 'string') return x.length;
  if (typeof x === 'number') return x.toFixed();
}
`);
  assert.match(output, /function format\(x: \(number \| string\)\)/);
});

test('back-propagates an inferred parameter type to an any call-site argument', () => {
  const { output } = infer(`
function format(x: any) {
  if (typeof x === 'string') return 1;
  if (typeof x === 'number') return 2;
}
let value: any;
format(value);
`);
  assert.match(output, /let value: \(number \| string\);/);
});

test('back-propagation converges regardless of declaration order', () => {
  const { output } = infer(`
let value: any;
format(value);
function format(x: any) {
  if (typeof x === 'string') return 1;
  if (typeof x === 'number') return 2;
}
`);
  assert.match(output, /let value: \(number \| string\);/);
  assert.match(output, /function format\(x: \(number \| string\)\)/);
});

test('typeof narrowing propagates through a chained any variable', () => {
  const { output } = infer(`
function format(x: any) {
  if (typeof x === 'string') return 1;
  if (typeof x === 'number') return 2;
}
let value: any;
format(value);
let copy: any = value;
`);
  assert.match(output, /let copy: \(number \| string\) = value;/);
});

test('multiple call-site constraints intersect with the inferred parameter type', () => {
  const { output } = infer(`
function format(x: any) {
  if (typeof x === 'string') return 1;
  if (typeof x === 'number') return 2;
}
function onlyString(s: string) { return 0; }
let value: any;
format(value);
onlyString(value);
`);
  assert.match(output, /let value: string;/);
});

test('does not infer a parameter type when the body has no typeof narrowing', () => {
  const { output } = infer(`
function identity(x: any) { return x; }
let value: any;
identity(value);
`);
  assert.match(output, /function identity\(x: any\)/);
  assert.match(output, /let value: any;/);
});

test('back-propagates typeof narrowing across file boundaries', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'infer-param-cross-'));
  const a = path.join(directory, 'a.ts');
  const b = path.join(directory, 'b.ts');
  fs.writeFileSync(
    a,
    `export function format(x: any) { if (typeof x === 'string') return 1; if (typeof x === 'number') return 2; }\n`,
    'utf8',
  );
  fs.writeFileSync(b, `import { format } from './a.js';\nexport let value: any;\nformat(value);\n`, 'utf8');
  try {
    const results = inferAnyInProject([a, b], compilerOptions);
    const producer = results.find((result) => result.fileName === a);
    const consumer = results.find((result) => result.fileName === b);
    assert.match(producer?.output ?? '', /function format\(x: \(number \| string\)\)/);
    assert.match(consumer?.output ?? '', /let value: \(number \| string\);/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('infers an any parameter from Array.isArray narrowing', () => {
  const { output } = infer(`
function handle(x: any) {
  if (Array.isArray(x)) return x.length;
}
`);
  assert.match(output, /function handle\(x: unknown\[\]\)/);
});

test('back-propagates an Array.isArray parameter type to the call site', () => {
  const { output } = infer(`
function handle(x: any) {
  if (Array.isArray(x)) return x.length;
}
let value: any;
handle(value);
`);
  assert.match(output, /let value: unknown\[\];/);
});

test('infers an any parameter from instanceof narrowing (local class)', () => {
  const { output } = infer(`
class Box { value = 1; }
function handle(x: any) {
  if (x instanceof Box) return x.value;
}
`);
  assert.match(output, /function handle\(x: Box\)/);
});

test('infers an any parameter from instanceof narrowing (built-in)', () => {
  const { output } = infer(`
function handle(x: any) {
  if (x instanceof Date) return x.getTime();
}
`);
  assert.match(output, /function handle\(x: Date\)/);
});

test('refines a typeof-object narrowing with members actually called inside the branch', () => {
  const { output } = infer(`
function handle(x: any) {
  if (typeof x === 'object' && x !== null) { x.render(); }
}
`);
  assert.match(output, /function handle\(x: \(?object & \{ render: \(\.\.\.args: unknown\[\]\) => unknown; \}\)?\)/);
});

test('refines a typeof-function narrowing with properties read inside the branch', () => {
  const { output } = infer(`
function handle(x: any) {
  if (typeof x === 'function') { return x.tag; }
}
`);
  assert.match(output, /function handle\(x: \(?Function & \{ tag: unknown; \}\)?\)/);
});

test('refines an in-operator narrowing with the method called inside the branch', () => {
  const { output } = infer(`
function handle(x: any) {
  if ('render' in x) { x.render(); }
}
`);
  assert.match(output, /function handle\(x: \(?object & \{ render: \(\.\.\.args: unknown\[\]\) => unknown; \}\)?\)/);
});

test('does not pollute a concrete class source with incidental member accesses', () => {
  const { output } = infer(`
class Box { value = 1; }
function handle(x: any) {
  if (x instanceof Box) { return x.value; }
}
`);
  assert.match(output, /function handle\(x: Box\)/);
  assert.doesNotMatch(output, /Box & \{/);
});

test('unions typeof and instanceof narrowing into a parameter union', () => {
  const { output } = infer(`
class Box { v = 1; }
function handle(x: any) {
  if (typeof x === 'string') return 1;
  if (x instanceof Box) return x.v;
}
`);
  assert.match(output, /function handle\(x: \(Box \| string\)\)/);
});

test('unions Array.isArray and instanceof narrowing into a parameter union', () => {
  const { output } = infer(`
class Box { v = 1; }
function handle(x: any) {
  if (Array.isArray(x)) return x.length;
  if (x instanceof Box) return x.v;
}
`);
  assert.match(output, /function handle\(x: \(Box \| unknown\[\]\)\)/);
});

test('back-propagates an instanceof parameter type through a chained variable', () => {
  const { output } = infer(`
class Box { v = 1; }
function handle(x: any) {
  if (x instanceof Box) return x.v;
}
let value: any;
handle(value);
let copy: any = value;
`);
  assert.match(output, /let copy: Box = value;/);
});

test('infers an object shape with a callable method from a method call', () => {
  const { output } = infer(`let x: any; x.for(1);\n`);
  assert.match(output, /let x: \{ for: \(\.\.\.args: unknown\[\]\) => unknown; \}/);
  assert.doesNotMatch(output, /for: unknown/);
});

test('infers multiple methods and plain properties on the same object', () => {
  const { output } = infer(`let x: any; x.for(1); const v = x.name;\n`);
  assert.match(output, /for: \(\.\.\.args: unknown\[\]\) => unknown;/);
  assert.match(output, /name: unknown;/);
});

test('does not downgrade a method signature to unknown when read first', () => {
  const { output } = infer(`let x: any; const a = x.for; x.for(1);\n`);
  assert.match(output, /for: \(\.\.\.args: unknown\[\]\) => unknown;/);
  assert.doesNotMatch(output, /for: unknown/);
});

test('does not misclassify a plain property read as a method', () => {
  const { output } = infer(`let x: any; const v = x.name;\n`);
  assert.match(output, /let x: \{ name: unknown; \}/);
  assert.doesNotMatch(output, /name: \(/);
});

test('back-propagates an inferred object shape to the call site', () => {
  const { output } = infer(`
function setup(x: any) { x.for(1); }
let value: any;
setup(value);
`);
  assert.match(output, /let value: \{ for: \(\.\.\.args: unknown\[\]\) => unknown; \}/);
});

test('refines a method-shape parameter to a concrete type inferred at the call site', () => {
  const { output } = infer(`
function format(x: any) { return x.toFixed(2); }
let value: any = 42;
format(value);
`);
  // value is inferred as number from its initializer in round 1; round 2
  // refines format's parameter from the weak { toFixed: fn } shape to number.
  assert.match(output, /function format\(x: number\)/);
  assert.match(output, /let value: number = 42;/);
});

test('refines a method-shape parameter from assignment evidence at the call site', () => {
  const { output } = infer(`
function format(x: any) { return x.toFixed(2); }
let value: any;
value = 42;
format(value);
`);
  assert.match(output, /function format\(x: number\)/);
  assert.match(output, /let value: number;/);
});

test('refines a method-shape parameter to a user class instance', () => {
  const { output } = infer(`
class W { toFixed(n: number) { return '' + n; } }
function format(x: any) { return x.toFixed(2); }
let value: any = new W();
format(value);
`);
  assert.match(output, /function format\(x: W\)/);
});

test('propagates a refined parameter type through a chained variable', () => {
  const { output } = infer(`
function format(x: any) { return x.toFixed(2); }
let value: any = 42;
format(value);
let copy: any = value;
`);
  assert.match(output, /function format\(x: number\)/);
  assert.match(output, /let copy: number = value;/);
});

test('keeps the method shape when the call-site argument has no concrete evidence', () => {
  const { output } = infer(`
function format(x: any) { return x.toFixed(2); }
`);
  assert.match(output, /function format\(x: \{ toFixed: \(\.\.\.args: unknown\[\]\) => unknown; \}\)/);
});

test('instantiates generic classes inferred via instanceof with unknown', () => {
  const { output } = infer(`
function isEmpty(x: any) {
  if (x instanceof Map) return x.size === 0;
  if (x instanceof Set) return x.size === 0;
  return false;
}
let value: any;
isEmpty(value);
`);
  // Generic type arguments must be instantiated with `unknown`, never leak the
  // uninstantiated `K`/`V`/`T` from lib.d.ts (which caused TS2304).
  assert.match(output, /Map<unknown, unknown>/);
  assert.match(output, /Set<unknown>/);
  assert.doesNotMatch(output, /<K|Set<T>|Map<K/);
  assert.match(output, /let value:/);
});

test('infers object from an any passed to Object.defineProperty', () => {
  const { output, sites } = infer(`
let x: any;
Object.defineProperty(x, 'key', { value: 1 });
`);
  assert.match(output, /let x: object;/);
  assert.equal(sites.filter((site) => site.inferred === 'object').length, 1);
});

test('infers object from Object.defineProperties and Reflect.set', () => {
  const first = infer(`let x: any; Object.defineProperties(x, {});\n`).output;
  assert.match(first, /let x: object;/);
  const second = infer(`let x: any; Reflect.set(x, 'k', 1);\n`).output;
  assert.match(second, /let x: object;/);
});

test('back-propagates an Object.defineProperty object parameter to the call site', () => {
  const { output } = infer(`
function setup(x: any) { Object.defineProperty(x, 'key', { value: 1 }); }
let value: any;
setup(value);
`);
  assert.match(output, /function setup\(x: object\)/);
  assert.match(output, /let value: object;/);
});

test('keeps a concrete object initializer instead of the weaker object constraint', () => {
  const { output } = infer(`
let x: any = { a: 1 };
Object.defineProperty(x, 'b', { value: 2 });
`);
  assert.match(output, /let x: \{[^}]*a: number[^}]*\}/);
});

test('still infers object for Object.keys whose lib signature is already object', () => {
  const { output } = infer(`
let x: any;
Object.keys(x);
`);
  assert.match(output, /let x: object;/);
});

test('leaves any untouched for an unrelated call named defineProperty', () => {
  const { output } = infer(`
declare function defineProperty(o: any, k: string): void;
let x: any;
defineProperty(x, 'k');
`);
  assert.match(output, /let x: any;/);
});

test('keeps any when object and string constraints conflict', () => {
  const { output } = infer(`
declare function takeString(s: string): void;
let x: any;
Object.defineProperty(x, 'a', { value: 1 });
takeString(x);
`);
  assert.match(output, /let x: any;/);
});
