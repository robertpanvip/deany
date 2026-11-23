// Alias-derived shape evidence: bare aliases, property-path aliases and
// closure-return aliases (v0.1.43-v0.1.47).
import * as ts from 'typescript';

import { referencesOf } from '../collect.js';
import { VAGUE_RETURN_TYPES } from '../constants.js';
import { insertShapeChain, isPlainObjectShapeText, renderShapeNode } from '../shape.js';
import type { InferenceContext, ShapeNode } from '../types.js';
import { typeText } from '../typeText.js';
import { isAssignmentOperatorKind, isFunctionLike } from '../util.js';

/**
 * Object shapes written *through* a pure alias binding. When `let a = b` and
 * `a` is never reassigned, every `a.<chain> = value` write is really a write to
 * `b` — the two names denote the same object. These writes may be sitting in
 * `a`'s `shapeChain`, which `mergeEvidence` ignores whenever `a` already has a
 * covariant `source` (e.g. its initializer `b`), so they would never reach `b`
 * via `typeText(a)` alone. Rendering them into plain object shapes lets the
 * alias-source merge in `mergeEvidence` combine them with `b`'s own evidence.
 *
 * Only genuine `=` writes with a concrete RHS are collected; reads, method
 * calls and compound assignments are not shape evidence. Returns an empty
 * array when there is nothing usable, so the caller adds no source. (v0.1.46.)
 */
export function aliasWriteShapes(decl: ts.VariableDeclaration, ctx: InferenceContext): string[] {
  if (!ts.isIdentifier(decl.name)) {
    return [];
  }
  const symbol = ctx.checker.getSymbolAtLocation(decl.name);
  if (symbol === undefined) {
    return [];
  }
  const root: ShapeNode = { children: new Map<string, ShapeNode>() };
  let sawWrite = false;
  for (const ref of referencesOf(symbol, ctx)) {
    // Walk outward to the longest property-access chain rooted at `ref`.
    let current: ts.Expression = ref;
    while (
      ts.isPropertyAccessExpression(current.parent) &&
      current.parent.expression === current
    ) {
      current = current.parent;
    }
    if (current === ref) {
      continue;
    }
    const parent: ts.Node | undefined = current.parent;
    if (
      parent === undefined ||
      !ts.isBinaryExpression(parent) ||
      parent.left !== current ||
      parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken
    ) {
      continue;
    }
    const chain: string[] = [];
    let walk: ts.Expression = current;
    while (ts.isPropertyAccessExpression(walk)) {
      chain.unshift(walk.name.text);
      walk = walk.expression;
    }
    // Only deep writes (`a.c.d = v`, chain length >= 2) are collected. A
    // shallow alias write (`node.flag = v`) is already represented by the
    // alias's own `properties` and folding it here widens function-parameter
    // unions in real libraries (react-dom). The mixed deep-write scenario is
    // the gap v0.1.45 left open. (v0.1.46.)
    if (walk !== ref || chain.length < 2) {
      continue;
    }
    const rhsType = typeText(ctx, parent.right);
    if (rhsType === undefined || VAGUE_RETURN_TYPES.has(rhsType)) {
      continue;
    }
    insertShapeChain(root, chain, false, false, rhsType);
    sawWrite = true;
  }
  if (!sawWrite) {
    return [];
  }
  const rendered = renderShapeNode(root);
  return isPlainObjectShapeText(rendered) ? [rendered] : [];
}

/**
 * Writes through a property-path alias (`let a = b.c`) recorded into `b`'s
 * shape chain. Each genuine `=` write `a.<chain> = <literal>` places
 * `prefixChain + writeChain` in the tree with the literal's leaf type, e.g.
 * `let a = b.c; a.d = 1` records `c.d -> number`, rendering `b` as
 * `{ c: { d: number } }`.
 *
 * Deliberately conservative to stay convergent on real libraries:
 *  - writes go into the shape chain (low-priority fallback), NOT `sources`,
 *    so they never feed the fixed-point source union/merge cycle that made a
 *    `a = b.c` reflow grow react-dom's output to 35 MB (OOM);
 *  - only static literal RHS values are accepted (number/string/boolean/null
 *    /object/array literals), so no `typeText` dependency on the evolving
 *    table is introduced — there is no cycle to blow up;
 *  - total chain length is capped, bounding the shape size.
 * Reads/calls/compound assignments and computed-key writes are ignored.
 * (v0.1.47.)
 */
