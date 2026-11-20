import * as ts from 'typescript';

import type { InferenceContext } from './types.js';
import { nonDeclarationFiles } from './util.js';

/**
 * An implicitly inferred type predicate for a boolean "guard" function.
 *
 * JS has no `x is T` syntax, so a guard like `function isObject(v) { return v
 * !== null && typeof v === 'object' }` is only annotated `: boolean` — TS then
 * refuses to narrow the argument inside `if (isObject(x))`, and strict-mode
 * uses such as `'k' in x` fail (TS2367/TS18046). We infer the narrowing type
 * from how the argument is *used* in the guard's true branch (the strongest,
 * most direct evidence), then emit `v is T` on the guard signature.
 */
export interface ImplicitPredicate {
  /** Zero-based parameter position the predicate narrows. */
  readonly paramIndex: number;
  /** Parameter name, used to render `name is Type`. */
  readonly paramName: string;
  /** The narrowed type text, e.g. `object`, `string`, `unknown[]`. */
  readonly narrowType: string;
  /** Higher wins when a guard has contradictory evidence. */
  readonly strength: number;
}

/** Resolution of one guard call site. */
interface GuardCall {
  readonly call: ts.CallExpression;
  /** The declaration that defines the guard function. */
  readonly declaration: ts.SignatureDeclaration;
  /** Argument expressions, positionally aligned with declaration.params. */
  readonly args: readonly ts.Expression[];
  /** Node marking the start of the true branch (used to bound the search). */
  readonly trueBranch: ts.Node;
  /** True when the guard is negated (`if (!isObject(x))`), i.e. false arm narrows. */
  readonly negated: boolean;
}

/**
 * One piece of predicate evidence. `base` fixes the narrowed primitive/class
 * type; `shape` only contributes a known property name and is folded into an
 * `object & { ... }` base (or dropped when the base is already a precise
 * non-object type such as `string`).
 */
type PredicateEvidence =
  | { readonly kind: 'base'; readonly type: string; readonly strength: number }
  | { readonly kind: 'shape'; readonly key: string; readonly strength: number };

/**
 * Evidence kinds, ordered by specificity. When a guard argument is used in
 * several mutually-exclusive ways we keep the single strongest base and merge
 * all observed shapes — a union predicate would be legal but imprecise.
 */
