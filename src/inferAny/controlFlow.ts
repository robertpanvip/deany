import * as ts from 'typescript';

import type { InferenceContext } from './types.js';
import { widenedTypeText } from './util.js';

/**
 * Types the checker reports at a use site that carry no new information and
 * must not be recorded as evidence (they would pollute a concrete source or a
 * property-shape estimate). `any[]`/`Map<any, any>` are excluded because the
 * element/slot evidence is collected separately and is more precise.
 */
export function isOpaqueNarrowingType(text: string): boolean {
  if (text.length === 0) {
    return true;
  }
  if (/\b(any|unknown|never|void)\b/.test(text)) {
    return true;
  }
  return text === '{}' || text === 'object' || text === 'PropertyKey';
}

/**
 * True when `reference` sits in a branch the checker type-narrows by a guard.
 * We only trust a checker-reported narrowed type inside such a region — at an
 * ordinary use site the checker's type is the declaration's own `any`, which
 * is information-free. Recognized guards: the true arm of `if (cond)`, the
 * true arm of `cond ? a : b`, and the right operand of `cond && expr`. The
 * guard itself must be a narrowing form (typeof / instanceof / Array.isArray /
 * a custom type predicate / truthiness of the same binding) — but we rely on
 * the checker to decide, so the broad structural test suffices here.
 */
export function isInsideNarrowingTrueBranch(reference: ts.Identifier): boolean {
  let current: ts.Node = reference;
  let parent: ts.Node | undefined = current.parent;
  while (parent !== undefined) {
    if (ts.isIfStatement(parent) && parent.thenStatement === current) {
      return true;
    }
    if (ts.isConditionalExpression(parent) && parent.whenTrue === current) {
      return true;
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      parent.right === current
    ) {
      return true;
    }
    // `switch (typeof x) { case 'string': ... }`: the checker narrows x inside
    // each case clause. Accept any case-clause body (the checker only reports a
    // concrete type there when a guard actually narrowed the discriminant).
    if (ts.isCaseClause(parent) && current.parent === parent) {
      return true;
    }
    if (ts.isDefaultClause(parent) && current.parent === parent) {
      return true;
    }
    current = parent;
    parent = current.parent;
  }
  return false;
}

/**
 * Control-flow narrowing via the checker: at a use site inside a guard's true
 * branch the checker has already computed the narrowed type (e.g. `string` at
 * `x.length` under `if (typeof x === 'string')`), even with `checkJs: false`.
 * Reading it here covers guard forms the syntactic typeof/instanceof/isArray
 * rules miss: truthiness checks, `switch`, negated guards and predicate guard
 * bodies. Returns undefined for opaque or non-narrowing sites so concrete
 * call-site / iteration / builtin evidence still wins.
 */
export function controlFlowNarrowedType(
  reference: ts.Identifier,
  ctx: InferenceContext,
): string | undefined {
  if (!isInsideNarrowingTrueBranch(reference)) {
    return undefined;
  }
  const type = ctx.checker.getTypeAtLocation(reference);
  const text = widenedTypeText(ctx.checker, ctx.checker.getWidenedType(type), reference);
  return isOpaqueNarrowingType(text) ? undefined : text;
}
