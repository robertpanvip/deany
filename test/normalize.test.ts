import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_OPTIONS } from '../src/types.js';
import { normalizeJsDocType, normalizeRestType } from '../src/normalize.js';

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
