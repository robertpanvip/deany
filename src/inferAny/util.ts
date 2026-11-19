import * as ts from 'typescript';
import { hasTopLevelArrow } from '../normalize.js';

import type { FunctionLikeWithBody, InferenceContext } from './types.js';
import { OBJECT_ARGUMENT_APIS, TYPE_FORMAT } from './constants.js';

export function isFunctionLike(node: ts.Node): node is FunctionLikeWithBody {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/** True only if the single matching paren for index 0 closes at the very end. */
export function wrappedInOuterParens(type: string): boolean {
  if (!type.startsWith('(') || !type.endsWith(')')) {
    return false;
  }
  let depth = 0;
  for (let i = 0; i < type.length; i += 1) {
    const ch = type[i] ?? '';
    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        return i === type.length - 1;
      }
    }
  }
  return false;
}

/** Parenthesize a composite (union/intersection) type when used as a nested type. */
export function parenthesizeIfComposite(type: string): string {
  if (type.includes('|') || type.includes('&')) {
    if (wrappedInOuterParens(type)) {
      return type;
    }
    return `(${type})`;
  }
  return type;
}

/**
 * Find the declaration that owns a type annotation containing `any`.
 * Walking upward handles `any[]`, `Array<any>`, `Map<string, any>`, etc.
 */
export function ownerOf(anyNode: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = anyNode.parent;
  while (current !== undefined) {
    if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
      return undefined;
    }
    if (
      ts.isVariableDeclaration(current) ||
      ts.isParameter(current) ||
      ts.isPropertyDeclaration(current) ||
      ts.isPropertySignature(current) ||
      isFunctionLike(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * The structural position of an `any` token inside its type annotation, as a
 * sequence of type-argument indices from the outside in. Examples:
 *   `let x: any`                 -> []       (the whole type)
 *   `let a: any[]`               -> [0]      (array element)
 *   `let m: Map<string, any>`    -> [1]      (second type argument)
 *   `let g: Array<Map<string, any>>` -> [0, 1]
 * Walking stops as soon as a non-generic type node (or the declaration) is hit.
 */
export function slotPathOf(anyNode: ts.Node): number[] {
  const path: number[] = [];
  let current: ts.Node = anyNode;
  let parent: ts.Node | undefined = current.parent;
  while (parent !== undefined) {
    if (ts.isArrayTypeNode(parent) && parent.elementType === current) {
      path.unshift(0);
    } else if (ts.isTypeReferenceNode(parent) && parent.typeArguments !== undefined) {
      const index = parent.typeArguments.indexOf(current as ts.TypeNode);
      if (index < 0) {
        break;
      }
      path.unshift(index);
    } else {
      break;
    }
    current = parent;
    parent = current.parent;
  }
  return path;
}

/**
 * Split `Name<A, B>` into its top-level type arguments, honoring nested
 * generics and delimiter pairs. Returns undefined when `type` has no trailing
 * generic argument list (i.e. it is not a `Name<...>` form).
 */
export function splitTypeArguments(type: string): string[] | undefined {
  const text = type.trim();
  const open = text.indexOf('<');
  if (open <= 0) {
    return undefined;
  }
  let depth = 0;
  let close = -1;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i] ?? '';
    if (ch === '<') {
      depth += 1;
    } else if (ch === '>') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close !== text.length - 1) {
    return undefined;
  }
  const inner = text.slice(open + 1, close);
  const parts: string[] = [];
  let generic = 0;
  let delimiter = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i] ?? '';
    if (ch === '<') {
      generic += 1;
    } else if (ch === '>') {
      generic -= 1;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      delimiter += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      delimiter -= 1;
    } else if (ch === ',' && generic === 0 && delimiter === 0) {
      parts.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(inner.slice(start).trim());
  return parts;
}

/**
 * Project an inferred whole value type onto the slot an `any` token occupies.
 * `Array<number>` projected by [0] yields `number`; a scalar type projected by
 * a non-empty path (e.g. a function whose `Promise<any>` return was inferred
 * from a bare `return 1`) cannot be projected, so the whole type is returned —
 * that scalar is already aligned with the slot. `never` is returned as-is so
 * the caller can treat it as "no element evidence" (empty array).
 */
export function projectSlotType(fullType: string, path: readonly number[]): string {
  if (path.length === 0) {
    return fullType;
  }
  let current = fullType.trim();
  for (const index of path) {
    if (current.endsWith('[]')) {
      current = current.slice(0, -2).trim();
      continue;
    }
    const args = splitTypeArguments(current);
    if (args === undefined) {
      return fullType;
    }
    const picked = args[index];
    if (picked === undefined) {
      return fullType;
    }
    current = picked;
  }
  return current;
}

export function symbolOf(owner: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  if (
    ts.isVariableDeclaration(owner) ||
    ts.isParameter(owner) ||
    ts.isPropertyDeclaration(owner) ||
    ts.isPropertySignature(owner)
  ) {
    return checker.getSymbolAtLocation(owner.name);
  }
  // A destructured binding (`const { signal } = opts` / `function f({ signal })`)
  // is its own declaration with its own symbol. Its member accesses
  // (`signal.aborted`, `signal.addEventListener(...)`) are real usage evidence
  // that must be collected for the element, not lost on the parent pattern.
  if (ts.isBindingElement(owner)) {
    return checker.getSymbolAtLocation(owner.name);
  }
  return undefined;
}

/** Widen a literal type (`42` -> `number`, `'a'` -> `string`) and print it. */
export function widenedTypeText(checker: ts.TypeChecker, type: ts.Type, node: ts.Node): string {
  if (type.isUnion()) {
    const parts = type.types.map((part) => {
      const text = widenedTypeText(checker, part, node);
      // A bare function type is illegal as a union member without parentheses.
      return hasTopLevelArrow(text) ? `(${text})` : text;
    });
    return [...new Set(parts)].join(' | ');
  }
  if (type.flags & ts.TypeFlags.StringLiteral) {
    return 'string';
  }
  if (type.flags & ts.TypeFlags.NumberLiteral) {
    return 'number';
  }
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    return 'boolean';
  }
  if (type.flags & ts.TypeFlags.BigIntLiteral) {
    return 'bigint';
  }
  return checker.typeToString(type, node, TYPE_FORMAT).trim();
}

