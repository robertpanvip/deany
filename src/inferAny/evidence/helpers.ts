// Shared helpers for evidence collection: control-flow fall-through,
// expression unwrapping, type-probe detection and owner name hints.
import * as ts from 'typescript';

import { collectEvidence } from './collect.js';
import { nameSuggestsNumber } from '../constants.js';
import { mergeEvidence } from '../shape.js';
import type { InferenceContext } from '../types.js';
import { functionLikeName, isFunctionLike, widenedTypeText } from '../util.js';

/**
 * Whether control can reach the end of a statement list (i.e. fall through to
 * an implicit `undefined` return). Used so a function with a value return on
 * only *some* paths is typed `T | undefined`, not just `T` — otherwise strict
 * mode rejects it with TS2366 ("Function lacks ending return statement").
 * Conservative: anything we cannot prove always-terminating counts as a
 * possible fall-through, which only ever widens the type (safe).
 */
/**
 * For a call-argument spread `f(...x)` (or constructor spread `new C(...x)`),
 * resolve the callee's signature through the checker and return the constraint
 * the spread argument `x` must satisfy:
 *
 *  - rest signature (`...xs: number[]`) -> `number[]` (element type);
 *  - fixed-argument signature (`(a: number, b: string)`) -> a tuple
 *    `[number, string]`, because TypeScript only accepts a spread into fixed
 *    parameters when the argument is a tuple (TS2556 for a plain array);
 *  - optional parameters keep their `?` tuple marker;
 *  - zero resolvable information -> undefined, so the caller falls back to
 *    `unknown[]` (still an array, so the spread stays legal).
 *
 * Using the resolved signature — rather than the callee's source text — is
 * essential: a locally shadowed `Math.max` must not inherit the global one's
 * `number[]` contract (Architecture review 5). Sharing this logic between
 * calls and `new` expressions fixes the constructor-spread gap (review R5-1).
 */
export function spreadCallConstraint(
  call: ts.CallExpression | ts.NewExpression,
  ctx: InferenceContext,
): string | undefined {
  const signature = ctx.checker.getResolvedSignature(call);
  if (signature === undefined) {
    return undefined;
  }

  // 1) Rest signature: the array's element type is the definite constraint.
  for (const parameter of signature.parameters) {
    const declaration = parameter.declarations?.[0];
    if (declaration === undefined || !ts.isParameter(declaration) || declaration.dotDotDotToken === undefined) {
      continue;
    }
    let restType = ctx.checker.getTypeOfSymbolAtLocation(parameter, call);
    // A rest parameter typed by a generic (`...xs: T extends [number, string]`)
    // resolves to `any` at the call site — no constraint is visible there.
    // Recover the concrete shape from the declaration's type-parameter base
    // constraint so a tuple-constrained generic still yields the tuple, rather
    // than an `unknown[]` that TS rejects as a tuple spread (TS2556). (Review P1.)
    if ((restType.flags & ts.TypeFlags.Any) !== 0) {
      const declaredType = ctx.checker.getTypeAtLocation(declaration);
      if ((declaredType.flags & ts.TypeFlags.TypeParameter) !== 0) {
        const base = ctx.checker.getBaseConstraintOfType(declaredType);
        if (base !== undefined) {
          restType = base;
        }
      }
    }
    // Arrays and tuples are both TypeReference in the checker's model, but a
    // tuple rest parameter (`...args: [number, string]`) must NOT be collapsed
    // to an element array: the spread argument has to be exactly that tuple,
    // or TS rejects it (TS2556). Preserve the full tuple structure — including
    // optional (`?`) and variadic (`...T[]`) elements. Only a genuine array
    // rest parameter contributes an element type plus `[]`. (Review P1 tuple.)
    if ((restType.flags & ts.TypeFlags.Object) !== 0 && ctx.checker.isTupleType(restType)) {
      const tupleText = widenedTypeText(ctx.checker, restType, call);
      if (tupleText !== undefined && tupleText !== 'never' && tupleText !== 'any') {
        return tupleText;
      }
    } else if ((restType.flags & ts.TypeFlags.Object) !== 0 && ctx.checker.isArrayType(restType)) {
      const elementType = ctx.checker.getTypeArguments(restType as ts.TypeReference)[0];
      if (elementType !== undefined) {
        const text = widenedTypeText(ctx.checker, elementType, call);
        if (text !== undefined && text !== 'never' && text !== 'any') {
          return `${text}[]`;
        }
      }
    }
    // A rest parameter that is `any`/unresolved: constrain to an array so the
    // spread itself stays legal, without asserting an element type.
    return 'unknown[]';
  }

  // 2) Fixed-argument signature: TS requires a tuple for an argument spread.
  //    Build one from the resolved parameter types, preserving optionality.
  if (signature.parameters.length === 0) {
    return undefined; // zero-arg callee: any array spreads legally
  }
  const elements: string[] = [];
  for (const parameter of signature.parameters) {
    const parameterType = ctx.checker.getTypeOfSymbolAtLocation(parameter, call);
    let text = widenedTypeText(ctx.checker, parameterType, call);
    const declaration = parameter.declarations?.[0];
    const optional =
      declaration !== undefined &&
      ts.isParameter(declaration) &&
      (declaration.questionToken !== undefined || declaration.initializer !== undefined);
    if (text === undefined || text === 'never' || text === 'any') {
      text = 'unknown';
    }
    // A widened optional parameter reads `T | undefined`; a tuple's `?`
    // marker already carries that, so strip it to keep `T?` well-formed.
    if (optional) {
      text = text
        .replace(/\s*\|\s*undefined\b/g, '')
        .replace(/\bundefined\s*\|\s*/g, '');
      if (text === '' || text === 'undefined') {
        text = 'unknown';
      }
      elements.push(`${text}?`);
    } else {
      elements.push(text);
    }
  }
  return `[${elements.join(', ')}]`;
}

