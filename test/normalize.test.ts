import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_OPTIONS } from '../src/types.js';
import { extractCustomTypeNames, normalizeJsDocType, normalizeRestType } from '../src/normalize.js';

test('JSDoc generic dots become TypeScript generics', () => {
  assert.equal(normalizeJsDocType('Array.<string>', DEFAULT_OPTIONS), 'Array<string>');
  assert.equal(normalizeJsDocType('Promise.<Array.<number>>', DEFAULT_OPTIONS), 'Promise<Array<number>>');
});

test('loose JSDoc types map to unknown in strict mode', () => {
  assert.equal(normalizeJsDocType('*', DEFAULT_OPTIONS), 'unknown');
  assert.equal(normalizeJsDocType('any', DEFAULT_OPTIONS), 'unknown');
  assert.equal(normalizeJsDocType('?', DEFAULT_OPTIONS), 'unknown');
  assert.equal(
    normalizeJsDocType('*', { ...DEFAULT_OPTIONS, unknownForLoose: false }),
    'any',
  );
});

test('nullable and non-nullable JSDoc types are normalized', () => {
  assert.equal(normalizeJsDocType('?string', DEFAULT_OPTIONS), 'string | null');
  assert.equal(normalizeJsDocType('!string', DEFAULT_OPTIONS), 'string');
});

test('JSDoc Object maps to Record', () => {
  assert.equal(normalizeJsDocType('Object', DEFAULT_OPTIONS), 'Record<string, unknown>');
  assert.equal(
    normalizeJsDocType('Object.<string, Array.<number>>', DEFAULT_OPTIONS),
    'Record<string, Array<number>>',
  );
});

test('JSDoc function types become arrow types', () => {
  assert.equal(
    normalizeJsDocType('function(string, number): boolean', DEFAULT_OPTIONS),
    '(arg0: string, arg1: number) => boolean',
  );
  assert.equal(normalizeJsDocType('function', DEFAULT_OPTIONS), '(...args: unknown[]) => unknown');
});

test('array shorthand is opt-in', () => {
  assert.equal(normalizeJsDocType('Array<string>', DEFAULT_OPTIONS), 'Array<string>');
  assert.equal(
    normalizeJsDocType('Array<string>', { ...DEFAULT_OPTIONS, arrayShorthand: true }),
    'string[]',
  );
  assert.equal(normalizeRestType('...number', DEFAULT_OPTIONS), 'number[]');
  assert.equal(normalizeRestType('...Array<string>', DEFAULT_OPTIONS), 'Array<string>[]');
});

test('JSDoc module: namespace prefixes are stripped', () => {
  assert.equal(normalizeJsDocType('module:ControlFlow.QueueObject', DEFAULT_OPTIONS), 'ControlFlow.QueueObject');
  assert.equal(normalizeJsDocType('module:Utils.memoize', DEFAULT_OPTIONS), 'Utils.memoize');
});

test('function types in a union are parenthesized', () => {
  assert.equal(
    normalizeJsDocType('function(A): X | function(B): Y', DEFAULT_OPTIONS),
    '((arg0: A) => X) | ((arg0: B) => Y)',
  );
  // A function inside a generic must not be double-parenthesized.
  assert.equal(
    normalizeJsDocType('Array<function(A): X>', DEFAULT_OPTIONS),
    'Array<(arg0: A) => X>',
  );
});

test('bare generics get type arguments to stay strict-safe', () => {
  assert.equal(normalizeJsDocType('Array', DEFAULT_OPTIONS), 'Array<unknown>');
  assert.equal(normalizeJsDocType('Promise', DEFAULT_OPTIONS), 'Promise<unknown>');
  assert.equal(normalizeJsDocType('Map', DEFAULT_OPTIONS), 'Map<unknown, unknown>');
  assert.equal(normalizeJsDocType('Set', DEFAULT_OPTIONS), 'Set<unknown>');
});