export function nonDeclarationFiles(program: ts.Program): ts.SourceFile[] {
  return program.getSourceFiles().filter((sourceFile) => !sourceFile.isDeclarationFile);
}

/** Local equivalent of the assignment-operator check (kept independent of the
 * compiler API export so it works across TS versions). */
export function isAssignmentOperatorKind(kind: ts.SyntaxKind): boolean {
  return (
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment
  );
}

/**
 * `Array.isArray(x)` is a type guard narrowing `x` to an array. Recognize the
 * call by its callee text so it can be a covariant source for the binding.
 */
export function isArrayIsArrayCall(call: ts.CallExpression): boolean {
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.expression.getText(call.getSourceFile()) === 'Array' &&
    call.expression.name.text === 'isArray'
  );
}

/**
 * TypeChecker prints a CommonJS `require('x')` initializer's module namespace
 * type using the *local binding name*, e.g. `var util = require('util')` prints
 * as `typeof util`, `var path = require('path')` as `path.PlatformPath`, and
 * `var fs = require('fs')` as `typeof fs`. Emitting that as an annotation makes
 * the binding reference itself, which TypeScript rejects (TS2502 / TS2503).
 * Detect such self-referential text so the initializer is not used as a type
 * source; the module's real shape is still learned from member accesses.
 */
export function isSelfReferentialType(text: string, bindingName: string): boolean {
  return (
    text === `typeof ${bindingName}` ||
    text.startsWith(`typeof ${bindingName}.`) ||
    text.startsWith(`${bindingName}.`)
  );
}

/**
 * Re-express a CommonJS `require('mod')` call as a self-reference-free module
 * type query (`typeof import("mod")`). TypeChecker prints these initializer
 * types using the local binding name (`typeof util`, `path.PlatformPath`),
 * which is only resolvable because the module type exists — so an equivalent
 * `typeof import("mod")` is equally resolvable but never self-references.
 * Bare-specifier modules only: relative paths are left to other evidence.
 */
