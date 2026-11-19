import * as ts from 'typescript';

import type { InferenceContext } from './types.js';
import { getScan } from './scan.js';
import { isAssignmentOperatorKind, isFunctionLike, nonDeclarationFiles, ownerOf } from './util.js';

/** All identifier references to `symbol` (O(1) lookup in the shared scan). */
export function referencesOf(symbol: ts.Symbol, ctx: InferenceContext): ts.Identifier[] {
  return getScan(ctx).references.get(symbol) ?? [];
}

/** True for `let`/`var x;` that has no initializer and is never assigned
 * anywhere in the program. Replacing such an `any` with a concrete type makes
 * TypeScript start definite-assignment analysis and emit TS2454 ("used before
 * being assigned") at every read — an error the original `any` did not have.
 * Keeping `any` here preserves the original strict-clean behaviour. */
export function isUnassignedLetWithoutInit(owner: ts.Node, ctx: InferenceContext): boolean {
  if (!ts.isVariableDeclaration(owner) || owner.initializer !== undefined) {
    return false;
  }
  const list = owner.parent;
  if (!ts.isVariableDeclarationList(list)) {
    return false;
  }
  // `const` declarations always have an initializer, so reaching here with no
  // initializer means `let` or `var` (TS has no dedicated NodeFlags.Var).
  if ((list.flags & ts.NodeFlags.Const) !== 0) {
    return false;
  }
  // Ambient `declare var x;` cannot carry a definite-assignment assertion
  // (TS1255), and is already assumed initialized by its declaration.
  const statement = list.parent;
  if (
    statement !== undefined &&
    ts.isVariableStatement(statement) &&
    statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)
  ) {
    return false;
  }
  const symbol = ctx.checker.getSymbolAtLocation(owner.name);
  if (symbol === undefined) {
    return true;
  }
  for (const ref of referencesOf(symbol, ctx)) {
    if (ref === owner.name) {
      continue;
    }
    const parent = ref.parent;
    if (parent === undefined) {
      continue;
    }
    // Any write to the binding means definite-assignment analysis would be
    // satisfied after that point, so narrowing is safe.
    if (
      ts.isBinaryExpression(parent) &&
      parent.left === ref &&
      isAssignmentOperatorKind(parent.operatorToken.kind)
    ) {
      return false;
    }
    if (
      (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken ||
        parent.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      return false;
    }
  }
  return true;
}

/** Call sites whose resolved signature belongs to `declaration` (O(1) lookup). */
export function callsOf(
  declaration: ts.SignatureDeclaration,
  ctx: InferenceContext,
): readonly import('./types.js').CallSite[] {
  return getScan(ctx).calls.get(declaration) ?? [];
}

/** All declarations that carry an `any` annotation, across non-declaration files. */
export function collectAnyOwners(program: ts.Program): ts.Node[] {
  const owners = new Set<ts.Node>();
  for (const sourceFile of nonDeclarationFiles(program)) {
    const visit = (node: ts.Node): void => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        const owner = ownerOf(node);
        if (owner !== undefined) {
          owners.add(owner);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return [...owners];
}

/** All inferable declarations, used for JS sources where `any` is implicit. */
export function collectDeclarations(program: ts.Program): ts.Node[] {
  const owners: ts.Node[] = [];
  const seen = new Set<ts.Node>();
  for (const sourceFile of nonDeclarationFiles(program)) {
    const visit = (node: ts.Node): void => {
      const inferable =
        isFunctionLike(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isPropertySignature(node) ||
        ts.isBindingElement(node) ||
        ts.isParameter(node);
      if (inferable && !seen.has(node)) {
        seen.add(node);
        owners.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return owners;
}

/** True when `node` is the return-type annotation slot of a function-like owner. */
export function isReturnTypeAnnotationOf(node: ts.Node, owner: ts.Node): boolean {
  return (
    isFunctionLike(owner) &&
    node.parent === owner &&
    (owner as ts.SignatureDeclaration).type === node
  );
}

/** Mirror the JS converter's async return wrapping on the explicit-`any` path:
 * an async function returning `T` actually returns `Promise<T>` at runtime. */
export function wrapAsyncReturnForInfer(type: string, owner: ts.Node): string {
  if (!isFunctionLike(owner)) {
    return type;
  }
  const isAsync =
    (ts.getCombinedModifierFlags(owner as ts.Declaration) & ts.ModifierFlags.Async) !== 0;
  if (!isAsync || type.startsWith('Promise<')) {
    return type;
  }
  return type === 'void' ? 'Promise<void>' : `Promise<${type}>`;
}