/**
 * Widened type of a literal operand in a strict-equality comparison, or
 * undefined when the operand is not a literal (e.g. another binding). Only
 * self-describing literal syntax counts — this is a compatibility hint for
 * avoiding TS2367, never a standalone type source. `true`/`false` -> boolean,
 * string/number/bigint/numeric-negative literals -> their primitive, `null` ->
 * null. Template expressions and identifiers are excluded deliberately.
 * (TS strict-regression fix.)
 */
export function strictEqualityLiteralType(node: ts.Expression): string | undefined {
  if (
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return 'boolean';
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return 'string';
  }
  if (ts.isNumericLiteral(node)) {
    return 'number';
  }
  if (ts.isBigIntLiteral(node)) {
    return 'bigint';
  }
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return 'number';
  }
  if (node.kind === ts.SyntaxKind.NullKeyword) {
    return 'null';
  }
  return undefined;
}

/**
 * The "use node" for a reference: walk outward through transparent expression
 * wrappers — non-null (`v!`), parentheses (`(v)`), `as`/angle-bracket
 * assertions and `satisfies` — so that structural evidence collected at a use
 * site also applies when the binding is wrapped. Returns the outermost wrapper,
 * or the identifier itself when there is none. `checker`-based queries (flow
 * narrowing, isArray guards) still use the original identifier, since those
 * wrappers do not change the control-flow position. (Review round 16.)
 */
export function transparentUseNode(reference: ts.Identifier): ts.Expression {
  let current: ts.Expression = reference;
  for (;;) {
    const parent: ts.Node | undefined = current.parent;
    if (
      parent !== undefined &&
      ((ts.isNonNullExpression(parent) && parent.expression === current) ||
        (ts.isParenthesizedExpression(parent) && parent.expression === current) ||
        (ts.isAsExpression(parent) && parent.expression === current) ||
        (ts.isTypeAssertionExpression(parent) && parent.expression === current) ||
        (ts.isSatisfiesExpression(parent) && parent.expression === current))
    ) {
      current = parent;
      continue;
    }
    return current;
  }
}