export function requireModuleType(node: ts.Node): string | undefined {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'require' &&
    node.arguments.length > 0 &&
    ts.isStringLiteralLike(node.arguments[0]!)
  ) {
    const spec = (node.arguments[0] as ts.StringLiteralLike).text;
    if (spec.length > 0 && !spec.startsWith('.') && !spec.startsWith('/')) {
      return `typeof import(${JSON.stringify(spec)})`;
    }
  }
  return undefined;
}

/**
 * True if `node` sits inside a branch guarded by `Array.isArray(<same>)` —
 * e.g. `if (Array.isArray(xs)) { xs.custom(...) }`. Walking up to the nearest
 * conditional and testing its expression for an isArray call on the same
 * binding identifies methods called on a value *after* it was narrowed to an
 * array. Used to give those custom methods a typed callback signature.
 */
export function isUnderArrayIsArrayGuard(node: ts.Identifier, ctx: InferenceContext): boolean {
  const symbol = ctx.checker.getSymbolAtLocation(node);
  let current: ts.Node | undefined = node;
  while (current !== undefined) {
    const parent: ts.Node | undefined = current.parent;
    if (parent === undefined) {
      break;
    }
    let guard: ts.Expression | undefined;
    if (ts.isIfStatement(parent) && parent.thenStatement === current) {
      guard = parent.expression;
    } else if (ts.isConditionalExpression(parent) && parent.whenTrue === current) {
      guard = parent.condition;
    }
    if (guard !== undefined && containsIsArrayCall(guard, node.text, symbol, ctx)) {
      return true;
    }
    current = parent;
  }
  return false;
}

/** Does `expr` contain `Array.isArray(a)` on the same binding (by symbol or text)? */
export function containsIsArrayCall(
  expr: ts.Expression,
  name: string,
  symbol: ts.Symbol | undefined,
  ctx: InferenceContext,
): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }
    if (ts.isCallExpression(node) && isArrayIsArrayCall(node)) {
      const arg = node.arguments[0];
      if (arg !== undefined && ts.isIdentifier(arg)) {
        const argSymbol = ctx.checker.getSymbolAtLocation(arg);
        if (
          (symbol !== undefined && argSymbol === symbol) ||
          (symbol === undefined && arg.text === name)
        ) {
          found = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(expr);
  return found;
}

/**
 * Map a `typeof` result string to a legal, strict-safe TypeScript type.
 * `typeof x === 'function'` is the notable trap: `function` is a keyword, not
 * a type name, so writing it back produces invalid syntax. Most other results
 * (`string`, `number`, `boolean`, `symbol`, `bigint`, `undefined`, `object`)
 * are already legal type keywords.
 */
export function typeofLiteralToType(literal: string): string {
  if (literal === 'function') {
    return 'Function';
  }
  return literal;
}

/**
 * Add a string index signature to an object shape type so it can be indexed
 * by an arbitrary string key (`o[k]`) without dropping its known properties.
 * Used when a binding has both a concrete shape source (e.g. `{ a: number; }`
 * from a call site) and the dynamic-index constraint — replacing the whole
 * shape with Record would discard real evidence, so keep the shape and make it
 * indexable instead. Returns undefined for non-object shapes or when an index
 * signature is already present.
 */
export function addStringIndexSignature(type: string): string | undefined {
  const text = type.trim();
  if (!text.startsWith('{') || !text.endsWith('}')) {
    return undefined;
  }
  if (/\[[^\]]+:\s*(?:string|number|PropertyKey)\]/.test(text)) {
    return undefined; // already indexable
  }
  const inner = text.slice(1, -1).trim();
  const suffix = inner.length === 0 || inner.endsWith(';') ? '' : ';';
  return `{ ${inner}${suffix} [key: string]: unknown; }`;
}

/** True for an array type string produced by this tool (`unknown[]`, `T[]`, `Array<T>`). */
export function isArrayTypeString(type: string): boolean {
  return type === 'unknown[]' || type.endsWith('[]') || type.startsWith('Array<') || type.startsWith('ReadonlyArray<');
}

/** Extract the element type from an array type string (`number[]`, `Array<number>`). */
export function arrayElementTypeOf(type: string | undefined): string | undefined {
  if (type === undefined) {
    return undefined;
  }
  const text = type.trim();
  if (text.startsWith('Array<') || text.startsWith('ReadonlyArray<')) {
    return splitTypeArguments(text)?.[0];
  }
  if (text.endsWith('[]')) {
    return text.slice(0, -2);
  }
  return undefined;
}

/** Argument indices that require an object for a known built-in call. */
export function objectArgumentIndices(call: ts.CallExpression): readonly number[] | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) {
    return undefined;
  }
  const receiver = callee.expression.getText(callee.getSourceFile());
  if (receiver !== 'Object' && receiver !== 'Reflect') {
    return undefined;
  }
  return OBJECT_ARGUMENT_APIS[`${receiver}.${callee.name.text}`];
}