const EVIDENCE: ReadonlyArray<{
  readonly strength: number;
  readonly match: (use: ts.Node, ctx: InferenceContext) => PredicateEvidence | undefined;
}> = [
  // instanceof C -> the class name (most specific concrete type).
  {
    strength: 90,
    match: (use, ctx) => {
      const bin = asBinaryWithOperand(use, ctx, ts.SyntaxKind.InstanceOfKeyword);
      if (bin === undefined) return undefined;
      const type = expressionText(bin.right, ctx);
      return type === undefined ? undefined : { kind: 'base', type, strength: 90 };
    },
  },
  // typeof x === 'string' / 'number' / 'boolean' / 'bigint' / 'symbol'.
  // `use` is the identifier inside `typeof x`; walk up through the
  // TypeOfExpression to the enclosing comparison so function-body guards
  // (`function isStr(v) { return typeof v === 'string' }`) are detected too.
  {
    strength: 80,
    match: (use) => {
      let compared: ts.Node = unwrapParens(use);
      if (compared.parent !== undefined && ts.isTypeOfExpression(compared.parent) && compared.parent.expression === compared) {
        compared = compared.parent;
      }
      const parent = compared.parent;
      if (parent === undefined || !ts.isBinaryExpression(parent)) return undefined;
      if (parent.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
          parent.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsToken) return undefined;
      const other = parent.left === compared ? parent.right : parent.left;
      const literal = literalText(other);
      if (literal === undefined) return undefined;
      const type = typeofLiteralToPrimitive(literal);
      return type === undefined ? undefined : { kind: 'base', type, strength: 80 };
    },
  },
  // Callable: x() / x.apply(...) / x.call(...) -> Function.
  {
    strength: 70,
    match: (use) => {
      const parent = use.parent;
      if (ts.isCallExpression(parent) && parent.expression === unwrapParens(use)) {
        return { kind: 'base', type: 'Function', strength: 70 };
      }
      if (ts.isPropertyAccessExpression(parent) && parent.expression === unwrapParens(use)) {
        if (parent.name.text === 'apply' || parent.name.text === 'call' || parent.name.text === 'bind') {
          const grand = parent.parent;
          if (ts.isCallExpression(grand) && grand.expression === parent) {
            return { kind: 'base', type: 'Function', strength: 70 };
          }
        }
      }
      return undefined;
    },
  },
  // Array-ish: Array.isArray(x), or x.map/filter (array-only methods).
  // `length` is deliberately excluded — strings have it too.
  {
    strength: 60,
    match: (use, ctx) => {
      const parent = use.parent;
      if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression)) {
        const calleeName = parent.expression.text;
        const callee = ctx.checker.getSymbolAtLocation(parent.expression);
        if (calleeName === 'isArray' && parent.arguments[0] === unwrapParens(use)) {
          return { kind: 'base', type: 'unknown[]', strength: 60 };
        }
        if (callee !== undefined && callee.name === 'isArray' && parent.arguments[0] === unwrapParens(use)) {
          return { kind: 'base', type: 'unknown[]', strength: 60 };
        }
      }
      if (ts.isPropertyAccessExpression(parent) && parent.expression === unwrapParens(use)) {
        if (ARRAY_METHODS.has(parent.name.text)) return { kind: 'base', type: 'unknown[]', strength: 60 };
      }
      return undefined;
    },
  },
  // 'k' in x -> object base + key shape.
  {
    strength: 50,
    match: (use, ctx) => {
      const bin = asBinaryWithOperand(use, ctx, ts.SyntaxKind.InKeyword);
      if (bin === undefined) return undefined;
      if (unwrapParens(bin.right) !== unwrapParens(use)) return undefined;
      const key = literalText(bin.left);
      return key !== undefined
        ? { kind: 'shape', key, strength: 50 }
        : { kind: 'base', type: 'object', strength: 50 };
    },
  },
  // Property access / method call x.foo -> object base + key shape.
  {
    strength: 40,
    match: (use) => {
      const parent = use.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === unwrapParens(use)) {
        return { kind: 'shape', key: parent.name.text, strength: 40 };
      }
      if (ts.isElementAccessExpression(parent) && parent.expression === unwrapParens(use)) {
        return { kind: 'base', type: 'object', strength: 40 };
      }
      return undefined;
    },
  },
];

const ARRAY_METHODS = new Set([
  'map', 'filter', 'forEach', 'reduce', 'slice', 'push', 'pop', 'concat',
  'find', 'some', 'every', 'includes', 'indexOf', 'join',
]);