/** Extract constraints from one reference to the `any`-typed binding. */
/**
 * True when a property access is guarded by a type probe *before* it is used —
 * `typeof o.p === '...'` or `o.p != null`. The very presence of the probe means
 * the code tolerates p being absent, so a synthesized shape should render p
 * optional (`p?:`) instead of forcing every caller to supply it. (v0.1.38.)
 */
export function isTypeProbedPropertyAccess(expr: ts.PropertyAccessExpression): boolean {
  const parent: ts.Node | undefined = expr.parent;
  if (parent === undefined) return false;
  // typeof o.p === 'literal' / !== 'literal' (covers 'undefined', 'function', ...)
  if (ts.isTypeOfExpression(parent) && parent.expression === expr) {
    const comparison = parent.parent;
    if (
      comparison !== undefined &&
      ts.isBinaryExpression(comparison) &&
      (comparison.left === parent || comparison.right === parent)
    ) {
      const other = comparison.left === parent ? comparison.right : comparison.left;
      if (ts.isStringLiteral(other) || ts.isNoSubstitutionTemplateLiteral(other)) {
        return true;
      }
    }
  }
  // o.p != null / == null / === undefined / !== undefined
  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    if (
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken
    ) {
      const other = parent.left === expr ? parent.right : parent.left;
      if (
        other.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isIdentifier(other) && other.text === 'undefined')
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Hard cap on recursive `collectEvidence` descent (binding elements and opaque
 * callback parameters each collect their children directly). Real code nests
 * only a few levels; the cap prevents a pathological/cyclic input from
 * recursing until stack overflow. Returning `undefined` past the cap is the
 * conservative choice: it asks the caller to fall back to `unknown`.
 */
const MAX_COLLECT_DEPTH = 32;

/**
 * Collect the inferred *type string* for a node, memoised per fixed-point
 * round. Recursive sites (binding elements, callback parameters) used to call
 * `mergeEvidence(collectEvidence(node, ctx)).type` directly, recomputing the
 * same subtree many times within one round. The memo is keyed by node and
 * tagged with `ctx.round`; `buildInferenceTable` advances that round each pass
 * so stale results can never leak across iterations.
 */
export function collectedType(node: ts.Node, ctx: InferenceContext, depth: number): string | undefined {
  if (depth > MAX_COLLECT_DEPTH) {
    return undefined;
  }
  const cached = ctx.evidenceMemo.get(node);
  if (cached !== undefined && cached.round === ctx.round) {
    return cached.type;
  }
  const type = mergeEvidence(collectEvidence(node, ctx, depth)).type;
  ctx.evidenceMemo.set(node, { round: ctx.round, type });
  return type;
}

/** Collect type evidence for the declaration that owns an `any` annotation. */
/** The enclosing function's name, for owner-level name hints. */
export function ownerFunctionName(owner: ts.Node): string | undefined {
  if (isFunctionLike(owner)) {
    return functionLikeName(owner);
  }
  if (ts.isParameter(owner)) {
    return functionLikeName(owner.parent);
  }
  return undefined;
}

/**
 * Weak name-based numeric hint. Only a FUNCTION's PARAMETERS get this hint: a
 * parameter of `add(a, b)` / `count(xs)` inherits it from the enclosing
 * function. The function's own RETURN no longer takes a number from its name —
 * round 15 splits name hints by role (boolean/array/string name -> return,
 * numeric name -> parameters only). Variable names are intentionally NOT used:
 * an initializer, when present, is real evidence and a bare name is too weak.
 * Returns false unless a clear numeric-accumulator verb is found. (Rounds 12/15.)
 */
export function ownerHasNumericNameHint(owner: ts.Node): boolean {
  const fnName = ownerFunctionName(owner);
  return fnName !== undefined && ts.isParameter(owner) && nameSuggestsNumber(fnName);
}
