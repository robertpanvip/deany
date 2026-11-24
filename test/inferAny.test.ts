import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as ts from 'typescript';
import { inferAnyInProject, createUsageResolver } from '../src/inferAny.js';
import { checkStrict } from '../src/check.js';
import { convertSource } from '../src/convert.js';
import { buildInferenceTable } from '../src/inferAny/table.js';
import { createContext, createTable, emptyEvidence, MAX_FIXED_POINT_ROUNDS } from '../src/inferAny/state.js';
import { collectAnyOwners } from '../src/inferAny/collect.js';
import { collectDeclarations } from '../src/inferAny/collect.js';
import { collectEvidence } from '../src/inferAny/evidence/index.js';
import { mergeEvidence } from '../src/inferAny/shape.js';
import { variableNameSuggestsType } from '../src/inferAny/constants.js';
import { splitTopLevelUnion } from '../src/inferAny/util.js';

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

test('a multi-branch string return is not frozen as unknown by an unresolved dependency', () => {
  // Fixed-point ordering bug: `miniKindOf` returns a string from every branch,
  // but `return constructorName` depends on `ctorName`'s inferred return. On
  // the first round `ctorName` is not yet in the table, so that one return
  // contributes an opaque `unknown`, making the whole merge `unknown` (strong).
  // If frozen there, later rounds never revisit it even after `ctorName` settles
  // to `string`. A bare-`unknown` result must stay open until convergence.
  const { output, cleanup } = convertGuardJs(`
function ctorName(val) {
  return (typeof val.constructor === 'function' ? val.constructor.name : null);
}
function miniKindOf(val) {
  if (val === void 0) return 'undefined';
  if (val === null) return 'null';
  var type = typeof val;
  if (Array.isArray(val)) return 'array';
  var constructorName = ctorName(val);
  if (constructorName === 'Symbol') return constructorName;
  return type.slice(8, -1).toLowerCase();
}
module.exports = miniKindOf;
`);
  try {
    assert.match(output, /function miniKindOf\(val[^)]*\): string\b/);
    assert.doesNotMatch(output, /function miniKindOf\(val[^)]*\): unknown\b/);
  } finally {
    cleanup();
  }
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

