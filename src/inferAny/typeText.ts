import * as ts from 'typescript';

import type { InferenceContext } from './types.js';
import { ARRAY_SCALAR_RETURN, BUILTIN_METHOD_RETURN, INDEXABLE_OBJECT, STRING_ARRAY_SHARED_METHODS, TYPE_FORMAT, UNIQUE_BUILTIN_METHODS, VAGUE_RETURN_TYPES } from './constants.js';
import { isArrayTypeString, sanitizeInstanceType, splitTypeArguments, widenedTypeText } from './util.js';

/** Table lookup for a node whose checker type is `any`. This is the positive
 * propagation edge: a call resolves to a callee's inferred return type, and an
 * identifier resolves to a binding's inferred type. */
export function resolveViaTable(ctx: InferenceContext, node: ts.Node): string | undefined {
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    const declaration = ctx.checker.getResolvedSignature(node)?.declaration;
    if (declaration !== undefined) {
      return ctx.table.returns.get(declaration);
    }
    return undefined;
  }
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
    let symbol = ctx.checker.getSymbolAtLocation(node);
    if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      const aliased = ctx.checker.getAliasedSymbol(symbol);
      if (aliased !== undefined) {
        symbol = aliased;
      }
    }
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (declaration !== undefined) {
      return ctx.table.declarations.get(declaration);
    }
  }
  return undefined;
}

/**
 * Recover the return type of a built-in method call whose checker type went
 * opaque because the receiver was reassigned in a JS file (checkJs then types
 * the reassigned binding as `any` at later call sites, losing the signature).
 * This is NOT a method-name guess: it fires only when the receiver's own
 * inferred type is already a concrete builtin primitive (string/number/Date)
 * via the inference table, and the method is unique to that family in lib.d.ts
 * with a known return type. Under those conditions the lib signature is
 * deterministic evidence, e.g. an inferred-`string` receiver calling `split`
 * yields `string[]`.
 */
export function builtinCallResultFromReceiver(ctx: InferenceContext, node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
    return undefined;
  }
  const receiver = node.expression.expression;
  const method = node.expression.name.text;
  const builtinReturn = BUILTIN_METHOD_RETURN.get(method);
  const arrayReturn = ARRAY_SCALAR_RETURN.get(method);
  // The receiver must already be inferred as a concrete type — never guess
  // from the method name alone. resolveViaTable reads the table entry for an
  // identifier/property-access receiver.
  const receiverType = resolveViaTable(ctx, receiver);
  if (receiverType === undefined) {
    return undefined;
  }
  const normalized = receiverType.trim();
  // Container accessors whose result depends on the receiver's own inferred
  // type arguments. e.g. `new Map()` recovered as `Map<string, number>` makes
  // `m.get(k)` return `number | undefined` even though checkJs types an
  // unannotated `new Map()` as `Map<any, any>`. This is receiver-driven, not a
  // method-name guess: the receiver type must already be concrete.
  const typeArgs = splitTypeArguments(normalized);
  if (typeArgs !== undefined && /^(Readonly)?Map$/.test(normalized.slice(0, normalized.indexOf('<')))) {
    if (method === 'get') {
      return `${typeArgs[1] ?? 'unknown'} | undefined`;
    }
    if (method === 'has' || method === 'delete' || method === 'clear') {
      return method === 'clear' ? 'void' : 'boolean';
    }
  }
  if (typeArgs !== undefined && /^(Readonly)?Set$/.test(normalized.slice(0, normalized.indexOf('<')))) {
    if (method === 'has' || method === 'delete' || method === 'clear') {
      return method === 'clear' ? 'void' : 'boolean';
    }
  }
  if (builtinReturn === undefined && arrayReturn === undefined) {
    return undefined;
  }
  const matchesFamily = UNIQUE_BUILTIN_METHODS.some(
    (family) => normalized === family.type && family.methods.has(method),
  );
  if (matchesFamily && builtinReturn !== undefined) {
    return builtinReturn;
  }
  // Array methods whose return type is independent of the element type. When
  // the checker types the call as `any` (opaque receiver) but the binding's
  // inferred type is a concrete array, `join()`/`toString()` still return a
  // definite `string`. The receiver must be independently confirmed as an
  // array — never guess from the method name alone.
  if (arrayReturn !== undefined && isArrayTypeString(normalized)) {
    return arrayReturn;
  }
  return undefined;
}

/**
 * `Object(value)` boxes its argument into an object (primitives become their
 * wrapper objects); lib.d.ts types the return as `any`, which carries no
 * information. Recognize only the genuine global constructor — the symbol's
 * declarations must all live in a declaration file — so a user shadowing
 * `Object` is never mistaken for it.
 */
export function objectConstructorResult(ctx: InferenceContext, node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) {
    return undefined;
  }
  if (node.expression.text !== 'Object') {
    return undefined;
  }
  const declarations = ctx.checker.getSymbolAtLocation(node.expression)?.declarations;
  if (declarations === undefined || declarations.length === 0) {
    return undefined;
  }
  if (!declarations.every((d) => d.getSourceFile().isDeclarationFile)) {
    return undefined;
  }
  return INDEXABLE_OBJECT;
}

