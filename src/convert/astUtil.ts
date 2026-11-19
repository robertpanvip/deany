import * as ts from 'typescript';

export type FunctionLikeNode =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

export interface Edit {
  readonly pos: number;
  readonly text: string;
  readonly order: number;
}

/**
 * Collects text insertions and applies them back-to-front so original offsets stay valid.
 * Pieces passed to one `add` call are emitted left-to-right at the target position.
 */
export class EditBuffer {
  private readonly edits: Edit[] = [];
  private sequence = 0;

  add(pos: number, ...pieces: string[]): void {
    for (const piece of pieces) {
      if (piece.length === 0) {
        continue;
      }
      this.edits.push({ pos, text: piece, order: this.sequence });
      this.sequence += 1;
    }
  }

  apply(source: string): string {
    const sorted = [...this.edits].sort((a, b) => b.pos - a.pos || b.order - a.order);
    let result = source;
    for (const edit of sorted) {
      result = result.slice(0, edit.pos) + edit.text + result.slice(edit.pos);
    }
    return result;
  }
}

export function isFunctionLike(node: ts.Node): node is FunctionLikeNode {
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

export function describe(node: ts.Node): string {
  if ('name' in node && typeof node.name === 'object' && node.name !== null && ts.isIdentifier(node.name as ts.Node)) {
    return (node.name as ts.Identifier).text;
  }
  return ts.SyntaxKind[node.kind] ?? 'declaration';
}

/** Locate the parameter-list parentheses of a function-like node. */
export function findParens(
  node: FunctionLikeNode,
  sourceFile: ts.SourceFile,
  source: string,
): { open: number; close: number } | undefined {
  let open = -1;
  for (const child of node.getChildren(sourceFile)) {
    if (child.kind === ts.SyntaxKind.OpenParenToken) {
      open = child.getStart(sourceFile);
      break;
    }
  }
  if (open < 0) {
    return undefined;
  }

  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i] ?? '';
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') {
        i += 1;
      }
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      if (close >= 0) {
        i = close + 1;
        continue;
      }
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        return { open, close: i };
      }
    }
  }
  return undefined;
}

/** Find the end offset of a keyword child such as `function`. */
export function keywordEnd(
  node: FunctionLikeNode,
  sourceFile: ts.SourceFile,
  kind: ts.SyntaxKind,
): number | undefined {
  for (const child of node.getChildren(sourceFile)) {
    if (child.kind === kind) {
      return child.end;
    }
  }
  return undefined;
}

export function hasModifier(node: FunctionLikeNode, kind: ts.SyntaxKind): boolean {
  return node.modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

export function isGenerator(node: FunctionLikeNode): boolean {
  return 'asteriskToken' in node && node.asteriskToken !== undefined;
}

export function parameterName(node: ts.ParameterDeclaration): string | undefined {
  return ts.isIdentifier(node.name) ? node.name.text : undefined;
}

/** Callbacks passed as arguments get their types from the callee; annotating them with
 * `unknown` would destroy contextual typing. */
export function isCallbackArgument(node: FunctionLikeNode): boolean {
  const parent = node.parent;
  if (parent === undefined) {
    return false;
  }
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
    return (parent.arguments ?? []).some((argument) => argument === node);
  }
  return false;
}

/**
 * True when a function node is used as a returned value (`return x => ...`,
 * including a `return` inside an outer arrow). Such a function — and the
 * nested arrows it returns — sits under a declaration whose JSDoc @returns
 * typically already describes the full nested function type, so stamping each
 * inner arrow with `: unknown` contradicts that type (TS2322). Walk through
 * transparent wrappers (parentheses, `as`, non-null) up to the first statement
 * boundary.
 */
export function isReturnPositionArrow(node: ts.Node): boolean {
  let current: ts.Node = node;
  let parent = current.parent;
  while (parent !== undefined) {
    if (ts.isReturnStatement(parent)) {
      return true;
    }
    // A nested expression-bodied arrow (`b => c => ...`): the inner arrow is
    // the outer arrow's body, so inherit the outer's return-position status.
    if (ts.isArrowFunction(parent) && parent.body === current) {
      current = parent;
      parent = current.parent;
      continue;
    }
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isNonNullExpression(parent)
    ) {
      current = parent;
      parent = current.parent;
      continue;
    }
    return false;
  }
  return false;
}

export function enclosingClass(node: ts.Node): ts.ClassLikeDeclaration | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}
