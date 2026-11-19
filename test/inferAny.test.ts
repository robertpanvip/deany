import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as ts from 'typescript';
import { inferAnyInProject } from '../src/inferAny.js';
import { buildInferenceTable } from '../src/inferAny/table.js';
import { createContext, createTable, MAX_FIXED_POINT_ROUNDS } from '../src/inferAny/state.js';
import { collectAnyOwners } from '../src/inferAny/collect.js';

const compilerOptions: ts.CompilerOptions = {
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  skipLibCheck: true,
  noEmit: true,
};

function infer(
  source: string,
  options: Parameters<typeof inferAnyInProject>[2] = {},
): { output: string; sites: readonly { inferred?: string; reason?: string }[] } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'infer-any-'));
  const file = path.join(directory, 'case.ts');
  fs.writeFileSync(file, source, 'utf8');
  try {
    const [result] = inferAnyInProject([file], compilerOptions, options);
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
  assert.match(output, /let value!?: number;/);
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
  const decl = output.match(/let v!?: \(?([^;]+?)\)?;/)?.[1] ?? '';
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
  assert.match(output, /let v!?: string;/);
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

test('includeAssertions infers any inside as / angle-bracket assertions', () => {
  const asCase = infer(`const a = 1 as any;\nconst b: number = a;\n`, { includeAssertions: true });
  assert.match(asCase.output, /const a = 1 as number;/);
  assert.ok(asCase.sites.some((s) => s.inferred === 'number'));
  const angle = infer(`const a = <any>"hi";\nconst b: string = a;\n`, { includeAssertions: true });
  assert.match(angle.output, /const a = <string>"hi";/);
  // Unknown-typed expression has no evidence: keep any, do not fabricate.
  const unknownCase = infer(`declare const u: unknown;\nconst a = u as any;\n`, { includeAssertions: true });
  assert.match(unknownCase.output, /u as any/);
});

test('unassigned let keeps inference but gains a definite-assignment assertion', () => {
  // Regression: narrowing `let v: any` to a concrete type makes tsc emit
  // TS2454 (used before assigned). `let v!: T` keeps the inferred type and is
  // strict-clean. Let declarations that are initialized or assigned, and
  // ambient `declare var`, must NOT gain a `!`.
  const r = infer(`function fmt(x: any) { if (typeof x === 'string') return 1; }\nlet v: any;\nfmt(v);\n`);
  assert.match(r.output, /let v!: string;/);
  const init = infer(`let v: any = "hi";\n`);
  assert.match(init.output, /let v: string = "hi";/);
  const assigned = infer(`let v: any;\nv = "hi";\n`);
  assert.match(assigned.output, /let v: string;/);
  const ambient = infer(`declare var module: any;\nmodule.exports = 1;\n`);
  assert.doesNotMatch(ambient.output, /declare var module!:/);
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

test('projects a slot whose type contains commas (function type) without double-wrapping', () => {
  // String projection used to split the type arguments on the comma inside the
  // function type and fail, falling back to the whole type (double wrap). The
  // checker's structured type reads the slot directly.
  const { output } = infer(
    `const m: Map<string, any> = new Map<string, (a: number, b: string) => void>();\n`,
  );
  assert.match(output, /const m: Map<string, \(a: number, b: string\) => void>/);
  assert.doesNotMatch(output, /Map<string, Map</);
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

test('infers a Record value slot from an object-literal initializer, not the whole shape', () => {
  const { output } = infer(`const rec: Record<string, any> = { a: 1, b: 2 };\n`);
  assert.match(output, /const rec: Record<string, number>/);
  assert.doesNotMatch(output, /Record<string, \{/);
  assert.doesNotMatch(output, /\bany\b/);
});

test('unions mixed value types in a Record<string, any> initializer', () => {
  const { output } = infer(`const rec: Record<string, any> = { a: 1, b: 'x' };\n`);
  assert.match(output, /const rec: Record<string, \(?number \| string\)?>/);
  assert.doesNotMatch(output, /\bany\b/);
});

test('infers a ReadonlyRecord value slot from an object-literal initializer', () => {
  const { output } = infer(`const rec: ReadonlyRecord<string, any> = { a: 1, b: 2 };\n`);
  assert.match(output, /const rec: ReadonlyRecord<string, number>/);
  assert.doesNotMatch(output, /\bany\b/);
});

test('a Record value slot uses the property value type, not the initializer shape', () => {
  const { output } = infer(`const rec: Record<string, any> = { a: { x: 1 } };\n`);
  assert.match(output, /const rec: Record<string, \{ x: number; \}> = \{ a: \{ x: 1 \} \};/);
  assert.doesNotMatch(output, /Record<string, \{ a:/);
});

test('does not treat read-only container accesses as element evidence', () => {
  const { output } = infer(`const a: any[] = [1]; console.log(a.length, a.map);\n`);
  assert.match(output, /const a: number\[\]/);
});

test('nested any annotation still infers the whole type when not nested', () => {
  const { output } = infer(`let x: any = [1, 2];\n`);
  assert.match(output, /let x!?: Array<number> = \[1, 2\];/);
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
  assert.match(output, /let value!?: \(number \| string\);/);
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
  assert.match(output, /let value!?: \(number \| string\);/);
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
  assert.match(output, /let copy!?: \(number \| string\) = value;/);
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
  assert.match(output, /let value!?: string;/);
});

test('does not infer a parameter type when the body has no typeof narrowing', () => {
  const { output } = infer(`
function identity(x: any) { return x; }
let value: any;
identity(value);
`);
  assert.match(output, /function identity\(x: any\)/);
  assert.match(output, /let value!?: any;/);
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
    assert.match(consumer?.output ?? '', /let value!?: \(number \| string\);/);
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
  assert.match(output, /let value!?: unknown\[\];/);
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

test('infers an any parameter from a custom type-predicate guard', () => {
  const { output } = infer(`
class Foo { a = 1; }
function isFoo(x: unknown): x is Foo { return true; }
function handle(x: any) {
  if (isFoo(x)) { return x.a; }
}
`);
  assert.match(output, /function handle\(x: Foo\)/);
});

test('type-predicate guard narrows the exact guarded parameter, not other arguments', () => {
  const { output } = infer(`
class Foo { a = 1; }
function isFoo(x: unknown): x is Foo { return true; }
function handle(x: any, y: any) {
  if (isFoo(x)) { return x.a; }
  return y;
}
`);
  assert.match(output, /function handle\(x: Foo, y: any\)/);
});

test('predicate guard narrows a chained variable through the call site', () => {
  const { output } = infer(`
class Foo { a = 1; }
function isFoo(x: unknown): x is Foo { return true; }
function handle(x: any) { if (isFoo(x)) { return x.a; } }
let value: any;
handle(value);
let copy: any = value;
`);
  assert.match(output, /let value!?: Foo;/);
  assert.match(output, /let copy!?: Foo = value;/);
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

test('member calls in concrete typeof branches do not pollute a sibling Function member', () => {
  // Each guard narrows x to a concrete type that already owns the called
  // method (string.toUpperCase, number.toFixed). Those method names must not
  // be collected into the shared property shape and then intersected onto the
  // memberless `Function` source from `typeof x === 'function'`.
  const { output } = infer(`
function f(x: any) {
  if (typeof x === 'string') return x.toUpperCase();
  if (typeof x === 'number') return x.toFixed(2);
  if (typeof x === 'function') return x();
  return null;
}
`);
  assert.match(output, /function f\(x: \(?Function \| number \| string\)?\)/);
  assert.doesNotMatch(output, /Function & \{/);
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
  assert.match(output, /let copy!?: Box = value;/);
});

test('infers an object shape with a callable method from a method call', () => {
  const { output } = infer(`let x: any; x.for(1);\n`);
  assert.match(output, /let x!?: \{ for: \(\.\.\.args: unknown\[\]\) => unknown; \}/);
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
  assert.match(output, /let x!?: \{ name: unknown; \}/);
  assert.doesNotMatch(output, /name: \(/);
});

test('back-propagates an inferred object shape to the call site', () => {
  const { output } = infer(`
function setup(x: any) { x.for(1); }
let value: any;
setup(value);
`);
  assert.match(output, /let value!?: \{ for: \(\.\.\.args: unknown\[\]\) => unknown; \}/);
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
  assert.match(output, /let value!?: number = 42;/);
});

test('refines a method-shape parameter from assignment evidence at the call site', () => {
  const { output } = infer(`
function format(x: any) { return x.toFixed(2); }
let value: any;
value = 42;
format(value);
`);
  assert.match(output, /function format\(x: number\)/);
  assert.match(output, /let value!?: number;/);
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
  assert.match(output, /let copy!?: number = value;/);
});

test('narrows to the builtin type when the only method is lib-unique', () => {
  const { output } = infer(`
function format(x: any) { return x.toFixed(2); }
function upper(s: any) { return s.toUpperCase(); }
function stamp(d: any) { return d.getTime(); }
`);
  // `toFixed`/`toUpperCase`/`getTime` exist on exactly one builtin family in
  // lib.d.ts, so a binding observed only calling them narrows to number /
  // string / Date. Weak evidence: a concrete call-site type still wins.
  assert.match(output, /function format\(x: number\)/);
  assert.match(output, /function upper\(s: string\)/);
  assert.match(output, /function stamp\(d: Date\)/);
});

test('does not narrow when a non-unique method is also observed', () => {
  const { output } = infer(`
function f(o: any) { o.toUpperCase(); o.customThing(); }
`);
  assert.match(output, /customThing/);
  assert.doesNotMatch(output, /o: string/);
});

test('does not narrow a lib-unique method whose return signature contradicts the builtin', () => {
  // `toUpperCase` is unique to string in lib.d.ts and returns string. If the
  // call site expects a number, it cannot be the builtin — a custom object
  // with a coincidentally named method. Synthesize a signature returning the
  // observed type (so strict still passes) but never claim the receiver is
  // string/number.
  const { output } = infer(`
function upper(x: any): number { return x.toUpperCase(); }
function fixed(x: any): number { return x.toFixed(2); }
function assigned(x: any) { const n: number = x.toUpperCase(); return n; }
`);
  assert.doesNotMatch(output, /x: string/);
  assert.doesNotMatch(output, /x: number/);
  assert.match(output, /upper\(x: \{ toUpperCase: \(\.\.\.args: unknown\[\]\) => number; \}\)/);
  assert.match(output, /fixed\(x: \{ toFixed: \(\.\.\.args: unknown\[\]\) => number; \}\)/);
  assert.match(output, /\(\.\.\.args: unknown\[\]\) => number/);
});

test('still narrows a lib-unique method when the return signature agrees with the builtin', () => {
  const { output } = infer(`
function upper(x: any): string { return x.toUpperCase(); }
function fixed(x: any): string { return x.toFixed(2); }
`);
  assert.match(output, /upper\(x: string\)/);
  assert.match(output, /fixed\(x: number\)/);
});

test('keeps an object literal with its own toUpperCase as a shape, not string', () => {
  const { output } = infer(`
const only: any = { toUpperCase() { return 'x'; } };
only.toUpperCase();
const mixed: any = { toUpperCase() { return 'x'; }, extra: 1 };
mixed.toUpperCase();
function f(x: any) { return x.toUpperCase(); }
const r = f({ toUpperCase() { return 'x'; }, extra: 1 });
`);
  // A real initializer is strong evidence and wins over the weak lib-unique
  // fallback. Even a literal whose ONLY method is `toUpperCase` must keep its
  // own object shape; a call-site literal likewise beats the weak narrowing.
  assert.match(output, /const only: \{ toUpperCase\(\): string; \}/);
  assert.match(output, /const mixed: \{ toUpperCase\(\): string; extra: number; \}/);
  assert.match(output, /f\(x: \{ toUpperCase\(\): string; extra: number; \}\)/);
  assert.doesNotMatch(output, /const only: string/);
  assert.doesNotMatch(output, /const mixed: string/);
  assert.doesNotMatch(output, /f\(x: string\)/);
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
  assert.match(output, /let value!?:/);
});

test('infers object from an any passed to Object.defineProperty', () => {
  const { output, sites } = infer(`
let x: any;
Object.defineProperty(x, 'key', { value: 1 });
`);
  assert.match(output, /let x!?: object;/);
  assert.equal(sites.filter((site) => site.inferred === 'object').length, 1);
});

test('infers object from Object.defineProperties and Reflect.set', () => {
  const first = infer(`let x: any; Object.defineProperties(x, {});\n`).output;
  assert.match(first, /let x!?: object;/);
  const second = infer(`let x: any; Reflect.set(x, 'k', 1);\n`).output;
  assert.match(second, /let x!?: object;/);
});

test('back-propagates an Object.defineProperty object parameter to the call site', () => {
  const { output } = infer(`
function setup(x: any) { Object.defineProperty(x, 'key', { value: 1 }); }
let value: any;
setup(value);
`);
  assert.match(output, /function setup\(x: object\)/);
  assert.match(output, /let value!?: object;/);
});

test('keeps a concrete object initializer instead of the weaker object constraint', () => {
  const { output } = infer(`
let x: any = { a: 1 };
Object.defineProperty(x, 'b', { value: 2 });
`);
  assert.match(output, /let x!?: \{[^}]*a: number[^}]*\}/);
});

test('still infers object for Object.keys whose lib signature is already object', () => {
  const { output } = infer(`
let x: any;
Object.keys(x);
`);
  assert.match(output, /let x!?: object;/);
});

test('leaves any untouched for an unrelated call named defineProperty', () => {
  const { output } = infer(`
declare function defineProperty(o: any, k: string): void;
let x: any;
defineProperty(x, 'k');
`);
  assert.match(output, /let x!?: any;/);
});

test('keeps any when object and string constraints conflict', () => {
  const { output } = infer(`
declare function takeString(s: string): void;
let x: any;
Object.defineProperty(x, 'a', { value: 1 });
takeString(x);
`);
  assert.match(output, /let x!?: any;/);
});

test('infers string from template interpolation, concatenation and strict comparison', () => {
  const { output } = infer(`
function interpolated(id: any): string { return \`id is \${id}\`; }
function concatenated(a: any): string { return 'x' + a; }
function compared(id: any): boolean { return id === 'x'; }
`);
  assert.match(output, /function interpolated\(id: string\)/);
  assert.match(output, /function concatenated\(a: string\)/);
  assert.match(output, /function compared\(id: string\)/);
});

test('string contexts are a weak hint and never override real numeric evidence', () => {
  const { output } = infer(`
function numeric(a: any): string { return a + 1; }
function assigned(a: any): string { a = 1; return \`\${a}\`; }
`);
  assert.match(output, /function numeric\(a: number\)/);
  assert.match(output, /function assigned\(a: number\)/);
});

test('does not invent a string type when both comparison operands are untyped', () => {
  const { output } = infer(`
function same(a: any, b: any): boolean { return a === b; }
`);
  assert.match(output, /function same\(a: any, b: any\)/);
});

test('uses checker control-flow narrowing inside a switch(typeof) guard', () => {
  // The syntactic typeof rule only matches `typeof x === 'literal'` binaries;
  // a switch case is invisible to it. The checker has already narrowed x to
  // string inside `case 'string'`, so read that type directly at the use site.
  const { output } = infer(`
function f(x: any) { switch (typeof x) { case 'string': x.length; break; } }
`);
  assert.match(output, /function f\(x: string\)/);
  assert.doesNotMatch(output, /\{ length: number \}/);
});

test('uses checker control-flow narrowing inside instanceof and custom-predicate guards', () => {
  const { output } = infer(`
function isStr(v: any): v is string { return typeof v === 'string'; }
function byInst(x: any) { if (x instanceof Date) { return x.getTime(); } return 0; }
function byPredicate(x: any) { if (isStr(x)) { return x.toUpperCase(); } return ''; }
`);
  assert.match(output, /function byInst\(x: Date\)/);
  assert.match(output, /function byPredicate\(x: string\)/);
});

test('control-flow narrowing does not pollute ordinary un-narrowed use sites', () => {
  // At a plain call/property site the checker reports `any` for an `any`
  // binding, so no narrowing evidence is recorded; those sites must still be
  // inferred from their own call-site / property evidence, not from each other.
  const { output } = infer(`
function f(x: any) { x.toUpperCase(); return x.length; }
`);
  assert.doesNotMatch(output, /function f\(x: string\)/);
  assert.match(output, /toUpperCase: \(/);
});

test('recovers a definite string from an opaque array join/toString call', () => {
  // `join`/`toString` return `string` regardless of element type. When the
  // checker types the call as `any` (chained opaque receiver), the receiver's
  // independently-inferred array type confirms the method, so the return is
  // known — never a method-name guess.
  const { output } = infer(`
function mk(): any { return [1, 2]; }
const s: any = mk().join(',');
const t: any = mk().toString();
`);
  assert.match(output, /const s: string = mk\(\)\.join/);
  assert.match(output, /const t: string = mk\(\)\.toString/);
});

// --- Structural slot projection: no more non-compiling substitutions --------

test('generic parameter default/constraint never gets the owner whole type', () => {
  // slotPathOf only models `any[]` / `Type<..., any>`. A bare `<T = any>` or
  // `<T extends any>` fell through with an empty path and got the enclosing
  // function's return type substituted (`<T = void>` / `<T extends void>`),
  // which is meaningless or circular. Both must become the legal, equivalent
  // `unknown` — never the function's own type, never a self-reference.
  const { output } = infer(`
export function withDefault<T = any>(v: T) {}
export function withConstraint<T extends any>(v: T) {}
`);
  // Naming-agnostic: match any type-parameter name, not a hard-coded `T`.
  assert.match(output, /withDefault<\s*\w+\s*=\s*unknown\s*>/);
  assert.match(output, /withConstraint<\s*\w+\s+extends\s+unknown\s*>/);
  // Guard against a non-unknown default/constraint slipping back in (void/any/...) —
  // also naming-agnostic, so renaming the parameter cannot defeat them.
  assert.doesNotMatch(output, /<\s*\w+\s*=\s*(?!unknown\b)\w+/);
  assert.doesNotMatch(output, /\bextends\s+(?!unknown\b)\w+\s*>/);
});

test('fixed-point diagnostics report convergence and round count', () => {
  // The inference table must expose whether fixed-point iteration converged
  // and how many rounds it used, so a non-converged long chain is observable
  // rather than silently returning a partial table.
  const source = `
let a: any = 1;
let b: any = a;
let c: any = b;
declare function take(n: number): void;
take(c);
`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-'));
  const file = path.join(directory, 'case.ts');
  fs.writeFileSync(file, source, 'utf8');
  try {
    const program = ts.createProgram([file], compilerOptions);
    const ctx = createContext(program.getTypeChecker(), program, createTable());
    const table = buildInferenceTable(collectAnyOwners(program), ctx);
    assert.equal(table.diagnostics.converged, true);
    assert.ok(table.diagnostics.rounds >= 1);
    assert.ok(table.diagnostics.rounds <= MAX_FIXED_POINT_ROUNDS);
    assert.equal(table.diagnostics.maxRounds, MAX_FIXED_POINT_ROUNDS);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('tuple element any is projected to the element slot, not the whole tuple', () => {
  // `[any, number]` previously became `[[string, number], number]` (the whole
  // inferred tuple substituted into element 0) -> TS2322.
  const { output } = infer(`export const t: [any, number] = ['a', 1];`);
  assert.match(output, /const t: \[string, number\]/);
  assert.doesNotMatch(output, /\[\[string/);
});

test('function-type return any is projected to the return slot, not re-wrapped', () => {
  // `(x: number) => any` previously became
  // `(x: number) => (x: number) => number` (the whole function type substituted
  // into its own return) -> TS2322.
  const { output } = infer(`export const cb: (x: number) => any = x => x;`);
  assert.match(output, /const cb: \(x: number\) => number/);
  assert.doesNotMatch(output, /=> \(x: number\) =>/);
});