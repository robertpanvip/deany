import * as ts from 'typescript';

export const TYPE_FORMAT =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseFullyQualifiedType |
  ts.TypeFormatFlags.WriteArrayAsGenericType

/**
 * Array iteration methods whose callback's first parameter is an element. The
 * element's accessed property chain is a strong, structural hint about the
 * array's element type. `reduce`/`reduceRight` are excluded because their first
 * callback parameter is the accumulator, not an element.
 */
export const ITERATION_METHODS = new Set<string>([
  'map', 'forEach', 'filter', 'find', 'findIndex', 'some', 'every',
  'flatMap', 'includes', 'indexOf', 'lastIndexOf',
])

/** Standard Array members — calling one says nothing about a custom shape. */
export const ARRAY_BUILTIN_MEMBERS = new Set<string>([
  ...ITERATION_METHODS,
  'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'concat', 'join',
  'reverse', 'sort', 'fill', 'copyWithin', 'reduce', 'reduceRight', 'flat',
  'entries', 'keys', 'values', 'length', 'at', 'findLast', 'findLastIndex',
  'toReversed', 'toSorted', 'toSpliced', 'with', 'toString',
])

/**
 * Methods that, in the standard lib, exist on exactly one primitive/builtin
 * family. A binding whose ONLY evidence is calls to these methods can be
 * narrowed to that family. This is not a name guess — the method is unique in
 * lib.d.ts — but it is still weak evidence: apply it only as a last resort and
 * never when the binding has a real source or other, non-unique properties.
 */
export const UNIQUE_BUILTIN_METHODS: ReadonlyArray<{
  readonly type: string;
  readonly methods: ReadonlySet<string>;
}> = [
  {
    type: 'string',
    methods: new Set([
      'toUpperCase', 'toLowerCase', 'trim', 'trimStart', 'trimEnd', 'charAt',
      'charCodeAt', 'indexOf', 'lastIndexOf', 'startsWith', 'endsWith', 'includes',
      'split', 'substring', 'substr', 'repeat', 'padStart', 'padEnd', 'localeCompare',
    ]),
  },
  {
    type: 'number',
    methods: new Set(['toFixed', 'toPrecision', 'toExponential', 'valueOf']),
  },
  {
    type: 'Date',
    methods: new Set([
      'getTime', 'toISOString', 'toUTCString', 'toDateString', 'toLocaleString',
      'getFullYear', 'getMonth', 'getDate', 'getDay', 'getHours', 'getMinutes',
      'getSeconds', 'getMilliseconds', 'getTimezoneOffset', 'setFullYear',
      'setMonth', 'setDate', 'setHours', 'setMinutes', 'setSeconds',
    ]),
  },
]

/**
 * The real lib return type of each lib-unique method. A method name being
 * unique is necessary but not sufficient: the observed return context must
 * also agree with the builtin's return type. A binding observed calling
 * `toUpperCase()` where a `number` is expected is NOT a string — it is some
 * custom object with a coincidentally named method that returns a number.
 */
export const BUILTIN_METHOD_RETURN: ReadonlyMap<string, string> = new Map([
  ['toUpperCase', 'string'], ['toLowerCase', 'string'], ['trim', 'string'],
  ['trimStart', 'string'], ['trimEnd', 'string'], ['charAt', 'string'],
  ['substring', 'string'], ['substr', 'string'], ['repeat', 'string'],
  ['padStart', 'string'], ['padEnd', 'string'],
  ['charCodeAt', 'number'], ['indexOf', 'number'], ['lastIndexOf', 'number'],
  ['localeCompare', 'number'],
  ['startsWith', 'boolean'], ['endsWith', 'boolean'], ['includes', 'boolean'],
  ['split', 'string[]'],
  ['toFixed', 'string'], ['toPrecision', 'string'], ['toExponential', 'string'],
  ['valueOf', 'number'],
  ['getTime', 'number'], ['getFullYear', 'number'], ['getMonth', 'number'],
  ['getDate', 'number'], ['getDay', 'number'], ['getHours', 'number'],
  ['getMinutes', 'number'], ['getSeconds', 'number'], ['getMilliseconds', 'number'],
  ['getTimezoneOffset', 'number'], ['setFullYear', 'number'], ['setMonth', 'number'],
  ['setDate', 'number'], ['setHours', 'number'], ['setMinutes', 'number'],
  ['setSeconds', 'number'],
  ['toISOString', 'string'], ['toUTCString', 'string'], ['toDateString', 'string'],
  ['toLocaleString', 'string'],
])