/**
 * `a || fallback` / `a ?? fallback`: the right operand is a value the
 * expression genuinely produces when the left is falsy. When the checker types
 * the whole logical expression as `any`/`unknown` — typically because the left
 * side references an API lib.d.ts does not declare (e.g. the non-standard
 * `Symbol.observable`, which TS2339-poison to `any`) — that fallback is the only
 * concrete evidence available. Use its type instead of degrading to bare
 * `unknown`. This is observed evidence, never a fabricated type: it only fires
 * when the checker gave up AND the fallback has a concrete type of its own.
 * (A normal `T | null || fallback` never reaches here because the checker
 * already produced a concrete union type.)
 */
function logicalFallbackType(ctx: InferenceContext, node: ts.Node): string | undefined {
  if (!ts.isBinaryExpression(node)) return undefined;
  const op = node.operatorToken.kind;
  if (op !== ts.SyntaxKind.BarBarToken && op !== ts.SyntaxKind.QuestionQuestionToken) return undefined;
  const leftType = ctx.checker.getTypeAtLocation(node.left);
  if ((leftType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0) return undefined;
  const fallback = typeText(ctx, node.right);
  if (fallback === undefined || fallback === 'any' || fallback === 'unknown' || fallback === 'never') {
    return undefined;
  }
  return fallback;
}

export function typeText(
  ctx: InferenceContext,
  node: ts.Node,
  type?: ts.Type,
): string | undefined {
  const raw = type ?? ctx.checker.getTypeAtLocation(node);
  const widened = ctx.checker.getWidenedType(raw);
  if (widened.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) {
    return (
      objectConstructorResult(ctx, node) ??
      resolveViaTable(ctx, node) ??
      logicalFallbackType(ctx, node) ??
      builtinCallResultFromReceiver(ctx, node)
    );
  }
  const text = widenedTypeText(ctx.checker, widened, node);
  if (text.length === 0 || text === 'any' || text === 'unknown') {
    return resolveViaTable(ctx, node) ?? builtinCallResultFromReceiver(ctx, node);
  }
  // A class EXPRESSION is printed by the checker as `typeof (Anonymous class)`
  // or `typeof Named`, neither of which is a legal type annotation at the use
  // site: an anonymous class has no type-space name (TS1003), and a named
  // class expression's name is visible only inside its own body (TS2552).
  // E.g. `function f(B){ return class extends B {}; }` would emit
  // `: typeof (Anonymous class)`. Treat a class expression's own textual type
  // as unusable and fall back to the conservative `unknown` default — a class
  // value is always assignable to `unknown`. (A class DECLARATION or an
  // identifier bound to one still prints a legal `typeof Foo` and is kept;
  // only the expression node itself is filtered here.) (Review round 16.)
  if (ts.isClassExpression(node) && text.startsWith('typeof ')) {
    return resolveViaTable(ctx, node) ?? builtinCallResultFromReceiver(ctx, node);
  }
  return text;
}

/** Recognize arithmetic expressions that imply a numeric operand type in JS. */
export function arithmeticNumberType(
  ctx: InferenceContext,
  expression: ts.Expression,
): string | undefined {
  if (!ts.isBinaryExpression(expression)) {
    return undefined;
  }
  const operator = expression.operatorToken.kind;
  const arithmetic =
    operator === ts.SyntaxKind.PlusToken ||
    operator === ts.SyntaxKind.MinusToken ||
    operator === ts.SyntaxKind.AsteriskToken ||
    operator === ts.SyntaxKind.AsteriskAsteriskToken ||
    operator === ts.SyntaxKind.SlashToken ||
    operator === ts.SyntaxKind.PercentToken;
  if (!arithmetic) {
    return undefined;
  }
  if (
    typeText(ctx, expression.left) === 'number' ||
    typeText(ctx, expression.right) === 'number'
  ) {
    return 'number';
  }
  return undefined;
}

export function symbolTypeText(
  ctx: InferenceContext,
  symbol: ts.Symbol,
  location: ts.Node,
): string | undefined {
  return typeText(ctx, location, ctx.checker.getTypeOfSymbolAtLocation(symbol, location));
}

/**
 * If every observed property is a call to methods unique to one builtin
 * family — AND every observed return context agrees with that method's real
 * lib return type — return the family as a weak last-resort type. Requires at
 * least one method and ALL keys to belong to the same family, so a custom
 * object with a coincidental `toUpperCase` plus `foo` is not narrowed.
 */
export function uniqueBuiltinReceiverType(
  properties: ReadonlyMap<string, string>,
  methodReturnTypes: ReadonlyMap<string, readonly string[]>,
  methodArgumentTypes?: ReadonlyMap<string, readonly string[]>,
): string | undefined {
  if (properties.size === 0) {
    return undefined;
  }
  const keys = [...properties.keys()];
  const METHOD_TYPE = '(...args: unknown[]) => unknown';
  if (!keys.every((key) => properties.get(key) === METHOD_TYPE)) {
    return undefined;
  }
  // A shared string/array method called with a concrete non-string argument
  // disproves the string family: `v.includes(3)` cannot be string.includes
  // (which requires a string), so v is more likely an array. Reject narrowing
  // to `string` in that case; the property shape (`{ includes: fn }`) remains
  // as honest evidence. (Review round 17.)
  const rejectsStringFamily =
    methodArgumentTypes !== undefined &&
    keys.some((key) =>
      STRING_ARRAY_SHARED_METHODS.has(key) &&
      (methodArgumentTypes.get(key) ?? []).some((arg) => arg !== 'string'),
    );
  for (const family of UNIQUE_BUILTIN_METHODS) {
    if (!keys.every((key) => family.methods.has(key))) {
      continue;
    }
    if (rejectsStringFamily && family.type === 'string') {
      continue;
    }
    // Signature check: every contextual return type observed at a call site
    // must match the builtin method's real return type. A mismatch means the
    // method is not the builtin one — e.g. `toUpperCase()` used as a number.
    const signatureAgrees = keys.every((key) => {
      const builtinReturn = BUILTIN_METHOD_RETURN.get(key);
      if (builtinReturn === undefined) {
        return false;
      }
      const observed = methodReturnTypes.get(key) ?? [];
      return observed.every((text) =>
        VAGUE_RETURN_TYPES.has(text) || text === builtinReturn,
      );
    });
    if (signatureAgrees) {
      return family.type;
    }
  }
  return undefined;
}

/**
 * If an operand of a relational comparison has a concrete orderable primitive
 * type, both operands must share a comparable type. `let n = 0; n < x` proves
 * `x` is numeric (TS requires both sides comparable), so narrowing `x` to
 * `number` is sound. Returns undefined for `any`/`unknown`/unions so the caller
 * keeps the conservative `number | string` estimate.
 */
export function orderableOperandType(ctx: InferenceContext, node: ts.Expression): string | undefined {
  const type = typeText(ctx, node);
  if (type === 'number' || type === 'string' || type === 'bigint') {
    return type;
  }
  return undefined;
}

export function instanceTypeOf(
  ctx: InferenceContext,
  right: ts.Expression,
): string | undefined {
  let symbol = ctx.checker.getSymbolAtLocation(right);
  if (symbol === undefined) {
    return undefined;
  }
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    const resolved = ctx.checker.getAliasedSymbol(symbol);
    if (resolved !== undefined) {
      symbol = resolved;
    }
  }
  // Prefer the instantiated instance type from the construct signature.
  const rightType = ctx.checker.getTypeAtLocation(right);
  const constructReturn = rightType.getConstructSignatures()[0]?.getReturnType();
  const instance = constructReturn ?? (symbol === undefined ? undefined : ctx.checker.getDeclaredTypeOfSymbol(symbol));
  if (instance === undefined) {
    return undefined;
  }
  const text = sanitizeInstanceType(ctx.checker.typeToString(instance, right, TYPE_FORMAT).trim());
  return text.length === 0 || text === 'any' || text === 'unknown' ? undefined : text;
}