export function propertyAliasWritesInto(
  decl: ts.VariableDeclaration,
  prefixChain: readonly string[],
  ctx: InferenceContext,
  root: ShapeNode,
): void {
  if (!ts.isIdentifier(decl.name)) {
    return;
  }
  const symbol = ctx.checker.getSymbolAtLocation(decl.name);
  if (symbol === undefined) {
    return;
  }
  const MAX_CHAIN = 6;
  const refs = referencesOf(symbol, ctx);
  // If the alias is ever used as a method receiver (`style.setProperty(...)`)
  // or passed/called, it denotes a value with a known protocol, not an opaque
  // object being built up by writes; reshaping its target would invent a wrong
  // shape (react-dom's CSSStyleDeclaration). Bail out entirely. (v0.1.47.)
  for (const ref of refs) {
    let cur: ts.Expression = ref;
    while (
      ts.isPropertyAccessExpression(cur.parent) &&
      cur.parent.expression === cur
    ) {
      cur = cur.parent;
    }
    const p: ts.Node | undefined = cur.parent;
    if (
      (ts.isCallExpression(p) && p.expression === cur) ||
      (ts.isNewExpression(p) && p.expression === cur) ||
      (ts.isCallExpression(p) && p.arguments.includes(cur as ts.Expression))
    ) {
      return;
    }
  }
  for (const ref of refs) {
    // Walk outward to the longest property-access chain rooted at `ref`.
    let current: ts.Expression = ref;
    while (
      ts.isPropertyAccessExpression(current.parent) &&
      current.parent.expression === current
    ) {
      current = current.parent;
    }
    if (current === ref) {
      continue;
    }
    const parent: ts.Node | undefined = current.parent;
    if (
      parent === undefined ||
      !ts.isBinaryExpression(parent) ||
      parent.left !== current ||
      parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken
    ) {
      continue;
    }
    const writeChain: string[] = [];
    let walk: ts.Expression = current;
    while (ts.isPropertyAccessExpression(walk)) {
      writeChain.unshift(walk.name.text);
      walk = walk.expression;
    }
    if (walk !== ref) {
      continue;
    }
    const leafType = staticLiteralType(parent.right);
    if (leafType === undefined) {
      continue;
    }
    const chain = [...prefixChain, ...writeChain];
    if (chain.length === 0 || chain.length > MAX_CHAIN) {
      continue;
    }
    insertShapeChain(root, chain, false, false, leafType);
  }
}

/**
 * Writes through a value returned by a trivial closure (`const x = g()`,
 * `function g(){ return b }`) recorded into `b`'s shape chain. Only a function
 * whose single value-return is the owner binding, called with zero arguments
 * into an un-reassigned const with static-literal writes, qualifies. Written
 * into the shape chain (not sources) to stay convergent. (v0.1.47.)
 */
export function closureReturnAliasWritesInto(
  reference: ts.Identifier,
  ctx: InferenceContext,
  root: ShapeNode,
): void {
  // Enclosing function `g` of the `return <reference>` statement.
  let g: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined;
  let cur: ts.Node | undefined = reference.parent;
  while (cur !== undefined) {
    if (ts.isFunctionDeclaration(cur) || ts.isFunctionExpression(cur) || ts.isArrowFunction(cur)) {
      g = cur;
      break;
    }
    if (ts.isSourceFile(cur)) {
      break;
    }
    cur = cur.parent;
  }
  if (g === undefined || g.body === undefined || !ts.isBlock(g.body)) {
    return;
  }
  // g must contain exactly one value-return, and it must be this one.
  const valueReturns: ts.ReturnStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node) && node !== g) {
      return;
    }
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      valueReturns.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(g.body);
  if (valueReturns.length !== 1 || valueReturns[0] !== reference.parent) {
    return;
  }
  const gSymbol = g.name !== undefined ? ctx.checker.getSymbolAtLocation(g.name) : undefined;
  if (gSymbol !== undefined) {
    applyTrivialFnCallsToRoot(gSymbol, ctx, root);
  }
}