test('capitalized JSDoc primitive names normalize to TS keywords', () => {
  assert.equal(normalizeJsDocType('String', DEFAULT_OPTIONS), 'string');
  assert.equal(normalizeJsDocType('Number', DEFAULT_OPTIONS), 'number');
  assert.equal(normalizeJsDocType('Boolean', DEFAULT_OPTIONS), 'boolean');
  assert.equal(normalizeJsDocType('Integer', DEFAULT_OPTIONS), 'number');
  assert.equal(normalizeJsDocType('Float', DEFAULT_OPTIONS), 'number');
  assert.equal(normalizeJsDocType('String|Number', DEFAULT_OPTIONS), 'string | number');
  // Nested in a generic: each argument is normalized recursively.
  assert.equal(normalizeJsDocType('Array.<String>', DEFAULT_OPTIONS), 'Array<string>');
  assert.equal(normalizeJsDocType('Promise.<Number>', DEFAULT_OPTIONS), 'Promise<number>');
});


test('TS built-in utility types are not emitted as dangling fallback aliases', () => {
  const typeText = '(receiver: ThisParameterType<typeof RegExp.prototype.exec>, ...args: Parameters<typeof RegExp.prototype.exec>) => ReturnType<typeof RegExp.prototype.exec>';
  assert.deepEqual(extractCustomTypeNames(typeText, new Set(), new Set()), []);
  // Other lib utility / intrinsic string types are likewise not custom.
  assert.deepEqual(
    extractCustomTypeNames(
      'ConstructorParameters<T> | Uppercase<S> | ReadonlyArray<NoInfer<V>> | OmitThisParameter<F>',
      new Set(),
      new Set(['T', 'S', 'V', 'F']),
    ),
    [],
  );
  // A genuinely undefined capitalized type is still reported for fallback.
  assert.deepEqual(extractCustomTypeNames('Missing Foo', new Set(), new Set()).sort(), ['Foo', 'Missing']);
});

test('capitalized property names in object type literals are not custom types', () => {
  // Regression: `@param {{Name: string, Age: number}}` was scanned for
  // capitalized identifiers, so `Name`/`Age` (property names, not type refs)
  // became bogus `type Name = unknown; type Age = unknown;` aliases.
  assert.deepEqual(extractCustomTypeNames('{Name: string, Age: number}', new Set(), new Set()), []);
  assert.deepEqual(extractCustomTypeNames('{Foo: Bar}', new Set(), new Set()), ['Bar']);
  // A real capitalized type reference inside an object value is still found.
  assert.deepEqual(extractCustomTypeNames('{ value: Missing }', new Set(), new Set()), ['Missing']);
});

test('normalizeJsDocType defaults options when omitted', () => {
  // Regression: the public export must not throw when called with one arg.
  assert.equal(normalizeJsDocType('string'), 'string');
  assert.equal(normalizeJsDocType('function():number'), '() => number');
});

test('normalizes JSDoc function types nested in unions and parens', () => {
  // Regression (TS8020): raw `function(...)` leaking into a type annotation
  // position is illegal TS. Every union/paren path must converge to arrows.
  assert.equal(normalizeJsDocType('(function():number)|string', DEFAULT_OPTIONS), '(() => number) | string');
  assert.equal(normalizeJsDocType('(number|function():void)', DEFAULT_OPTIONS), 'number | (() => void)');
  assert.equal(
    normalizeJsDocType('function(A):X|function(B):Y', DEFAULT_OPTIONS),
    '((arg0: A) => X) | ((arg0: B) => Y)',
  );
  // Meaningful groupings must not be damaged.
  assert.equal(normalizeJsDocType('(a)|(b)', DEFAULT_OPTIONS), 'a | b');
  assert.equal(normalizeJsDocType('((number))', DEFAULT_OPTIONS), 'number');
});