/**
 * For a custom type-guard call like `isFoo(x)` declared as
 * `function isFoo(v: unknown): v is Foo`, return the type `Foo` that the guard
 * narrows its argument to. `getResolvedSignature` erases the predicate, so read
 * it from the callee declaration's `TypePredicateNode`. Only the predicate's
 * own parameter (matched by symbol, then by name) is narrowed.
 */
export function typePredicateOfArgument(
  call: ts.CallExpression,
  argument: ts.Expression,
  ctx: InferenceContext,
): string | undefined {
  const declaration = ctx.checker.getResolvedSignature(call)?.declaration;
  if (declaration === undefined || declaration.type === undefined) {
    return undefined;
  }
  const signatureDeclaration = declaration as ts.SignatureDeclaration;
  if (signatureDeclaration.type === undefined || !ts.isTypePredicateNode(signatureDeclaration.type)) {
    return undefined;
  }
  const predicate = signatureDeclaration.type;
  if (predicate.type === undefined) {
    return undefined;
  }
  // Resolve which parameter the predicate names (`v is Foo` names `v`).
  // `this is T` predicates have no named parameter and are not argument guards.
  let predicateIndex = -1;
  const parameterName =
    typeof predicate.parameterName === 'string'
      ? predicate.parameterName
      : ts.isIdentifier(predicate.parameterName)
        ? predicate.parameterName.text
        : undefined;
  if (parameterName === undefined) {
    return undefined;
  }
  for (let i = 0; i < signatureDeclaration.parameters.length; i += 1) {
    const p = signatureDeclaration.parameters[i];
    if (p !== undefined && ts.isIdentifier(p.name) && p.name.text === parameterName) {
      predicateIndex = i;
      break;
    }
  }
  if (predicateIndex < 0 || call.arguments[predicateIndex] !== argument) {
    return undefined;
  }
  const type = ctx.checker.getTypeAtLocation(predicate.type);
  const text = sanitizeInstanceType(
    ctx.checker.typeToString(type, predicate.type, TYPE_FORMAT).trim(),
  );
  return text.length === 0 || text === 'any' || text === 'unknown' ? undefined : text;
}