/**
 * Instance type produced by `x instanceof Ctor`, or undefined if the right
 * operand has no usable class/function symbol (e.g. a complex expression).
 */
export /**
 * For `x instanceof Ctor`, checker's declared type of a generic class leaks
 * uninstantiated type parameters (`Map<K, V>`, `Set<T>`) which produce TS2304
 * when written back. Prefer the construct signature's return type (already
 * instantiated, e.g. `Map<any, any>`), then normalize both `any` slots and any
 * remaining bare single-letter parameters to `unknown` — the element type is
 * genuinely unknown from an instanceof check alone.
 */
function sanitizeInstanceType(text: string): string {
  let result = text;
  result = result.replace(/<([A-Z](?:\s*,\s*[A-Z])*)>/g, (_m, inner: string) => {
    const args = inner.split(',').map((part) => part.trim());
    return args.every((part) => /^[A-Z]$/.test(part))
      ? `<${args.map(() => 'unknown').join(', ')}>`
      : _m;
  });
  // `Map<any, any>` from a construct signature: an `any` slot from instanceof
  // carries no real information, so use `unknown` to keep strict soundness.
  result = result.replace(/\bany\b/g, 'unknown');
  return result;
}

/**
 * Split a type string on top-level `|`, honoring nested generics, parentheses,
 * braces and brackets so unions inside type arguments are left intact.
 */
export function splitTopLevelUnion(type: string): string[] {
  const parts: string[] = [];
  let generic = 0;
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  let start = 0;
  for (let i = 0; i < type.length; i += 1) {
    const ch = type[i] ?? '';
    if (ch === '<') {
      generic += 1;
    } else if (ch === '>') {
      generic -= 1;
    } else if (ch === '(') {
      paren += 1;
    } else if (ch === ')') {
      paren -= 1;
    } else if (ch === '{') {
      brace += 1;
    } else if (ch === '}') {
      brace -= 1;
    } else if (ch === '[') {
      bracket += 1;
    } else if (ch === ']') {
      bracket -= 1;
    } else if (ch === '|' && generic === 0 && paren === 0 && brace === 0 && bracket === 0) {
      parts.push(type.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(type.slice(start).trim());
  return parts.filter((part) => part.length > 0);
}

/**
 * Combine a projected whole-value type with element/value types written through
 * a mutable container into one union for the `any` slot. Flattens nested unions,
 * de-duplicates and sorts for deterministic output. Returns undefined only when
 * there is no evidence at all.
 */
export function mergeMutationEvidence(
  projected: string | undefined,
  mutations: readonly string[],
): string | undefined {
  // `any`/`unknown` carry no information and, worse, `any | T` collapses to
  // `any` in TypeScript. Drop them so concrete mutations can win.
  const informative = (value: string | undefined): boolean =>
    value !== undefined && value !== 'any' && value !== 'unknown';
  const all = [...(informative(projected) ? [projected as string] : []), ...mutations];
  if (all.length === 0) {
    return undefined;
  }
  const members = [...new Set(all.flatMap(splitTopLevelUnion))].sort();
  if (members.length === 1) {
    return members[0];
  }
  const formatted = members.map((member) => (hasTopLevelArrow(member) ? `(${member})` : member));
  return formatted.join(' | ');
}