/**
 * Array methods whose return type does not depend on the element type, so a
 * definite result can be recovered even when the checker types the call as
 * `any` (e.g. a chained opaque receiver). Used only when the receiver's
 * inferred type is independently confirmed as an array.
 */
export const ARRAY_SCALAR_RETURN: ReadonlyMap<string, string> = new Map([
  ['join', 'string'],
  ['toString', 'string'],
])

/** Observed contextual return types that carry no information — ignore them. */
export const VAGUE_RETURN_TYPES = new Set(['any', 'unknown', 'never', 'void', ''])

/**
 * Minimal strict-safe contract for a value indexed by arbitrary keys. Using
 * `PropertyKey` covers string, number and symbol keys, so the same type works
 * for `x[k]`, `x[symbol]` and `for (k in x)` without inventing a value type.
 */
export const INDEXABLE_OBJECT = 'Record<PropertyKey, unknown>'

/**
 * Memberless object sources produced by type guards: `typeof x === 'object'`
 * and `'k' in x` yield `object`; `typeof x === 'function'` yields `Function`.
 * They narrow the *category* but declare no members, so a real `.foo()` /
 * `x.bar` call on the guarded value is rejected in strict mode (TS2339 /
 * TS18046). These are refined with the members actually accessed on the value
 * — the same structural evidence used for `Array.isArray`'s elementShape —
 * never by a "method name looks like X" guess.
 */
export const MEMBERLESS_OBJECT_SOURCES = new Set(['object', 'Function'])

/** Bitwise operators coerce both operands to int32 in JavaScript. */
export const BITWISE_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
])

/**
 * Operators that coerce both operands to a number in JavaScript and can never
 * concatenate (`+` is deliberately excluded — `'a' + b` is string concat).
 * `'a' - b` yields NaN, but the operand is still numerically coerced, so an
 * operand observed here is soundly `number` (matching the bitwise-operator
 * treatment). `bigint` operands remain legal via their own checked source.
 */
export const NUMERIC_COERCION_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
])

/** Relational operators only accept orderable primitives (number/string). */
export const RELATIONAL_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
])

/**
 * Built-in APIs whose parameter slots semantically require an object even
 * though their `lib.d.ts` signatures type the slot as `any` or a bare generic
 * `T` (e.g. `Object.defineProperty<T>(o: T, ...)`). Passing an `any` binding
 * into one of these slots is a contravariant constraint: the value must be
 * assignable to `object`. Keyed by `<receiver>.<method>`; values are the
 * zero-based argument indices that require an object.
 */
export const OBJECT_ARGUMENT_APIS: Readonly<Record<string, readonly number[]>> = {
  'Object.assign': [0], // target (trailing sources may legally be null/undefined)
  'Object.defineProperties': [0],
  'Object.defineProperty': [0],
  'Object.entries': [0],
  'Object.freeze': [0],
  'Object.getOwnPropertyDescriptor': [0],
  'Object.getOwnPropertyDescriptors': [0],
  'Object.getOwnPropertyNames': [0],
  'Object.getOwnPropertySymbols': [0],
  'Object.getPrototypeOf': [0],
  'Object.hasOwn': [0],
  'Object.isExtensible': [0],
  'Object.isFrozen': [0],
  'Object.isSealed': [0],
  'Object.keys': [0],
  'Object.preventExtensions': [0],
  'Object.seal': [0],
  'Object.setPrototypeOf': [0],
  'Object.values': [0],
  'Reflect.apply': [0],
  'Reflect.construct': [0],
  'Reflect.defineProperty': [0],
  'Reflect.deleteProperty': [0],
  'Reflect.get': [0],
  'Reflect.getOwnPropertyDescriptor': [0],
  'Reflect.getPrototypeOf': [0],
  'Reflect.has': [0],
  'Reflect.ownKeys': [0],
  'Reflect.set': [0],
  'Reflect.setPrototypeOf': [0],
}
