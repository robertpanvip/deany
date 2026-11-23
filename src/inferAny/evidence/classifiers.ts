// Type-classifier parameter detection (functions whose argument selects a variant).
import * as ts from 'typescript';

import type { InferenceContext } from '../types.js';
import { typePredicateOfArgument } from '../typeText.js';
import { isArrayIsArrayCall, isFunctionLike, symbolOf } from '../util.js';

/**
 * A literal-like operand used purely to probe a value's type
 * (`x === null`, `x === void 0`, `x === 'a'`, ...). Strict TS rejects a
 * comparison between non-overlapping types, so a literal comparison is a
 * type probe, never a value use.
 */
export function isTypeComparisonLiteral(expr: ts.Expression): boolean {
  if (
    ts.isStringLiteral(expr) ||
    ts.isNumericLiteral(expr) ||
    ts.isNoSubstitutionTemplateLiteral(expr) ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    expr.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isIdentifier(expr) && expr.text === 'undefined') return true;
  if (expr.kind === ts.SyntaxKind.VoidExpression) return true;
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken) {
    return ts.isNumericLiteral(expr.operand);
  }
  return false;
}

/**
 * Classify how one reference of a parameter is used inside its own function.
 * A *detection category* means the reference only probes the value's type;
 * `undefined` means the value is genuinely consumed (returned as data, read as
 * a business property, used in arithmetic, assigned, ...).
 */
export function parameterProbeCategory(ref: ts.Identifier, ctx: InferenceContext): string | undefined {
  let parent: ts.Node | undefined = ref.parent;

  // A reference that reads a property/business field off the parameter
  // (`x.size`, `val.message`, `val.constructor.name`) is a genuine value use,
  // not a type probe — even if the whole expression is later compared to a
  // literal (`x.size === 0`) or typeof'd. Only a *bare* parameter reference is
  // eligible to be a probe.
  if (parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.expression === ref) {
    return undefined;
  }
  // Climb parentheses around the bare parameter reference.
  while (parent !== undefined && ts.isParenthesizedExpression(parent)) {
    parent = parent.parent;
  }
  if (parent === undefined) return undefined;

  if (ts.isTypeOfExpression(parent) && parent.expression === ref) return 'typeof';

  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    if (op === ts.SyntaxKind.InKeyword && parent.right === ref) return 'in';
    if (op === ts.SyntaxKind.InstanceOfKeyword && parent.left === ref) return 'instanceof';
    if (
      (op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken) &&
      (parent.left === ref || parent.right === ref)
    ) {
      const other = parent.left === ref ? parent.right : parent.left;
      if (isTypeComparisonLiteral(other)) return 'equality';
    }
  }

  if (ts.isCallExpression(parent)) {
    const index = parent.arguments.indexOf(ref);
    if (index >= 0) {
      if (isArrayIsArrayCall(parent)) return 'isArray';
      if (typePredicateOfArgument(parent, ref, ctx) !== undefined) return 'predicate';
      // Forwarded to another function: the callee infers its own parameter,
      // forwarding alone does not consume this value.
      return 'call';
    }
  }
  return undefined;
}

/**
 * True when `node` is a reference (identifier / property access / parenthesized
 * expression resolving to an identifier) to a parameter that the classifier
 * rule pins to `unknown`. Such an `unknown` is the honest "any value" answer
 * for a type-classifier, NOT a concrete type observation; letting it flow into
 * another function's call-site evidence would wrongly erode that function's
 * parameter (e.g. `has(key){ key._reactInternals ... }` becoming `key: unknown`
 * and raising TS18046). Skip it as call-site evidence instead.
 */
export function isClassifierParamReference(node: ts.Expression, ctx: InferenceContext): boolean {
  let target: ts.Node = node;
  while (
    ts.isParenthesizedExpression(target) ||
    ts.isAsExpression(target) ||
    ts.isNonNullExpression(target)
  ) {
    target = target.expression;
  }
  if (!ts.isIdentifier(target)) return false;
  const symbol = ctx.checker.getSymbolAtLocation(target);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (declaration === undefined || !ts.isParameter(declaration)) return false;
  return isTypeClassifierParameter(declaration, ctx);
}

/**
 * A "type classifier" parameter is one its function only *probes*, never uses
 * as a concrete value — it reports what type the argument is (`miniKindOf`
 * returns `'array'`/`'date'`/...) rather than operating on it. Every value is
 * legitimate, so the honest type is `unknown`; narrowing it from its own
 * probes (`unknown[]` from `Array.isArray`, `Date`/`Error` from predicates) or
 * from call-site arguments yields a misleading union.
 *
 * Deliberately conservative: the parameter needs at least TWO distinct probe
 * categories and ZERO value uses. A lone typeof guard (`format(x)`) still
 * narrows as before, and a branch that reads `x.length` is a value use that
 * keeps its inferred type — so existing inference is untouched.
 */
export function isTypeClassifierParameter(owner: ts.Node, ctx: InferenceContext): boolean {
  if (!ts.isParameter(owner)) return false;
  const fn = owner.parent;
  if (fn === undefined || !isFunctionLike(fn) || fn.body === undefined) return false;
  const symbol = symbolOf(owner, ctx.checker);
  if (symbol === undefined) return false;

  const categories = new Set<string>();
  let valueUse = false;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && ctx.checker.getSymbolAtLocation(node) === symbol) {
      const category = parameterProbeCategory(node, ctx);
      if (category === undefined) {
        valueUse = true;
      } else {
        categories.add(category);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return !valueUse && categories.size >= 2;
}