test('string-like contexts alone do not narrow any to string', () => {
  // Regression (P0-2): template interpolation, `+` with a string, and `===`
  // a string literal all accept non-strings (numbers, booleans, objects).
  // Treating them as proof of `string` silently narrowed the public contract:
  // `function tpl(x: any)` became `x: string`, so `tpl(42)` broke. With no
  // real evidence, the `any` must stay untouched.
  const { output } = infer(`
function interpolated(id: any): string { return \`id is \${id}\`; }
function concatenated(a: any): string { return 'x' + a; }
function compared(id: any): boolean { return id === 'x'; }
`);
  assert.match(output, /function interpolated\(id: any\): string/);
  assert.match(output, /function concatenated\(a: any\): string/);
  assert.match(output, /function compared\(id: any\): boolean/);
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

test('fixed point tracks dependency edges so a strong-but-unstable owner is revisited', () => {
  // Evidence strength and evidence stability are distinct. A function whose
  // every return feeds a value from another declaration is *strong* evidence
  // (concrete values, not a synthesized shape) yet *unstable* until that
  // declaration is inferred. The solver must record the dependency edge and
  // re-collect the function when the dependency changes, instead of freezing
  // an early premature value.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-track-'));
  const file = path.join(directory, 'case.ts');
  fs.writeFileSync(
    file,
    `
function pick(v: any) { return v; }
var source: any = 'hello';
function forward() { return pick(source); }
`,
    'utf8',
  );
  try {
    const program = ts.createProgram([file], compilerOptions);
    const ctx = createContext(program.getTypeChecker(), program, createTable());
    const table = buildInferenceTable(collectDeclarations(program), ctx);
    assert.equal(table.diagnostics.converged, true);
    // `forward`'s body reads `pick`'s return and `source`'s type; at least the
    // call-site dependency must be recorded for the stability check to work.
    let forward: ts.FunctionDeclaration | undefined;
    const visit = (n: ts.Node): void => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === 'forward') forward = n;
      ts.forEachChild(n, visit);
    };
    visit(program.getSourceFile(file)!);
    assert.ok(forward !== undefined);
    const deps = table.dependencies.get(forward);
    assert.ok(deps !== undefined && deps.size > 0, 'forward must record dependency edges');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('fixed-point non-convergence is exposed on InferFileResult (arch P1)', () => {
  // A long reverse dependency chain propagates one hop per round; with more
  // hops than MAX_FIXED_POINT_ROUNDS the table cannot settle. The status MUST
  // reach the public result so the CLI/API can warn instead of silently
  // emitting a partially inferred file.
  const lines: string[] = [];
  const n = MAX_FIXED_POINT_ROUNDS + 4;
  for (let i = 0; i < n - 1; i += 1) {
    lines.push(`let v${i}: any = v${i + 1};`);
  }
  lines.push(`let v${n - 1}: any = 42;`);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-nonconv-'));
  const file = path.join(directory, 'chain.ts');
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  try {
    const [result] = inferAnyInProject([file], compilerOptions);
    assert.ok(result !== undefined);
    assert.equal(result.diagnostics.converged, false);
    assert.equal(result.diagnostics.rounds, MAX_FIXED_POINT_ROUNDS);
    assert.equal(result.diagnostics.maxRounds, MAX_FIXED_POINT_ROUNDS);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('all file results share one project-level diagnostics object (arch P1)', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-shared-'));
  const a = path.join(directory, 'a.ts');
  const b = path.join(directory, 'b.ts');
  fs.writeFileSync(a, `const x: any = 1;\n`, 'utf8');
  fs.writeFileSync(b, `const y: any = 's';\n`, 'utf8');
  try {
    const results = inferAnyInProject([a, b], compilerOptions);
    assert.equal(results.length, 2);
    assert.equal(results[0]?.diagnostics.converged, true);
    assert.strictEqual(results[0]?.diagnostics, results[1]?.diagnostics);
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
// --- P0 regression: early return, weak evidence, for-of element ------------

test('early return with an implicit undefined path includes undefined in the return type', () => {
  // Regression (P0-1): `if (c) return 1;` also falls through to an implicit
  // `undefined`. Typing the return as just `number` makes --check fail TS2366.
  const { output } = infer(`function pick(c: any): any { if (c) return 1; }\n`);
  assert.match(output, /number \| undefined/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('for-of yields an Iterable protocol (element type from body), not an array', () => {
  // P0-3: the loop body pins the element to `number` so `t += v` type-checks.
  // Architecture review 1.2/1.6: `for...of` only proves Iterable — emitting
  // `number[]` used to reject legal `Set`/Generator/string inputs.
  const { output } = infer(`function total(list: any) { let t = 0; for (const v of list) { t += v; } return t; }\n`);
  assert.match(output, /list: Iterable<number>/);
  assert.doesNotMatch(output, /list: number\[\]/);
  const strict = checkStrict(
    'case.ts',
    output + '\ntotal([1,2]); total(new Set([1,2])); total((function*(){yield 1;})());\n',
  );
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

// --- S4 regression: exported params must not be narrowed by internal calls ----

test('S4: an exported function parameter is not narrowed by internal call sites', () => {
  // The public contract must not be inferred from how the module happens to
  // call itself. `process("hello")` internally must not turn `value: any` into
  // `value: string` — external callers may pass any value.
  const { output, sites } = infer(`
export function process(value: any) { return String(value); }
process('hello');
process('world');
`);
  assert.match(output, /export function process\(value: any\)/);
  assert.ok(sites.some((site) => site.original === 'any' && site.inferred === undefined));
});

test('S4: a non-exported parameter is still narrowed by call sites (unchanged)', () => {
  const { output } = infer(`
function helper(value: any) { return String(value); }
helper('hello');
`);
  assert.match(output, /function helper\(value: string\)/);
});

test('S4: genuine guard evidence still narrows an exported parameter', () => {
  // Lowering call-site confidence must not discard strong evidence from the
  // function body itself (typeof/instanceof narrowing).
  const { output } = infer(`
export function format(x: any) { if (typeof x === 'string') return 1; if (typeof x === 'number') return 2; }
`);
  assert.match(output, /export function format\(x: \(number \| string\)\)/);
});

test('S4: a sibling .d.ts contract outranks call-site inference (including unknown)', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 's4-dts-'));
  const api = path.join(directory, 'api.ts');
  const dts = path.join(directory, 'api.d.ts');
  fs.writeFileSync(api, `export function process(value: any) { return value.toString(); }\nprocess('hello');\n`, 'utf8');
  fs.writeFileSync(dts, `export declare function process(value: unknown): string;\n`, 'utf8');
  try {
    const results = inferAnyInProject([api, dts], compilerOptions);
    const producer = results.find((result) => result.fileName === api);
    assert.match(producer?.output ?? '', /export function process\(value: unknown\)/);
    assert.ok(producer?.sites.some((site) => site.inferred === 'unknown'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('S4: a sibling .d.ts restores a concrete parameter type over usage inference', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 's4-dts2-'));
  const mod = path.join(directory, 'mod.ts');
  const dts = path.join(directory, 'mod.d.ts');
  fs.writeFileSync(mod, `export const count: any = 1;\n`, 'utf8');
  fs.writeFileSync(dts, `export declare const count: number;\n`, 'utf8');
  try {
    const results = inferAnyInProject([mod, dts], compilerOptions);
    const producer = results.find((result) => result.fileName === mod);
    assert.match(producer?.output ?? '', /export const count: number/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('G2: a sibling .d.ts generic contract injects the type-parameter declaration', () => {
  // The d.ts fills any-slots with `T`, but the implementation has no `<T>` of
  // its own. Without injecting the type-parameter list the output references
  // an undeclared name (TS2304). Must be injected once per function.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'g2-dts-'));
  const api = path.join(directory, 'api.ts');
  const dts = path.join(directory, 'api.d.ts');
  fs.writeFileSync(api, `export function id(value: any): any { return value; }\n`, 'utf8');
  fs.writeFileSync(dts, `export declare function id<T>(value: T): T;\n`, 'utf8');
  try {
    const results = inferAnyInProject([api, dts], compilerOptions);
    const producer = results.find((result) => result.fileName === api);
    const out = producer?.output ?? '';
    assert.match(out, /export function id<T>\(value: T\): T/);
    // Exactly one `<T>` — not duplicated despite two any slots (param + return).
    assert.equal((out.match(/<T>/g) ?? []).length, 1);
    assert.equal(checkStrict(api, out).ok, true, checkStrict(api, out).diagnostics.join('\n'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('G2: a multi-param generic contract injects once and fills every slot', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'g2-dts2-'));
  const api = path.join(directory, 'api.ts');
  const dts = path.join(directory, 'api.d.ts');
  fs.writeFileSync(
    api,
    `export function pair(a: any, b: any): any { return [a, b]; }\n`,
    'utf8',
  );
  fs.writeFileSync(dts, `export declare function pair<T, U>(a: T, b: U): [T, U];\n`, 'utf8');
  try {
    const results = inferAnyInProject([api, dts], compilerOptions);
    const out = results.find((result) => result.fileName === api)?.output ?? '';
    assert.match(out, /export function pair<T, U>\(a: T, b: U\): \[T, U\]/);
    assert.equal(checkStrict(api, out).ok, true, checkStrict(api, out).diagnostics.join('\n'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('G2: a non-generic d.ts contract does not inject a type parameter', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'g2-dts3-'));
  const api = path.join(directory, 'api.ts');
  const dts = path.join(directory, 'api.d.ts');
  fs.writeFileSync(api, `export function id(value: any): any { return value; }\n`, 'utf8');
  fs.writeFileSync(dts, `export declare function id(value: string): string;\n`, 'utf8');
  try {
    const results = inferAnyInProject([api, dts], compilerOptions);
    const out = results.find((result) => result.fileName === api)?.output ?? '';
    assert.match(out, /export function id\(value: string\): string/);
    assert.doesNotMatch(out, /id</);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('S4: all module export forms keep public parameters un-narrowed, private ones narrow', () => {
  // Locks the export-surface detection: ESM export/export{}/default/exported
  // class methods and CommonJS module.exports all protect the public contract;
  // private helpers still get the historic call-site inference.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 's4-forms-'));
  const file = path.join(directory, 'a.ts');
  const commonJsOptions: ts.CompilerOptions = {
    ...compilerOptions,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
  };
  fs.writeFileSync(
    file,
    [
      `export function direct(v: any){ return String(v); } direct('x');`,
      `function later(v: any){ return String(v); } export { later }; later('x');`,
      `export default function def(v: any){ return String(v); } def('x');`,
      `const arrow=(v: any)=>String(v); export { arrow }; arrow('x');`,
      `export class K { m(v: any){ return String(v); } }`,
      `function cjs(v: any){ return String(v); } module.exports={cjs}; cjs('x');`,
      `class Priv { m(v: any){ return String(v); } } new Priv().m('x');`,
      `function internal(v: any){ return String(v); } internal('x');`,
    ].join('\n'),
    'utf8',
  );
  try {
    const [result] = inferAnyInProject([file], commonJsOptions);
    const output = result?.output ?? '';
    assert.match(output, /export function direct\(v: any\)/);
    assert.match(output, /function later\(v: any\)/);
    assert.match(output, /function def\(v: any\)/);
    assert.match(output, /const arrow=\(v: any\)/);
    assert.match(output, /class K \{ m\(v: any\)/);
    assert.match(output, /function cjs\(v: any\)/);
    assert.match(output, /class Priv \{ m\(v: string\)/);
    assert.match(output, /function internal\(v: string\)/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('S4: anonymous default-export arrow function keeps its public parameter (arch 2.7)', () => {
  // `export default (value) => ...` has no name and no modifier on the arrow
  // itself; the export lives on the parent ExportAssignment. Its parameter is
  // still public API and must not be narrowed by internal call sites.
  const { output } = infer(`export default (value: any) => String(value);\n`);
  assert.match(output, /export default \(value: any\)/);
});

test('S4: exports.foo = implementation protects implementation, not foo (arch 2.6)', () => {
  // The exported value is the RHS `implementation`, so its public parameter
  // stays `any`. `foo` is a private local and may still narrow from its call.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 's4-cjs-alias-'));
  const file = path.join(directory, 'a.ts');
  const commonJsOptions: ts.CompilerOptions = {
    ...compilerOptions,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
  };
  fs.writeFileSync(
    file,
    [
      `function foo(v: any){ return v.toFixed(2); }`,
      `function implementation(v: any){ return String(v); }`,
      `exports.foo = implementation;`,
      `foo(1.5);`,
    ].join('\n'),
    'utf8',
  );
  try {
    const [result] = inferAnyInProject([file], commonJsOptions);
    const output = result?.output ?? '';
    assert.match(output, /function foo\(v: number\)/);
    assert.match(output, /function implementation\(v: any\)/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('weakSources surface as a diagnostic reason with narrowing still suppressed (arch 3.1)', () => {
  // Collected but unused weak evidence is a smell. It now has a real consumer:
  // the ambiguous-site reason explains why the public parameter stayed `any`.
  const { output, sites } = infer(`export function api(v: any){ return v; }\napi(42);\n`);
  assert.match(output, /export function api\(v: any\)/);
  const reason = sites.find((s) => s.inferred === undefined)?.reason ?? '';
  assert.match(reason, /internal call-site evidence/);
  assert.match(reason, /number/);
});

// --- S4 regression: in-body shape evidence MUST still narrow exported params ---
// Lowering call-site confidence must never suppress evidence derived from how
// the function body actually *uses* its parameter. Property access, builtin
// methods, destructuring and nested shapes are genuine implementation-level
// contracts and must be inferred, even on an exported parameter.

test('S4: in-body property shape narrows an exported param despite a call site', () => {
  // The call site `process('hello')` is downgraded (ignored), but `value.length`
  // is a real in-body shape and must still be inferred.
  const { output } = infer(`
export function process(value: any) { return value.length; }
process('hello');
`);
  assert.match(output, /export function process\(value: \{ length: unknown; \}\)/);
});

test('S4: in-body builtin method narrows an exported param to its host type', () => {
  const { output } = infer(`
export function process(value: any) { return value.toFixed(2); }
`);
  assert.match(output, /export function process\(value: number\)/);
});

test('S4: in-body destructuring narrows an exported param to an object shape', () => {
  const { output } = infer(`
export function process(value: any) { const { a, b } = value; return a; }
`);
  assert.match(output, /export function process\(value: \{ a: unknown; b: unknown; \}\)/);
});

test('S4: a sibling .d.ts still outranks in-body shape evidence', () => {
  // In-body shape is real evidence, but the declared contract remains the
  // highest confidence and must win.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 's4-shape-dts-'));
  const api = path.join(directory, 'api.ts');
  const dts = path.join(directory, 'api.d.ts');
  fs.writeFileSync(api, `export function process(value: any) { return value.length; } process('hello');\n`, 'utf8');
  fs.writeFileSync(dts, `export declare function process(value: unknown): unknown;\n`, 'utf8');
  try {
    const results = inferAnyInProject([api, dts], compilerOptions);
    const producer = results.find((result) => result.fileName === api);
    assert.match(producer?.output ?? '', /export function process\(value: unknown\)/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// --- Program-scan index regression: the single whole-program walk must keep
// symbol identity semantics (no name collisions) and must not break deep
// nesting or mixed call-site kinds after referencesOf/callsOf were rewritten.

test('perf-index: identically named bindings in different scopes stay distinct', () => {
  // referencesOf now keys the global index by symbol identity rather than by
  // `node.text === symbol.getName()`. Two `value` bindings in different scopes
  // must not share references, or their inferred types would cross-contaminate.
  const { output } = infer(`
let value: any;
value = 1;
function f() {
  let value: any;
  value = 'inner';
}
`);
  assert.match(output, /let value!?: number;/);
  assert.match(output, /let value!?: string;/);
});

test('perf-index: nested destructuring still infers a shape (depth guard not tripped)', () => {
  const { output } = infer(`
let data: any;
const { a: { b: { c } } } = data;
`);
  assert.match(output, /let data!?: \{ a: unknown; \};/);
});

test('perf-index: new-expression and callback call sites are both indexed', () => {
  const { output } = infer(`
class C { constructor(x: any) {} }
new C(42);
function reg(cb: any) {}
reg((z) => z + 1);
`);
  assert.match(output, /constructor\(x: number\)/);
  assert.match(output, /cb: \( z: number \) => unknown/);
});

// --- Architecture review part 1: Usage Protocol vs concrete types ----------
// Principle: an automatic type-recovery tool must not NARROW the set of calls
// the original JavaScript accepted. These tests pin that a usage which only
// proves a protocol (iterable / awaitable) never collapses to a concrete type
// (array / PromiseLike).

test('arch1: await operand stays any so plain values and promises are both accepted', () => {
  const { output } = infer(`async function getValue(value: any) { return await value; }\n`);
  assert.match(output, /value: any/);
  assert.doesNotMatch(output, /PromiseLike/);
  const strict = checkStrict(
    'case.ts',
    output + '\ngetValue(123); getValue("hello"); getValue(Promise.resolve(123));\n',
  );
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('arch1: for-of infers Iterable<T>, accepting Set and Generator', () => {
  const { output } = infer(
    `export function sum(values: any) { let total = 0; for (const value of values) { total += value; } return total; }\n`,
  );
  assert.match(output, /values: Iterable<number>/);
  assert.doesNotMatch(output, /values: number\[\]/);
  const strict = checkStrict(
    'case.ts',
    output + '\nsum([1,2]); sum(new Set([1,2])); sum((function*(){yield 1;yield 2;})());\n',
  );
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('arch1: for-of element inference uses symbol identity, not variable name', () => {
  // A nested same-named local (`const value = 1; total += value`) must NOT be
  // mistaken for the loop variable and pin the element type to number.
  const { output } = infer(`
function process(values: any) {
  let total = 0;
  for (const value of values) {
    (() => { const value = 1; total += value; })();
  }
  return total;
}
`);
  assert.match(output, /values: Iterable<unknown>/);
  assert.doesNotMatch(output, /values: Iterable<number>/);
});

test('arch1: array destructuring infers Iterable, accepting Set', () => {
  const { output } = infer(`export function firstOf(value: any) { const [first] = value; return first; }\n`);
  assert.match(output, /value: Iterable<unknown>/);
  const strict = checkStrict('case.ts', output + '\nfirstOf(new Set([1])); firstOf([1,2]);\n');
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('arch1: spread infers Iterable, accepting Generator', () => {
  const { output } = infer(`export function collect(value: any) { return [...value]; }\n`);
  assert.match(output, /value: Iterable<unknown>/);
  const strict = checkStrict(
    'case.ts',
    output + '\ncollect((function*(){yield 1;})()); collect(new Set([1]));\n',
  );
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('arch1: a sibling .d.ts does not apply to a private same-named inner function', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arch1-dts-'));
  const api = path.join(directory, 'api.ts');
  const dts = path.join(directory, 'api.d.ts');
  fs.writeFileSync(
    api,
    `export function process(value: any) { return value.length; }\nfunction internal() { function process(value: any) { return value.toFixed(2); } return process(123); }\n`,
    'utf8',
  );
  fs.writeFileSync(dts, `export declare function process(value: string): number;\n`, 'utf8');
  try {
    const results = inferAnyInProject([api, dts], compilerOptions);
    const out = results.find((r) => r.fileName === api)?.output ?? '';
    assert.match(out, /export function process\(value: string\)/); // exported: d.ts wins
    assert.match(out, /function process\(value: number\)/); // private inner: own inference
    assert.doesNotMatch(out, /function internal\(\) \{ function process\(value: string\)/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('arch1: constructor of an exported class keeps its public parameter type', () => {
  // The constructor is public API; internal `new Client('hello')` must not
  // narrow `value: any` to string (S4 protection extends to constructors).
  const { output } = infer(`export class Client { constructor(value: any) { this.v = value; } v: any; }\nnew Client('hello');\n`);
  assert.match(output, /constructor\(value: any\)/);
});

test('arch1: a private constructor is not treated as public API', () => {
  const { output } = infer(`export class Client { private constructor(value: any) { this.v = value; } v: any; static make(){ return new Client('x'); } }\n`);
  // Private constructors are internal; narrowing from the internal call is fine.
  assert.match(output, /private constructor\(value: string\)/);
});

test('arch1: for-await-of yields Iterable|AsyncIterable, accepting async and sync sources', () => {
  // `for await...of` accepts both sync iterables and async iterables in JS.
  // Accepting only one side would reject legal calls (AsyncGenerator or array).
  const { output } = infer(
    `async function consume(xs: any) { for await (const x of xs) { } }\n`,
  );
  assert.match(output, /Iterable<unknown>/);
  assert.match(output, /AsyncIterable<unknown>/);
  const strict = checkStrict(
    'case.ts',
    output + '\nasync function* gen(){ yield 1; }\nconsume(gen()); consume([1,2]); consume(new Set([1]));\n',
  );
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('arch1: iteration methods (.map) keep an Array despite a for-of protocol', () => {
  // `.map()` requires Array (not on Iterable). A for-of constraint must not
  // mask the Array structure evidence, or the body fails TS2339.
  const { output } = infer(`function f(xs: any) { for (const x of xs) {} return xs.map(v => v.id); }\n`);
  assert.match(output, /Array<\{ id: unknown; \}>/);
});

// --- Line-by-line review bugs B1–B4 ---------------------------------------
test('B1: a write inside a nested function is not definite-assignment', () => {
  // `function f(){ v = 42 }` may never run, so TS flow analysis does not treat
  // `v` as assigned at the read site. Narrowing without `!` emitted TS2454.
  const { output } = infer(
    `let v: any;\nfunction f(){ v = 42; }\nconst n: number = v;\n`,
  );
  assert.match(output, /let v!: number;/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
  // Control: a same-scope assignment stays safe without `!`.
  const same = infer(`let v: any;\nv = 42;\nconst n: number = v;\n`);
  assert.match(same.output, /let v: number;/);
  assert.doesNotMatch(same.output, /let v!:/);
});

test('B2: for-of element dereferences fold into Iterable<shape>', () => {
  // `v.a.b` in the loop body is structural evidence for the element. Emitting
  // bare `Iterable<unknown>` made the very body fail TS18046. Keep the protocol
  // (so Set/Generator are still accepted) but refine the element type.
  const { output } = infer(`function f(xs: any){ for (const v of xs) { v.a.b; } }\n`);
  assert.match(output, /Iterable<\{ a: \{ b: unknown; \}; \}>/);
  const strict = checkStrict(
    'case.ts',
    output + '\nf(new Set([{a:{b:1}}]));\n',
  );
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('B3: destructured for-of bindings fold into Iterable<shape>', () => {
  // `for (const { a } of xs) { a.b }` — the binding key `a` prefixes the chain.
  const { output } = infer(`function f(xs: any){ for (const {a} of xs) { a.b; } }\n`);
  assert.match(output, /Iterable<\{ a: \{ b: unknown; \}; \}>/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('B4: a parenthesized anonymous default-export arrow is public API', () => {
  // `export default ((v) => ...)` — the ExportAssignment's `.expression` is a
  // ParenthesizedExpression. The arrow's parameters must stay protected.
  const { output } = infer(`export default ((v: any) => String(v));\n`);
  assert.match(output, /\(v: any\)/);
});

// --- Review round 4: spread calls, d.ts matching, Math shadowing ---
test('R4-2: call-argument spread uses the callee rest type, not Iterable', () => {
  // `f(...x)` requires an array/tuple, NOT Iterable (TS2345/TS2556). With no
  // call-site evidence, the constraint must come from the resolved signature.
  const { output } = infer(`function sum(...values: number[]): number { return values.reduce((a, b) => a + b, 0); }\nfunction call(values: any) { return sum(...values); }\n`);
  assert.match(output, /function call\(values: number\[\]\)/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('R4-5: a locally shadowed Math.max is not treated as the global one', () => {
  // Matching by callee text would inherit the global `...number[]` contract.
  // The checker resolves the local rest signature `...string[]` instead.
  const { output } = infer(`const Math = { max: (...xs: string[]) => xs.join(','), } as const;\nexport function test(values: any) { return Math.max(...values); }\n`);
  assert.match(output, /function test\(values: string\[\]\)/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('R4-3: a d.ts class method does not pick up a same-named top-level function signature', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-dts-'));
  const api = path.join(directory, 'api.ts');
  const dts = path.join(directory, 'api.d.ts');
  fs.writeFileSync(api, `export function process(value: any): void {}\nexport class Worker { process(value: any): void {} }\n`, 'utf8');
  fs.writeFileSync(dts, `export declare function process(value: string): void;\nexport declare class Worker { process(value: number): void; }\n`, 'utf8');
  try {
    const results = inferAnyInProject([api, dts], compilerOptions);
    const out = results.find((r) => r.fileName === api)?.output ?? '';
    assert.match(out, /export function process\(value: string\)/); // top-level: its own d.ts
    assert.match(out, /Worker[\s\S]*process\(value: number\)/); // method: Class.member contract
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('R4-3b: a d.ts constructor signature is restored onto the class constructor', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-ctor-'));
  const api = path.join(directory, 'api.ts');
  const dts = path.join(directory, 'api.d.ts');
  fs.writeFileSync(api, `export class Client { constructor(value: any) { this.value = value; } value: any; }\n`, 'utf8');
  fs.writeFileSync(dts, `export declare class Client { constructor(value: number); value: number; }\n`, 'utf8');
  try {
    const results = inferAnyInProject([api, dts], compilerOptions);
    const out = results.find((r) => r.fileName === api)?.output ?? '';
    assert.match(out, /constructor\(value: number\)/);
    assert.match(out, /value: number;/);
    const strict = checkStrict(api, out);
    assert.ok(strict.ok, strict.diagnostics.join('\n'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// --- Review round 5: spread tuples, constructor spread, d.ts variable identity ---
test('R5-1a: a spread into a fixed-arity function infers a tuple, not unknown[]', () => {
  // Plain `unknown[]` spread into `(a: number, b: string)` is TS2556; the
  // argument must be a tuple. Previously spreadCallConstraint only looked at
  // rest parameters and fell back to `unknown[]` here.
  const { output } = infer(`function target(a: number, b: string): void {}\nfunction invoke(args: any) { target(...args); }\n`);
  assert.match(output, /function invoke\(args: \[number, string\]\)/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('R5-1b: a constructor spread infers the same tuple as a call spread', () => {
  // `new C(...x)` used to fall into the iterable branch (`Iterable<unknown>`),
  // which is not a legal argument spread. It must share the signature logic.
  const { output } = infer(`class Widget { constructor(a: number, b: string) {} }\nfunction build(args: any) { return new Widget(...args); }\n`);
  assert.match(output, /function build\(args: \[number, string\]\)/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('R5-1c: optional parameters keep their optional tuple marker', () => {
  const { output } = infer(`function f(a: number, b?: string): void {}\nfunction invoke(args: any) { f(...args); }\n`);
  assert.match(output, /function invoke\(args: \[number, string\?\]\)/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('R5-1d: a rest signature still infers the element array, not a tuple', () => {
  // Guard the existing rest-parameter path against the tuple rewrite.
  const { output } = infer(`function sum(...values: number[]): number { return values.reduce((a, b) => a + b, 0); }\nfunction call(values: any) { return sum(...values); }\n`);
  assert.match(output, /function call\(values: number\[\]\)/);
  const strict = checkStrict('case.ts', output);
  assert.ok(strict.ok, strict.diagnostics.join('\n'));
});

test('R5-2: a sibling d.ts variable contract does not leak onto a same-named local', () => {
  // Only the module-level `export const config` is the public contract. The
  // local `config` inside run() must be inferred from its own usage; matching
  // by spelling alone used to inject Record<string,string> and make
  // `config.local = 1` a TS2322.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r5-var-dts-'));
  const api = path.join(directory, 'api.ts');
  const dts = path.join(directory, 'api.d.ts');
  fs.writeFileSync(api, `export const config: any = {};\nexport function run(): object { const config: any = {}; config.local = 1; return config; }\n`, 'utf8');
  fs.writeFileSync(dts, `export declare const config: Record<string, string>;\nexport declare function run(): object;\n`, 'utf8');
  try {
    const results = inferAnyInProject([api, dts], compilerOptions);
    const out = results.find((r) => r.fileName === api)?.output ?? '';
    assert.match(out, /export const config: Record<string, string>/); // export keeps its contract
    // Exactly one variable carries the d.ts contract — the exported one. The
    // (non-exported) local must not get it too.
    assert.equal((out.match(/Record<string, string>/g) ?? []).length, 1);
    assert.match(out, /const config: \{ local\?: number; \} = \{\};/); // local inferred from assignment
    const strict = checkStrict(api, out);
    assert.ok(strict.ok, strict.diagnostics.join('\n'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('R14-1: variable-name hints propose a weak type only with no real evidence', () => {
  // A `let`/`const` without an initializer and no usage evidence may take a
  // low-confidence type from its name. Real evidence (initializer, assignment,
  // JSDoc, property access) always outranks it. Function returns are NEVER
  // typed from names (TS2322, round 12). (Review round 14.)
  assert.equal(variableNameSuggestsType('names'), 'unknown[]');
  assert.equal(variableNameSuggestsType('items'), 'unknown[]');
  assert.equal(variableNameSuggestsType('text'), 'string');
  assert.equal(variableNameSuggestsType('userName'), 'string');
  assert.equal(variableNameSuggestsType('isReady'), 'boolean');
  assert.equal(variableNameSuggestsType('isValid'), 'boolean');
  assert.equal(variableNameSuggestsType('count'), 'number');
  assert.equal(variableNameSuggestsType('data'), undefined);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r14-namehint-'));
  const file = path.join(directory, 'case.js');
  fs.writeFileSync(file,
    'export function f(){ let names; let isReady; let text; let count; let data; }\n', 'utf8');
  try {
    const program = ts.createProgram([file], { ...compilerOptions, allowJs: true, checkJs: true });
    const ctx = createContext(program.getTypeChecker(), program, createTable());
    const byName = new Map<string, { hint?: string; merged?: string }>();
    for (const owner of collectDeclarations(program)) {
      if (ts.isVariableDeclaration(owner) && ts.isIdentifier(owner.name)) {
        const evidence = collectEvidence(owner, ctx);
        const merged = mergeEvidence(evidence);
        byName.set(owner.name.text, { hint: evidence.nameHintType, merged: merged.type });
      }
    }
    assert.equal(byName.get('names')?.hint, 'unknown[]');
    assert.equal(byName.get('names')?.merged, 'unknown[]');
    assert.equal(byName.get('isReady')?.hint, 'boolean');
    assert.equal(byName.get('isReady')?.merged, 'boolean');
    assert.equal(byName.get('text')?.merged, 'string');
    assert.equal(byName.get('count')?.merged, 'number');
    assert.equal(byName.get('data')?.hint, undefined);
    assert.equal(byName.get('data')?.merged, undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('R14-2: real evidence overrides a variable-name hint', () => {
  // JSDoc @type, an initializer, or an assignment are all stronger than the
  // name. The hint must never narrow a binding that has real evidence.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r14-override-'));
  const file = path.join(directory, 'case.js');
  fs.writeFileSync(file,
    'export function f(){ let text; text = 42; const count = "x"; }\n', 'utf8');
  try {
    const program = ts.createProgram([file], { ...compilerOptions, allowJs: true, checkJs: true });
    const ctx = createContext(program.getTypeChecker(), program, createTable());
    for (const owner of collectDeclarations(program)) {
      if (!ts.isVariableDeclaration(owner) || !ts.isIdentifier(owner.name)) continue;
      const merged = mergeEvidence(collectEvidence(owner, ctx));
      if (owner.name.text === 'text') {
        // assignment of 42 wins over the `string` name hint
        assert.equal(merged.type, 'number');
      } else if (owner.name.text === 'count') {
        // initializer "x" wins over the `number` name hint
        assert.equal(merged.type, 'string');
      }
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('P0: a catch-clause any stays any so the annotation stays legal under strict (TS1196)', () => {
  const { output, sites } = infer(`
try { risky(); } catch (e: any) { console.log(e.message); }
declare function risky(): void;
`);
  assert.match(output, /catch \(e: any\)/);
  assert.ok(sites.some((site) => (site.reason ?? '').includes('TS1196')));
  const strict = checkStrict('case.ts', output);
  assert.equal(strict.ok, true, strict.diagnostics.join('\n'));
});

test('P0: strict-equality literal widens a conflicting source instead of emitting TS2367', () => {
  // `flag = 'x'` fixes the binding to string, but the source also does
  // `flag === true`. Emitting `string` alone makes TS reject the comparison
  // (TS2367: string and boolean have no overlap). The literal operand must be
  // unioned in so the comparison stays legal.
  const { output } = infer(`
declare let flag: any;
if (flag === true) { flag = 'x'; }
export const f = flag;
`);
  assert.match(output, /flag: \(?boolean \| string\)?;/);
  const strict = checkStrict('case.ts', output);
  assert.equal(strict.ok, true, strict.diagnostics.join('\n'));
});

test('P0: a lone === literal with no real source still keeps any (P0-2 guard)', () => {
  // The compatibility hint must never become a standalone type source:
  // `function compared(id: any) { return id === 'x' }` stays `any`, otherwise
  // a public caller passing a number would break.
  const { output } = infer(`
export function compared(id: any): boolean { return id === 'x'; }
export function isTrue(x: any): boolean { return x === true; }
`);
  assert.match(output, /function compared\(id: any\): boolean/);
  assert.match(output, /function isTrue\(x: any\): boolean/);
});

test('P0: an equality operand already covered by the source is not duplicated', () => {
  const { output } = infer(`
declare let n: any;
if (n === 5) { n = 5; }
export const out = n;
`);
  assert.match(output, /n: number;/);
  const strict = checkStrict('case.ts', output);
  assert.equal(strict.ok, true, strict.diagnostics.join('\n'));
});

// --- Review P1: rest tuple spread keeps tuple structure, .d.ts class-member identity ---
test('P1: a tuple rest spread keeps its full tuple, not its first element as an array', () => {
  // `f(...args)` where f declares `...xs: [number, string]`: the spread
  // argument must be exactly that tuple. Collapsing to `number[]` (the old
  // behaviour) loses every element after the first and fails the spread
  // with TS2556. Arrays must still infer their element type.
  const fixed = infer(`function f(...xs: [number, string]): void {}\nfunction invoke(args: any) { f(...args); }\n`);
  assert.match(fixed.output, /function invoke\(args: \[number, string\]\)/);
  assert.ok(checkStrict('case.ts', fixed.output).ok, checkStrict('case.ts', fixed.output).diagnostics.join('\n'));

  const arrayRest = infer(`function f(...xs: number[]): void {}\nfunction invoke(args: any) { f(...args); }\n`);
  assert.match(arrayRest.output, /function invoke\(args: number\[\]\)/); // guard: arrays unchanged
  assert.ok(checkStrict('case.ts', arrayRest.output).ok, checkStrict('case.ts', arrayRest.output).diagnostics.join('\n'));
});

test('P1: optional and variadic tuple spreads keep their tuple markers', () => {
  const optional = infer(`function f(...xs: [number, string?]): void {}\nfunction invoke(args: any) { f(...args); }\n`);
  assert.match(optional.output, /function invoke\(args: \(?\[number, \(?string \| undefined\)\?\]\)?\)/);
  assert.ok(checkStrict('case.ts', optional.output).ok, checkStrict('case.ts', optional.output).diagnostics.join('\n'));

  const variadic = infer(`function f(...xs: [number, ...string[]]): void {}\nfunction invoke(args: any) { f(...args); }\n`);
  assert.match(variadic.output, /function invoke\(args: \[number, \.\.\.string\[\]\]\)/);
  assert.ok(checkStrict('case.ts', variadic.output).ok, checkStrict('case.ts', variadic.output).diagnostics.join('\n'));
});

test('P1: a constructor tuple-rest spread infers the tuple, not an array', () => {
  const { output } = infer(`class Widget { constructor(...xs: [number, string]) {} }\nfunction build(args: any) { return new Widget(...args); }\n`);
  assert.match(output, /function build\(args: \[number, string\]\)/);
  assert.ok(checkStrict('case.ts', output).ok, checkStrict('case.ts', output).diagnostics.join('\n'));
});

test('P1: a generic rest parameter never emits an out-of-scope type parameter name', () => {
  // A rest parameter typed by a generic `T` resolves to the type parameter,
  // whose name is not visible at the spread call site. The constraint must
  // fall back to a legal, compilable type instead of leaking `T` (TS2304).
  const { output } = infer(`function f<T extends [number, string]>(...xs: T): void {}\nfunction invoke(args: any) { f(...args); }\n`);
  assert.doesNotMatch(output, /function invoke\(args: T\)/);
  assert.ok(checkStrict('case.ts', output).ok, checkStrict('case.ts', output).diagnostics.join('\n'));
});

test('P1: a sibling d.ts class-member contract does not leak onto a same-named local class', () => {
  // Only the exported `Widget` is the public contract. The local `Widget`
  // declared inside run() must be inferred from its own constructor write.
  // Matching by `Class.member` spelling alone used to inject the exported
  // class's Record<string,string> onto the local value and break
  // `this.value.toFixed(2)`.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-class-dts-'));
  const api = path.join(directory, 'api.ts');
  const dts = path.join(directory, 'api.d.ts');
  fs.writeFileSync(
    api,
    'export class Widget { value: any; constructor() { this.value = {}; } }\n' +
      'export function run(): object { class Widget { value: any; constructor() { this.value = 1.5; } test() { return this.value.toFixed(2); } } return new Widget(); }\n',
    'utf8',
  );
  fs.writeFileSync(
    dts,
    'export declare class Widget { value: Record<string, string>; }\n' +
      'export declare function run(): object;\n',
    'utf8',
  );
  try {
    const results = inferAnyInProject([api, dts], compilerOptions);
    const out = results.find((r) => r.fileName === api)?.output ?? '';
    assert.match(out, /export class Widget \{ value: Record<string, string>/); // export keeps its contract
    assert.equal((out.match(/Record<string, string>/g) ?? []).length, 1); // local must not inherit it
    assert.match(out, /class Widget \{ value: number;/); // local inferred from its own write
    const strict = checkStrict(api, out);
    assert.ok(strict.ok, strict.diagnostics.join('\n'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// --- Implicit type predicates: infer `v is T` for boolean guards from the
// "type mismatch" signal — the guard's parameter reads as wide `any` at the
// call site, but the guard body / the narrowed branch uses it as a concrete
// type ('k' in x, typeof x === 'string', x.map(), x instanceof C, ...). --------
const guardJsOptions: ts.CompilerOptions = {
  allowJs: true,
  checkJs: true,
  noEmit: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  skipLibCheck: true,
};

function convertGuardJs(source: string): { output: string; file: string; cleanup: () => void } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-js-'));
  const file = path.join(directory, 'case.js');
  fs.writeFileSync(file, source, 'utf8');
  const resolver = createUsageResolver([file], guardJsOptions);
  const output = convertSource(file, source, { banner: false }, resolver).output;
  return { output, file, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test('implicit predicate: in-operator in the guarded branch yields `v is object & { key }` (user case)', () => {
  const { output: out, file, cleanup } = convertGuardJs(`
function isObject(v) { return v !== null && typeof v === 'object'; }
function throttle(func, wait, options) {
  if (isObject(options)) {
    var leading = 'leading' in options ? options.leading : false;
    return leading;
  }
  return 0;
}
module.exports = throttle;
`);
  try {
    assert.match(out, /function isObject\(v: unknown\): v is object & \{ leading: unknown \}/);
    const strict = checkStrict(file, out, { allowJs: true });
    assert.ok(strict.ok, strict.diagnostics.join('\n'));
  } finally {
    cleanup();
  }
});

test('implicit predicate: typeof guard body disambiguates a length-only use as `string`, not array', () => {
  const { output: out, file, cleanup } = convertGuardJs(`
function isStr(v) { return typeof v === 'string'; }
function f(x) { if (isStr(x)) { return x.length; } return 0; }
module.exports = f;
`);
  try {
    assert.match(out, /function isStr\(v: unknown\): v is string\b/);
    assert.doesNotMatch(out, /v is unknown\[\]/);
    const strict = checkStrict(file, out, { allowJs: true });
    assert.ok(strict.ok, strict.diagnostics.join('\n'));
  } finally {
    cleanup();
  }
});

test('implicit predicate: array-only method use yields `v is unknown[]`', () => {
  const { output: out, file, cleanup } = convertGuardJs(`
function isArr(v) { return Array.isArray(v); }
function f(x) { if (isArr(x)) { return x.map(function (y) { return y; }); } return 0; }
module.exports = f;
`);
  try {
    assert.match(out, /function isArr\(v: unknown\): v is unknown\[\]/);
    const strict = checkStrict(file, out, { allowJs: true });
    assert.ok(strict.ok, strict.diagnostics.join('\n'));
  } finally {
    cleanup();
  }
});

test('implicit predicate: instanceof yields `v is C` (class name, not constructor type)', () => {
  const { output: out, cleanup } = convertGuardJs(`
function C() {}
function isC(v) { return v instanceof C; }
function f(x) { if (isC(x)) { return x; } return 0; }
module.exports = f;
`);
  try {
    assert.match(out, /function isC\(v: unknown\): v is C\b/);
  } finally {
    cleanup();
  }
});

test('implicit predicate: callable use yields `v is Function`', () => {
  const { output: out, cleanup } = convertGuardJs(`
function isFn(v) { return typeof v === 'function'; }
function f(x) { if (isFn(x)) { return x(); } return 0; }
module.exports = f;
`);
  try {
    assert.match(out, /function isFn\(v: unknown\): v is Function\b/);
  } finally {
    cleanup();
  }
});

test('implicit predicate: a plain boolean function with no type evidence is NOT given a predicate', () => {
  const { output: out, cleanup } = convertGuardJs(`
function isReady(v) { return v > 0; }
function f(x) { if (isReady(x)) { return 1; } return 0; }
module.exports = f;
`);
  try {
    assert.match(out, /function isReady\(v: number\): boolean\b/);
    assert.doesNotMatch(out, /isReady.*\bis\s/);
  } finally {
    cleanup();
  }
});

// --- Cross-file require: the requiring binding must carry the required
// module's inferred export signatures (including implicit predicates), so a
// guard defined in one file narrows its argument in another. ----------------
interface ConvertedFile { readonly file: string; readonly output: string; }

function convertRequireDir(files: Readonly<Record<string, string>>): {
  outputs: Readonly<Record<string, string>>;
  strictFor: (name: string) => ReturnType<typeof checkStrict>;
  cleanup: () => void;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-require-'));
  const abs = (name: string): string => path.join(directory, name);
  for (const [name, source] of Object.entries(files)) fs.writeFileSync(abs(name), source, 'utf8');
  const rootNames = Object.keys(files).map(abs);
  const resolver = createUsageResolver(rootNames, guardJsOptions);
  const outputs: Record<string, string> = {};
  for (const name of Object.keys(files)) {
    outputs[name] = convertSource(abs(name), files[name] ?? '', { banner: false }, resolver).output;
  }
  return {
    outputs,
    strictFor: (name) => checkStrict(abs(name.replace(/\.js$/, '.ts')), outputs[name] ?? '', { allowJs: true }),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

test('cross-file require: object export carries the inferred predicate and narrows the caller', () => {
  const { outputs, strictFor, cleanup } = convertRequireDir({
    'guard.js': `
function isObject(v) { return v !== null && typeof v === 'object'; }
module.exports = { isObject };
`,
    'app.js': `
var guard = require('./guard');
function throttle(options) {
  if (guard.isObject(options)) {
    var leading = 'leading' in options ? options.leading : false;
    return leading;
  }
  return 0;
}
module.exports = throttle;
`,
  });
  try {
    assert.match(outputs['guard.js'] ?? '', /function isObject\(v: unknown\): v is object & \{ leading: unknown \}/);
    assert.match(
      outputs['app.js'] ?? '',
      /var guard: \{ isObject: \(v: unknown\) => v is object & \{ leading: unknown \}; \} = require\('\.\/guard'\)/,
    );
    const strict = strictFor('app.js');
    assert.ok(strict.ok, strict.diagnostics.join('\n'));
  } finally {
    cleanup();
  }
});

test('cross-file require: exports.x = style carries multiple predicates', () => {
  const { outputs, strictFor, cleanup } = convertRequireDir({
    'guards.js': `
function isStr(v) { return typeof v === 'string'; }
function isFn(v) { return typeof v === 'function'; }
exports.isStr = isStr;
exports.isFn = isFn;
`,
    'app.js': `
var g = require('./guards');
function f(a, b) {
  if (g.isStr(a)) { return a.length; }
  if (g.isFn(b)) { return b(); }
  return 0;
}
module.exports = f;
`,
  });
  try {
    assert.match(outputs['guards.js'] ?? '', /function isStr\(v: unknown\): v is string\b/);
    assert.match(outputs['guards.js'] ?? '', /function isFn\(v: unknown\): v is Function\b/);
    assert.match(outputs['app.js'] ?? '', /isStr: \(v: unknown\) => v is string/);
    assert.match(outputs['app.js'] ?? '', /isFn: \(v: unknown\) => v is Function/);
    const strict = strictFor('app.js');
    assert.ok(strict.ok, strict.diagnostics.join('\n'));
  } finally {
    cleanup();
  }
});

test('cross-file require: direct module.exports = guard carries the predicate', () => {
  const { outputs, strictFor, cleanup } = convertRequireDir({
    'guard.js': `
function isObject(v) { return v !== null && typeof v === 'object'; }
module.exports = isObject;
`,
    'app.js': `
var isObject = require('./guard');
function throttle(options) {
  if (isObject(options)) {
    var leading = 'leading' in options ? options.leading : false;
    return leading;
  }
  return 0;
}
module.exports = throttle;
`,
  });
  try {
    assert.match(outputs['app.js'] ?? '', /var isObject: \(v: unknown\) => v is object & \{ leading: unknown \} = require/);
    const strict = strictFor('app.js');
    assert.ok(strict.ok, strict.diagnostics.join('\n'));
  } finally {
    cleanup();
  }
});

test('cross-file require: ESM named exports are inlined with inferred signatures', () => {
  const { outputs, cleanup } = convertRequireDir({
    'math.js': `
export function double(x) { return x * 2; }
export function greet(name) { return 'hi ' + name; }
`,
    'app.js': `
var m = require('./math');
function f() { return m.double(21); }
module.exports = f;
`,
  });
  try {
    assert.match(outputs['app.js'] ?? '', /var m: \{[^}]*double:[^}]*greet:[^}]*\} = require\('\.\/math'\)/);
  } finally {
    cleanup();
  }
});

test('cross-file require: a non-relative specifier is left untouched', () => {
  const { outputs, cleanup } = convertRequireDir({
    'app.js': `
var path = require('path');
function f() { return path.join('a', 'b'); }
module.exports = f;
`,
  });
  try {
    // Bare specifiers use the existing typeof import() path, never inlined.
    assert.doesNotMatch(outputs['app.js'] ?? '', /var path: \{/);
  } finally {
    cleanup();
  }
});


test('type-classifier params (only probed, never consumed) stay unknown', () => {
  // A classifier reports WHAT TYPE its argument is (miniKindOf/kindOf in redux)
  // rather than operating on the value. Its parameter legitimately accepts any
  // value, so narrowing it from its own probes (Array.isArray -> unknown[],
  // isDate -> Date, ...) or from call sites produced a misleading union. The
  // full semantic rule: a bare parameter whose every in-body reference is a
  // type probe (>=2 distinct probe kinds) and which is never read as a value
  // must stay `unknown`.
  const { output, cleanup } = convertGuardJs(`
function isError(val) {
  return val instanceof Error || typeof val.message === 'string' && val.constructor;
}
function ctorName(val) {
  return (typeof val.constructor === 'function' ? val.constructor.name : null);
}
function miniKindOf(val) {
  if (val === void 0) return 'undefined';
  if (val === null) return 'null';
  var type = typeof val;
  switch (type) {
    case 'boolean': case 'string': case 'number': case 'symbol': case 'function': return type;
  }
  if (Array.isArray(val)) return 'array';
  if (isError(val)) return 'error';
  var constructorName = ctorName(val);
  switch (constructorName) {
    case 'Symbol': case 'Promise': return constructorName;
  }
  return type.slice(8, -1).toLowerCase();
}
function kindOf(val) {
  var typeOfVal = typeof val;
  { typeOfVal = miniKindOf(val); }
  return typeOfVal;
}
module.exports = { miniKindOf, kindOf };
`);
  try {
    assert.match(output, /function miniKindOf\(val: unknown\): string\b/);
    assert.match(output, /function kindOf\(val: unknown\): string\b/);
    assert.doesNotMatch(output, /function miniKindOf\(val: unknown\[\]/);
    assert.doesNotMatch(output, /function kindOf\(val: unknown\[\]/);
  } finally {
    cleanup();
  }
});

test('type-classifier rule does not fire when the parameter is read as a value', () => {
  // `x.size === 0` reads a property of x — that is a value use, so x must keep
  // its instanceof-narrowed type (Map/Set), not collapse to `unknown`.
  const { output } = infer(`
function isEmpty(x: any) {
  if (x instanceof Map) return x.size === 0;
  if (x instanceof Set) return x.size === 0;
  return false;
}
`);
  assert.match(output, /x instanceof Map/);
  assert.match(output, /Map<unknown, unknown>/);
});

test('type-classifier rule does not fire on a function that reads a property of its param', () => {
  // `has(key)` reads `key._reactInternals`; its param must keep the property
  // shape, otherwise strict mode raises TS18046 on the property access.
  const { output, file, cleanup } = convertGuardJs(`
function has(key) { return key._reactInternals !== undefined; }
module.exports = has;
`);
  try {
    assert.doesNotMatch(output, /function has\(key: unknown\)/);
    assert.match(output, /_reactInternals/);
    const strict = checkStrict(file, output, { allowJs: true });
    assert.ok(strict.ok, strict.diagnostics.join('\n'));
  } finally {
    cleanup();
  }
});

test('type-probed properties are rendered optional (ctorName.constructor)', () => {
  // `typeof val.constructor === 'function' ? val.constructor.name : null`:
  // guarding a property with typeof before using it means it may be absent,
  // so the synthesized shape must mark it optional (`constructor?:`). The
  // typeof guard narrows back to Function at the access site, so strict mode
  // still accepts `val.constructor.name`. (v0.1.38.)
  const { output, file, cleanup } = convertGuardJs(`
function ctorName(val) {
  return (typeof val.constructor === 'function' ? val.constructor.name : null);
}
module.exports = ctorName;
`);
  try {
    // constructor stays optional; its `name` leaf is the lib-fixed `Function.name: string`
    // (v0.1.41) rather than an opaque `unknown`.
    assert.match(output, /function ctorName\(val: \{ constructor\?: \{ name: string; \}; \}\): string\b/);
    assert.doesNotMatch(output, /name: unknown/);
    const strict = checkStrict(file, output, { allowJs: true });
    assert.ok(strict.ok, strict.diagnostics.join('\n'));
  } finally {
    cleanup();
  }
});

test('well-known inherited built-in chain leaves get lib-fixed scalar types (v0.1.41)', () => {
  // Dereferencing an inherited prototype member has a type dictated by
  // lib.d.ts, not an opaque `unknown`: `constructor.name` is `string`,
  // `constructor.length` is `number`. A deeper dereference of that leaf keeps
  // the ordinary synthesized shape (the built-in rule applies only to a true
  // leaf). Table-driven so new known chains need one entry.
  const { output: nameOut, cleanup: c1 } = convertGuardJs(`
function ctorName(val) { return (typeof val.constructor === 'function' ? val.constructor.name : null); }
module.exports = ctorName;
`);
  const { output: lengthOut, cleanup: c2 } = convertGuardJs(`
function ctorLength(val) { return (typeof val.constructor === 'function' ? val.constructor.length : null); }
module.exports = ctorLength;
`);
  const { output: deepOut, cleanup: c3 } = convertGuardJs(`
function deep(val) { return val.constructor.name.x; }
module.exports = deep;
`);
  try {
    assert.match(nameOut, /constructor\?: \{ name: string; \}/);
    assert.match(lengthOut, /constructor\?: \{ length: number; \}/);
    // Not a leaf anymore: `.name` has its own accessed child, so no scalar.
    assert.match(deepOut, /constructor: \{ name: \{ x: unknown; \}; \}/);
    assert.doesNotMatch(deepOut, /name: string/);
  } finally {
    c1(); c2(); c3();
  }
});

test('null-guarded property is optional; an unguarded property read stays required', () => {
  // A `!= null` probe is the same "may be absent" signal as typeof; a plain
  // dereference with no probe is genuine structural evidence and stays required.
  const { output, cleanup: c1 } = convertGuardJs(`
function probe(val) { if (val.foo != null) return val.foo.x; return 0; }
module.exports = probe;
`);
  const { output: out2, cleanup: c2 } = convertGuardJs(`
function plain(val) { return val.bar.baz; }
module.exports = plain;
`);
  try {
    assert.match(out2, /function plain\(val: \{ bar: \{ baz: unknown; \}; \}\)/);
    assert.match(output, /function probe\(val: \{ foo\?: \{ x: unknown; \}; \}\)/);
  } finally {
    c1(); c2();
  }
});

test('Function built-in members are not re-intersected into a Function source (v0.1.39)', () => {
  // `func.apply(...)` on a value already narrowed to `Function` must not emit
  // `Function & { apply: (...args) => unknown }`: Function.apply is native in
  // lib.d.ts, so the intersection is redundant and misleading. Custom members
  // are still intersected (that is real structural evidence).
  const withApply = emptyEvidence();
  withApply.sources.push('Function');
  withApply.properties.set('apply', '(...args: unknown[]) => unknown');
  assert.equal(mergeEvidence(withApply).type, 'Function');

  const withCallBind = emptyEvidence();
  withCallBind.sources.push('Function');
  withCallBind.properties.set('call', '(...args: unknown[]) => unknown');
  withCallBind.properties.set('bind', '(...args: unknown[]) => unknown');
  assert.equal(mergeEvidence(withCallBind).type, 'Function');

  // A genuine custom member alongside a built-in must survive: only the
  // built-in is filtered, `myCustom` is kept.
  const withCustom = emptyEvidence();
  withCustom.sources.push('Function');
  withCustom.properties.set('apply', '(...args: unknown[]) => unknown');
  withCustom.properties.set('myCustom', 'unknown');
  assert.equal(mergeEvidence(withCustom).type, 'Function & { myCustom: unknown; }');

  // `object` (the other memberless guard source) has no built-ins: its
  // members must all be intersected as before.
  const objectShape = emptyEvidence();
  objectShape.sources.push('object');
  objectShape.properties.set('name', 'unknown');
  objectShape.properties.set('apply', 'unknown');
  assert.equal(mergeEvidence(objectShape).type, 'object & { name: unknown; apply: unknown; }');
});

test('generic built-in-member filtering across all memberless guard sources (v0.1.40)', () => {
  // Object.prototype methods are inherited by every object; recording one as a
  // weak `(...args) => unknown` property overrides the native signature and
  // raises TS18046. The central BUILTIN_MEMBERS_BY_SOURCE table must filter
  // them for BOTH `Function` and `object` sources, while leaving genuinely
  // custom members (and the `constructor` data property) intact.
  const fnHop = emptyEvidence();
  fnHop.sources.push('Function');
  fnHop.properties.set('hasOwnProperty', '(...args: unknown[]) => unknown');
  fnHop.properties.set('toString', 'string');
  fnHop.properties.set('valueOf', 'unknown');
  assert.equal(mergeEvidence(fnHop).type, 'Function');

  const objHop = emptyEvidence();
  objHop.sources.push('object');
  objHop.properties.set('hasOwnProperty', '(...args: unknown[]) => unknown');
  objHop.properties.set('isPrototypeOf', 'unknown');
  assert.equal(mergeEvidence(objHop).type, 'object');

  // `name` is native to Function but a real custom field on an object guard —
  // each source must use only its own built-in set.
  const fnName = emptyEvidence();
  fnName.sources.push('Function');
  fnName.properties.set('name', 'unknown');
  assert.equal(mergeEvidence(fnName).type, 'Function');

  const objName = emptyEvidence();
  objName.sources.push('object');
  objName.properties.set('name', 'unknown');
  objName.properties.set('displayName', 'unknown');
  assert.equal(mergeEvidence(objName).type, 'object & { name: unknown; displayName: unknown; }');

  // `constructor` is excluded from the filtered set (real data, v0.1.38).
  const objCtor = emptyEvidence();
  objCtor.sources.push('object');
  objCtor.properties.set('constructor', 'unknown');
  assert.equal(mergeEvidence(objCtor).type, 'object & { constructor: unknown; }');
});

test('splitTopLevelUnion does not split a | nested inside a generic after an arrow (v0.1.42)', () => {
  // A `>` that closes an arrow (`=>`) is not a generic bracket. Counting it as
  // one drifts the depth and makes the `|` inside `Promise<void | null>` look
  // top-level, emitting the broken members `(cb) => Promise<void` + `null>`
  // and, downstream, invalid syntax `Promise<void) | null>` (react-dom's
  // scheduleTimeout). The generic union must stay intact.
  assert.deepEqual(
    splitTopLevelUnion('(callback: any) => Promise<void | null>'),
    ['(callback: any) => Promise<void | null>'],
  );
  assert.deepEqual(
    splitTopLevelUnion(
      '((handler: TimerHandler, timeout?: number) => number) | ((callback: any) => Promise<void | null>) | undefined',
    ),
    [
      '((handler: TimerHandler, timeout?: number) => number)',
      '((callback: any) => Promise<void | null>)',
      'undefined',
    ],
  );
  // A genuine top-level union is still split.
  assert.deepEqual(splitTopLevelUnion('string | number'), ['string', 'number']);
});

test('a nested generic union in a function type is emitted with balanced brackets (v0.1.42)', () => {
  // End-to-end: a value whose observed type contains an arrow returning a
  // generic with a union inside must not lose a `>` and gain a stray `)`.
  const { output, cleanup } = convertGuardJs(`
function pick(cb) { return cb; }
var scheduleTimeout = typeof setTimeout === 'function' ? setTimeout : undefined;
module.exports = { pick, scheduleTimeout };
`);
  try {
    // No broken `Promise<void) | null>` shape anywhere in the output.
    assert.doesNotMatch(output, /Promise<void\)/);
    assert.doesNotMatch(output, /null>/);
  } finally {
    cleanup();
  }
});

test('pure alias assignment flows shape writes back to the source binding (v0.1.43)', () => {
  // `let a = b; a.c.d = 123` — a and b denote the same object, so the shape
  // written through a is also b's shape. The reverse edge feeds a's inferred
  // type into b with a dependency, so the fixed point re-evaluates b after a
  // settles instead of freezing b at a premature `unknown`. The deep write's
  // RHS type is recorded on the leaf (d: number, not unknown).
  const { output: fnOut, file, cleanup } = convertGuardJs(`
function f(b) { let a = b; a.c.d = 123; }
module.exports = f;
`);
  const { output: constOut, cleanup: c2 } = convertGuardJs(`
function g(b) { const a = b; a.c.d = 123; }
module.exports = g;
`);
  const { output: chainOut, cleanup: c3 } = convertGuardJs(`
function h(b) { let a = b; let c = a; c.c.d = 123; }
module.exports = h;
`);
  try {
    assert.match(fnOut, /function f\(b: \{ c: \{ d: number; \}; \}\): void/);
    assert.match(constOut, /function g\(b: \{ c: \{ d: number; \}; \}\): void/);
    // Two-level alias chain propagates all the way back to b.
    assert.match(chainOut, /function h\(b: \{ c: \{ d: number; \}; \}\): void/);
    const strict = checkStrict(file, fnOut, { allowJs: true });
    assert.ok(strict.ok, strict.diagnostics.join('\n'));
  } finally {
    cleanup(); c2(); c3();
  }
});

test('alias rule only applies to a bare identifier initializer, not expressions or annotations (v0.1.43)', () => {
  // `let a = b + 1` is not an alias: b must not inherit a's shape, and b keeps
  // its numeric coercion source. Likewise an annotated `let a: T = b` is a
  // contract, not an alias edge.
  const { output: exprOut, cleanup: c1 } = convertGuardJs(`
function f(b) { let a = b + 1; a.c.d = 123; }
module.exports = f;
`);
  const { output: directOut, cleanup: c2 } = convertGuardJs(`
function g(b) { b.c.d = 123; }
module.exports = g;
`);
  try {
    assert.match(exprOut, /function f\(b: number\): void/);
    assert.doesNotMatch(exprOut, /b: \{ c/);
    // A direct deep write (no alias) also records the leaf's RHS type.
    assert.match(directOut, /function g\(b: \{ c: \{ d: number; \}; \}\): void/);
  } finally {
    c1(); c2();
  }
});

test('multiple writes through an alias widen the leaf to a union (v0.1.43)', () => {
  const { output, cleanup } = convertGuardJs(`
function f(b) { let a = b; a.c.d = 123; a.c.d = 'x'; }
module.exports = f;
`);
  try {
    assert.match(output, /function f\(b: \{ c: \{ d: number \| string; \}; \}\): void/);
  } finally {
    cleanup();
  }
});

test('sibling pure aliases merge their shapes into a maximal shape (v0.1.45)', () => {
  // Two aliases of one binding each write a different field. They denote the
  // SAME object, so the reflowed object shapes are merged field-wise into
  // `{ x; y }` rather than unioned as `{ x } | { y }`.
  const { output, cleanup } = convertGuardJs(`
function f(b) { let a = b; let c = b; a.x = 1; c.y = 's'; return b; }
module.exports = f;
`);
  try {
    assert.match(output, /function f\(b: \{ x: number; y: string; \}\)/);
    assert.doesNotMatch(output, /\{ x: number; \} \| \{ y: string; \}/);
  } finally {
    cleanup();
  }
});

test('three aliases merge all their fields (v0.1.45)', () => {
  const { output, cleanup } = convertGuardJs(`
function f(b) { let a = b; let c = b; let d = b; a.x = 1; c.y = 's'; d.z = true; return b; }
module.exports = f;
`);
  try {
    assert.match(output, /function f\(b: \{ x: number; y: string; z: boolean; \}\)/);
  } finally {
    cleanup();
  }
});

test('reassigned binding is not a pure alias and does not merge shapes (v0.1.45)', () => {
  // `a` is reassigned, so it is not a stable alias of `b`. Its writes must not
  // be folded onto `b`; only `b`'s own evidence decides its type.
  const { output, cleanup } = convertGuardJs(`
function f(b) { let a = b; a = { q: 1 }; a.x = 1; return b; }
module.exports = f;
`);
  try {
    assert.doesNotMatch(output, /\{ x: number; \}/);
  } finally {
    cleanup();
  }
});

test('mixed alias write and owner write merge into one maximal shape (v0.1.46)', () => {
  // The owner is written directly (`b.x`) and through a pure alias (`a.c.d`).
  // Both denote the same object, so the deep alias write must merge field-wise
  // with the owner's own shape instead of being masked by the alias's source.
  const { output, cleanup } = convertGuardJs(`
function f(b) { let a = b; b.x = 1; a.c.d = 123; return b; }
module.exports = f;
`);
  try {
    assert.match(output, /function f\(b: \{ c: \{ d: number; \}; x: number; \}\)/);
    assert.doesNotMatch(output, /\{ x: number; \} \| \{ c:/);
  } finally {
    cleanup();
  }
});

test('shallow alias write alone does not merge into an owner that has a source (v0.1.46)', () => {
  // A shallow alias write (`a.y`) is already carried by the alias's own
  // `properties`; folding it into the owner's sources widened real-library
  // parameter unions (react-dom). Only deep writes are collected, so this
  // shallow case keeps its prior behaviour rather than merging.
  const { output, cleanup } = convertGuardJs(`
function f(b) { let a = b; b.x = 1; a.y = 's'; return b; }
module.exports = f;
`);
  try {
    assert.match(output, /function f\(b: \{ x: number; \}\)/);
    assert.doesNotMatch(output, /y: string/);
  } finally {
    cleanup();
  }
});

test('reassigned alias writes do not merge into the owner (v0.1.46)', () => {
  // `a` is reassigned, so a write through it is not evidence about `b`.
  const { output, cleanup } = convertGuardJs(`
function f(b) { let a = b; a = { q: 1 }; b.x = 1; a.c.d = 123; return b; }
module.exports = f;
`);
  try {
    assert.doesNotMatch(output, /c: \{ d: number; \}/);
  } finally {
    cleanup();
  }
});

test('array destructuring folds binding element shapes into the element type (v0.1.44)', () => {
  // `const [a, b] = arr; a.x = 1` — the binding elements are the container's
  // elements, so their dereferenced shape refines the opaque Iterable element.
  const { output, cleanup } = convertGuardJs(`
function f(arr) { const [a, b] = arr; a.x = 1; }
module.exports = f;
`);
  try {
    assert.match(output, /function f\(arr: Iterable<\{ x: unknown; \}>\)/);
  } finally {
    cleanup();
  }
});

test('object rest destructuring does not fabricate a source property named rest (v0.1.44)', () => {
  // `const { a, ...rest } = opts` captures the remaining keys; it does NOT
  // require opts to carry a property literally named `rest`. Assert the
  // old bug (opts.rest: unknown) is gone across rest forms.
  const { output: withA, cleanup } = convertGuardJs(`
function f(opts) { const { a, ...rest } = opts; return rest; }
module.exports = f;
`);
  const { output: onlyRest, cleanup: c2 } = convertGuardJs(`
function g(opts) { const { ...rest } = opts; return rest; }
module.exports = g;
`);
  try {
    assert.match(withA, /function f\(opts: \{ a: unknown; \}\)/);
    assert.doesNotMatch(withA, /rest: unknown/);
    assert.match(onlyRest, /function g\(opts: unknown\)/);
    assert.doesNotMatch(onlyRest, /rest: unknown/);
  } finally {
    cleanup(); c2();
  }
});

test('Object.assign source shapes merge into the target binding (v0.1.47)', () => {
  const { output, cleanup } = convertGuardJs(`
function f(b) { Object.assign(b, { x: 1, y: 's' }); return b; }
module.exports = f;
`);
  try {
    assert.match(output, /function f\(b: \{ x: number; y: string; \}\)/);
  } finally {
    cleanup();
  }
});

test('Object.assign with an opaque source does not fabricate fields (v0.1.47)', () => {
  const { output, cleanup } = convertGuardJs(`
function f(b, src) { Object.assign(b, src); return b; }
module.exports = f;
`);
  try {
    assert.match(output, /function f\(b: object, src: unknown\)/);
    assert.doesNotMatch(output, /b: \{ x/);
  } finally {
    cleanup();
  }
});

test('property-path alias folds writes into the nested object shape (v0.1.47)', () => {
  const { output, cleanup } = convertGuardJs(`
function f(b) { let a = b.c; a.d = 1; a.e = 's'; return b; }
module.exports = f;
`);
  try {
    assert.match(output, /function f\(b: \{ c: \{ d: number; e: string; \}; \}\)/);
  } finally {
    cleanup();
  }
});

test('property-path alias with a method call does not reshape the target (v0.1.47)', () => {
  // A known-protocol object (style.setProperty) is not being built up by
  // writes, so `style.display = 'none'` must not reshape `b.style`.
  const { output, cleanup } = convertGuardJs(`
function f(b) { let a = b.style; a.set('x'); a.d = 'none'; return b; }
module.exports = f;
`);
  try {
    assert.match(output, /function f\(b: \{ style: unknown; \}\)/);
  } finally {
    cleanup();
  }
});

test('closure-return alias folds writes through the returned value (v0.1.47)', () => {
  const fn = convertGuardJs(`
function f(b) { function g() { return b; } const x = g(); x.a = 1; return b; }
module.exports = f;
`);
  const arrow = convertGuardJs(`
function h(b) { const g = () => b; const x = g(); x.a = 1; return b; }
module.exports = h;
`);
  try {
    assert.match(fn.output, /function f\(b: \{ a: number; \}\)/);
    assert.match(arrow.output, /function h\(b: \{ a: number; \}\)/);
  } finally {
    fn.cleanup(); arrow.cleanup();
  }
});

test('closure-return alias needs a trivial single-return function (v0.1.47)', () => {
  // g has two returns (one of them null), so its result is not necessarily b.
  const { output, cleanup } = convertGuardJs(`
function f(b) { function g(c) { if (c) return b; return null; } const x = g(1); x.a = 1; return b; }
module.exports = f;
`);
  try {
    assert.doesNotMatch(output, /function f\(b: \{ a: number; \}\)/);
  } finally {
    cleanup();
  }
});

test('destructured param passed through a call site does not accumulate duplicate fields (fixed point)', () => {
  // Regression: a destructured `options` parameter with a `= {}` initializer,
  // passed unchanged through a wrapper call, used to feed its own previous
  // inference result back as a source every round. Because optional field keys
  // kept their `?` when matched against the property map, `concurrency?` was
  // re-appended each round (1->3->6->10...) until the type hit 49K chars and
  // produced 2336 TS2300 duplicate-identifier errors (p-map). The shape must
  // now converge with each field appearing exactly once.
  const { output } = infer(`
function pMap(iterable: any, mapper: any, options: any) {
  return mapConcurrently(iterable, mapper, options, false);
}
async function mapConcurrently(iterable: any, mapper: any,
  { concurrency = Infinity, stopOnError = true, signal }: any = {}, isSettled: any) {
  validateOptions(iterable, mapper, concurrency);
  const listener = () => reject(signal.reason);
  signal?.removeEventListener('abort', listener);
  if (signal?.aborted) reject(signal.reason);
  signal.addEventListener('abort', listener, { once: true });
  if (!stopOnError) {}
  for (let i = 0; i < concurrency; i++) {}
}
function validateOptions(a: any, b: any, c: any) {}
function reject(x: any) {}
`);
  const concurrencyFields = (output.match(/concurrency\?/g) ?? []).length;
  assert.ok(concurrencyFields <= 2, `expected <=2 concurrency? fields, got ${concurrencyFields}`);
  assert.ok(output.length < 3000, `output should stay compact, got ${output.length} chars`);
  const line = output.split('\n').find((l) => l.includes('concurrency?'));
  if (line !== undefined) {
    assert.ok(line.length < 600, `options type line should stay short, got ${line.length} chars`);
  }
});