function unwrapParens(node: ts.Node): ts.Node {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

function literalText(node: ts.Node): string | undefined {
  const bare = unwrapParens(node);
  if (ts.isStringLiteral(bare) || ts.isNoSubstitutionTemplateLiteral(bare)) return bare.text;
  if (ts.isNumericLiteral(bare)) return bare.text;
  return undefined;
}

function typeofLiteralToPrimitive(lit: string): string | undefined {
  return ['string', 'number', 'boolean', 'bigint', 'symbol', 'undefined', 'object', 'function'].includes(lit)
    ? lit === 'function' ? 'Function' : lit === 'object' ? 'object' : lit
    : undefined;
}

function safeKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function expressionText(node: ts.Node, _ctx: InferenceContext): string | undefined {
  const bare = unwrapParens(node);
  // For `x instanceof C`, prefer the identifier text `C` (the class name the
  // user wrote) over the checker's apparent type, which is often the
  // constructor signature (`() => void`) rather than the instance type.
  if (ts.isIdentifier(bare)) return bare.text;
  if (ts.isPropertyAccessExpression(bare)) return bare.getText();
  return undefined;
}

/** True when `use` is one operand of a binary expression with the given operator. */
function asBinaryWithOperand(
  use: ts.Node,
  _ctx: InferenceContext,
  operator: ts.SyntaxKind,
): ts.BinaryExpression | undefined {
  const parent = unwrapParens(use).parent;
  if (parent !== undefined && ts.isBinaryExpression(parent) && parent.operatorToken.kind === operator) {
    return parent;
  }
  return undefined;
}

/**
 * Collect guard calls that sit in a boolean condition position. A guard is a
 * call whose result is used as a condition; its true branch is where the
 * argument is narrowed. We handle: `if (g(x)) T`, `g(x) && T`, `g(x) ? T : F`,
 * `while (g(x))`, and the negated `if (!g(x))` (false arm narrows instead).
 */
function collectGuardCalls(ctx: InferenceContext): GuardCall[] {
  const result: GuardCall[] = [];
  for (const sourceFile of nonDeclarationFiles(ctx.program)) {
    const visit = (node: ts.Node): void => {
      let condition: ts.Expression | undefined;
      let trueBranch: ts.Node | undefined;
      let negated = false;

      if (ts.isIfStatement(node)) {
        condition = node.expression;
        trueBranch = node.thenStatement;
      } else if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
        condition = node.expression;
        trueBranch = node.statement;
      } else if (ts.isConditionalExpression(node)) {
        condition = node.condition;
        trueBranch = node.whenTrue;
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        // `g(x) && rest`: the right side is the true branch.
        if (ts.isCallExpression(unwrapParens(node.left))) {
          addFromCall(node.left, node.right, false, result, ctx);
        }
      }

      if (condition !== undefined && trueBranch !== undefined) {
        const bare = unwrapParens(condition);
        if (ts.isPrefixUnaryExpression(bare) && bare.operator === ts.SyntaxKind.ExclamationToken) {
          negated = true;
          addFromCall(bare.operand, trueBranch, negated, result, ctx);
        } else {
          addFromCall(condition, trueBranch, negated, result, ctx);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return result;
}

function addFromCall(
  expr: ts.Expression,
  trueBranch: ts.Node,
  negated: boolean,
  out: GuardCall[],
  ctx: InferenceContext,
): void {
  const call = unwrapParens(expr);
  if (!ts.isCallExpression(call)) return;
  // Must return boolean-ish; a value-returning function used in a condition is
  // still a guard (truthiness), so we accept it — evidence collection decides.
  const declaration = ctx.checker.getResolvedSignature(call)?.declaration;
  if (declaration === undefined || ts.isJSDocSignature(declaration)) return;
  const signature = declaration as ts.SignatureDeclaration;
  if (signature.parameters.length === 0 || call.arguments.length === 0) return;
  out.push({ call, declaration: signature, args: call.arguments, trueBranch, negated });
}

/** Merge all evidence found on a set of use nodes into a base type + shapes. */
function evidenceFromUses(uses: readonly ts.Node[], ctx: InferenceContext): {
  base: { readonly type: string; readonly strength: number } | undefined;
  shapes: Set<string>;
  strength: number;
} {
  let base: { readonly type: string; readonly strength: number } | undefined;
  const shapes = new Set<string>();
  let strength = 0;
  for (const use of uses) {
    for (const rule of EVIDENCE) {
      const matched = rule.match(use, ctx);
      if (matched === undefined) continue;
      if (matched.kind === 'base') {
        if (base === undefined || matched.strength > base.strength) {
          base = { type: matched.type, strength: matched.strength };
        }
      } else {
        shapes.add(matched.key);
      }
      if (matched.strength > strength) strength = matched.strength;
    }
  }
  return { base, shapes, strength };
}

/** Render a narrowed type from a base and a set of observed property keys. */
function renderNarrowType(base: string | undefined, shapes: ReadonlySet<string>): string | undefined {
  const objectBody = shapes.size > 0
    ? [...shapes].sort().map((key) => `${safeKey(key)}: unknown`).join('; ')
    : undefined;
  if (base === undefined || base === 'object') {
    return objectBody === undefined ? (base ?? undefined) : `object & { ${objectBody} }`;
  }
  // A precise non-object base (string / number / Function / unknown[] / class)
  // subsumes the shape hints — e.g. `.length` on a string is not new info.
  return base;
}

/** Collect references to `symbol` within `root`, not crossing function boundaries. */
function collectSymbolUses(root: ts.Node, symbol: ts.Symbol, ctx: InferenceContext): ts.Node[] {
  const uses: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== root && isFunctionLike(node)) return; // don't cross function boundaries
    if (ts.isIdentifier(node)) {
      const s = ctx.checker.getSymbolAtLocation(node);
      const resolved = s !== undefined && (s.flags & ts.SymbolFlags.Alias) !== 0
        ? ctx.checker.getAliasedSymbol(s)
        : s;
      if (resolved !== undefined && resolved === symbol) uses.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return uses;
}

/**
 * Build the map of declaration -> inferred implicit predicates. One pass over
 * every guard call in the whole program; evidence from all call sites of the
 * same function (plus the function body itself) is aggregated and the
 * strongest per parameter wins.
 */
export function collectImplicitPredicates(ctx: InferenceContext): Map<ts.SignatureDeclaration, ImplicitPredicate[]> {
  const result = new Map<ts.SignatureDeclaration, ImplicitPredicate[]>();
  const guards = collectGuardCalls(ctx);

  // Cache function-body evidence per (declaration, paramIndex) — it is shared
  // by every call site of the same guard.
  const bodyEvidence = new Map<string, ReturnType<typeof evidenceFromUses>>();

  for (const guard of guards) {
    for (let paramIndex = 0; paramIndex < guard.declaration.parameters.length; paramIndex += 1) {
      const param = guard.declaration.parameters[paramIndex];
      const arg = guard.args[paramIndex];
      if (param === undefined || param.name === undefined || arg === undefined) continue;
      const paramName = ts.isIdentifier(param.name) ? param.name.text : undefined;
      if (paramName === undefined) continue;

      // Call-site evidence: uses of the actual argument inside the narrowed
      // branch — this is the "usage shows a type mismatch" signal the user
      // cares about (e.g. `'leading' in options` proves a predicate exists).
      const argBare = unwrapParens(arg);
      if (!ts.isIdentifier(argBare) && !ts.isPropertyAccessExpression(argBare)) continue;
      const argSymbol = ctx.checker.getSymbolAtLocation(argBare);
      if (argSymbol === undefined) continue;
      const branchUses = collectSymbolUses(guard.trueBranch, argSymbol, ctx);
      const callSite = evidenceFromUses(branchUses, ctx);

      // Function-body evidence: how the guard's own parameter is inspected
      // (e.g. `typeof v === 'string'`). This is the classic predicate signal
      // and disambiguates cases like `isStr(v)` used with `x.length`.
      const cacheKey = `${(guard.declaration.getStart())}:${paramIndex}`;
      let body = bodyEvidence.get(cacheKey);
      if (body === undefined) {
        const paramSymbol = ctx.checker.getSymbolAtLocation(param.name);
        if (paramSymbol !== undefined) {
          const bodyRoot = functionBodyOf(guard.declaration) ?? guard.declaration;
          const bodyUses = collectSymbolUses(bodyRoot, paramSymbol, ctx);
          body = evidenceFromUses(bodyUses, ctx);
        } else {
          body = { base: undefined, shapes: new Set<string>(), strength: 0 };
        }
        bodyEvidence.set(cacheKey, body);
      }

      // Merge: strongest base wins; shapes from both sources combine.
      const base = callSite.base !== undefined && (body.base === undefined || callSite.base.strength > body.base.strength)
        ? callSite.base
        : body.base;
      const shapes = new Set<string>([...body.shapes, ...callSite.shapes]);
      const narrowType = renderNarrowType(base?.type, shapes);
      if (narrowType === undefined) continue;

      const strength = Math.max(callSite.strength, body.strength);
      const existing = result.get(guard.declaration) ?? [];
      const prev = existing.find((p) => p.paramIndex === paramIndex);
      if (prev === undefined || strength > prev.strength) {
        const predicate: ImplicitPredicate = { paramIndex, paramName, narrowType, strength };
        const next = prev === undefined
          ? [...existing, predicate]
          : existing.map((p) => (p.paramIndex === paramIndex ? predicate : p));
        result.set(guard.declaration, next);
      }
    }
  }
  return result;
}

function isFunctionLike(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
}

/** Return the function body node for any signature declaration with one. */
function functionBodyOf(decl: ts.SignatureDeclaration): ts.Node | undefined {
  if (ts.isFunctionDeclaration(decl) || ts.isFunctionExpression(decl) ||
      ts.isArrowFunction(decl) || ts.isMethodDeclaration(decl) ||
      ts.isConstructorDeclaration(decl) || ts.isGetAccessorDeclaration(decl) ||
      ts.isSetAccessorDeclaration(decl)) {
    return decl.body;
  }
  return undefined;
}