test('normalizes nested/curried JSDoc function types (no greedy param swallow)', () => {
  // The old greedy regex swallowed the inner function into the parameter list,
  // emitting invalid `(arg0: number): function(number) => number` (TS1005,
  // TS2571). Split at the FIRST top-level ')' so the return type keeps its own
  // `function(...)` and becomes a nested arrow.
  assert.equal(
    normalizeJsDocType('function(number): function(number): number', DEFAULT_OPTIONS),
    '(arg0: number) => (arg0: number) => number',
  );
  assert.equal(
    normalizeJsDocType('function(number): function(string): boolean', DEFAULT_OPTIONS),
    '(arg0: number) => (arg0: string) => boolean',
  );
  // Single-level and multi-param forms unchanged.
  assert.equal(normalizeJsDocType('function(string, number): boolean', DEFAULT_OPTIONS), '(arg0: string, arg1: number) => boolean');
});

test('R17-P2-1: normalizeJsDocType merges defaults for partial options', () => {
  // The exported API may be called with `{}`; loose types must still become
  // unknown (DEFAULT_OPTIONS.unknownForLoose) rather than any.
  assert.equal(normalizeJsDocType('*', {} as any), 'unknown');
  assert.equal(normalizeJsDocType('?', {} as any), 'unknown');
  assert.equal(normalizeJsDocType('', {} as any), 'unknown');
});

// --- Review 0.1.17 batch 2: normalization reproductions ---
test('R17b-1: capitalized/loose primitives with array suffixes normalize their element', () => {
  const o = DEFAULT_OPTIONS;
  assert.equal(normalizeJsDocType('String[]', o), 'string[]');
  assert.equal(normalizeJsDocType('Number[][]', o), 'number[][]');
  assert.equal(normalizeJsDocType('*[]', o), 'unknown[]');
  assert.equal(normalizeJsDocType('Array<Array.String>', o), 'Array<Array<string>>');
});

test('R17b-2: a pipe inside a string literal is data, not a union separator', () => {
  assert.equal(normalizeJsDocType("'a|b'", DEFAULT_OPTIONS), "'a|b'");
  assert.equal(normalizeJsDocType("Array<'a|b'>", DEFAULT_OPTIONS), "Array<'a|b'>");
});

test('R17b-3: array shorthand parenthesizes function element types', () => {
  const sh = { ...DEFAULT_OPTIONS, arrayShorthand: true };
  assert.equal(normalizeJsDocType('Array.<function():void>', sh), '(() => void)[]');
  assert.equal(normalizeRestType('...function(number): number', DEFAULT_OPTIONS), '((arg0: number) => number)[]');
});

test('R17b-4: a => inside generic args does not close the generic early', () => {
  assert.equal(normalizeJsDocType('Object.<string, () => void>', DEFAULT_OPTIONS), 'Record<string, () => void>');
  assert.equal(normalizeJsDocType('Object.<string, (x:number)=>void>', DEFAULT_OPTIONS), 'Record<string, (x:number)=>void>');
});

test('R17b-6: trailing default-value = is stripped', () => {
  assert.equal(normalizeJsDocType('number=', DEFAULT_OPTIONS), 'number');
  assert.equal(normalizeJsDocType('Array.<T>=', DEFAULT_OPTIONS), 'Array<T>');
});

test('R17b-7: function(this:/new:) markers do not leak as arg types', () => {
  assert.equal(normalizeJsDocType('function(this:Foo)', DEFAULT_OPTIONS), '(this: Foo) => void');
  assert.equal(normalizeJsDocType('function(new:Foo)', DEFAULT_OPTIONS), '() => void');
});

test('R17b-10: module: path separators become namespace dots', () => {
  assert.equal(normalizeJsDocType('module:fs/promises', DEFAULT_OPTIONS), 'fs.promises');
  assert.equal(normalizeJsDocType('module:fs~readFile', DEFAULT_OPTIONS), 'fs.readFile');
});