/**
 * Given a trivial returner function's symbol, find `const x = g()` call sites
 * and fold literal writes through `x` into `root`. Shared by block-bodied
 * functions and expression-bodied arrows. (v0.1.47.)
 */
export function applyTrivialFnCallsToRoot(
  gSymbol: ts.Symbol,
  ctx: InferenceContext,
  root: ShapeNode,
): void {
  // Find `const x = g()` call sites.
  for (const gRef of referencesOf(gSymbol, ctx)) {
    const call = gRef.parent;
    if (
      !ts.isCallExpression(call) ||
      call.expression !== gRef ||
      call.arguments.length !== 0
    ) {
      continue;
    }
    const decl = call.parent;
    if (
      !ts.isVariableDeclaration(decl) ||
      decl.initializer !== call ||
      !ts.isIdentifier(decl.name) ||
      decl.type !== undefined ||
      !ts.isVariableDeclarationList(decl.parent) ||
      (decl.parent.flags & ts.NodeFlags.Const) === 0
    ) {
      continue;
    }
    const xSymbol = ctx.checker.getSymbolAtLocation(decl.name);
    if (xSymbol === undefined || !neverReassigned(xSymbol, decl, ctx)) {
      continue;
    }
    collectLiteralWritesInto(xSymbol, decl, ctx, root);
  }
}

/** True when `symbol`'s only initializer is `decl` and it is never reassigned. */
export function neverReassigned(
  symbol: ts.Symbol,
  decl: ts.VariableDeclaration,
  ctx: InferenceContext,
): boolean {
  for (const ref of referencesOf(symbol, ctx)) {
    if (ref === decl.name) {
      continue;
    }
    const p = ref.parent;
    if (p === undefined) {
      continue;
    }
    if (
      (ts.isBinaryExpression(p) &&
        p.left === ref &&
        isAssignmentOperatorKind(p.operatorToken.kind)) ||
      ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) &&
        (p.operator === ts.SyntaxKind.PlusPlusToken ||
          p.operator === ts.SyntaxKind.MinusMinusToken)) ||
      (ts.isCallExpression(p) && p.expression === ref) ||
      (ts.isCallExpression(p) && p.arguments.includes(ref))
    ) {
      return false;
    }
  }
  return true;
}

/** Literal `=` writes through `symbol` placed into `root` (no prefix). */
export function collectLiteralWritesInto(
  symbol: ts.Symbol,
  decl: ts.VariableDeclaration,
  ctx: InferenceContext,
  root: ShapeNode,
): void {
  const MAX_CHAIN = 6;
  for (const ref of referencesOf(symbol, ctx)) {
    if (ref === decl.name) {
      continue;
    }
    let current: ts.Expression = ref;
    while (
      ts.isPropertyAccessExpression(current.parent) &&
      current.parent.expression === current
    ) {
      current = current.parent;
    }
    if (current === ref) {
      continue;
    }
    const parent: ts.Node | undefined = current.parent;
    if (
      parent === undefined ||
      !ts.isBinaryExpression(parent) ||
      parent.left !== current ||
      parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken
    ) {
      continue;
    }
    const chain: string[] = [];
    let walk: ts.Expression = current;
    while (ts.isPropertyAccessExpression(walk)) {
      chain.unshift(walk.name.text);
      walk = walk.expression;
    }
    if (walk !== ref || chain.length === 0 || chain.length > MAX_CHAIN) {
      continue;
    }
    const leafType = staticLiteralType(parent.right);
    if (leafType === undefined) {
      continue;
    }
    insertShapeChain(root, chain, false, false, leafType);
  }
}

/** Static type of a literal RHS, with no dependency on the inference table. */
export function staticLiteralType(expr: ts.Expression): string | undefined {
  if (ts.isNumericLiteral(expr)) {
    return 'number';
  }
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return 'string';
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) {
    return 'boolean';
  }
  // `null` writes are state resets in real libraries (e.g. Fiber
  // `alternate.return = null`), not shape evidence — recording their leaf as
  // `null` narrows a known field and causes TS2322. Object/array literals are
  // likewise too coarse (`object` / `unknown[]`) to be trustworthy shape
  // evidence. Only scalar number/string/boolean literals qualify. (v0.1.47.)
  // Unary minus on a numeric literal (`a.d = -1`).
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(expr.operand)) {
    return 'number';
  }
  return undefined;
}
