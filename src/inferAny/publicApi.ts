import * as ts from 'typescript';

import type { DeclarationProvider, DtsSignature } from '../dts.js';

/**
 * Whether a declaration is exported from its module (the public API surface).
 *
 * Uses symbol identity rather than spelling, so a same-named private local in
 * another scope is never mistaken for an exported binding. Recognises every
 * common export form:
 *   - `export function/class/const X`
 *   - `export default function X`
 *   - `export { X }` / `export { X as Y }`
 *   - public methods of an exported class (inherited export via the class)
 *   - CommonJS `module.exports = { X }` / `exports.X = ...`
 *
 * Pure: depends only on the checker and the source file, safe to call from any
 * inference path. Returns false for non-module scripts and private bindings.
 */
export function isExportedDeclaration(
  node: ts.Node,
  checker: ts.TypeChecker,
): boolean {
  const target = declarationTarget(node);
  if (target === undefined) {
    return false;
  }

  // 1) Direct modifiers: `export` / `export default` on the declaration (or,
  // for an arrow/function expression, on the enclosing variable statement).
  const modifierOwner = enclosingNamedDeclaration(target) ?? target;
  const modifiers = ts.canHaveModifiers(modifierOwner) ? ts.getModifiers(modifierOwner) : undefined;
  if (
    modifiers?.some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword,
    )
  ) {
    return true;
  }

  // 2) Class methods: a public method of an exported class is itself public API.
  // Private/protected members are never part of the surface.
  if (isClassMember(target)) {
    const mods = ts.canHaveModifiers(target) ? ts.getModifiers(target) : undefined;
    if (
      mods?.some(
        (m) =>
          m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword,
      )
    ) {
      return false;
    }
    const classDecl = target.parent;
    if (ts.isClassDeclaration(classDecl) || ts.isClassExpression(classDecl)) {
      return isExportedDeclaration(classDecl, checker);
    }
    return false;
  }

  // 3) Symbol membership in the module's export table (covers `export { X }`
  // and `export { X as Y }`, including renamed re-exports).
  const nameNode = declarationName(target);
  if (nameNode === undefined) {
    return isCommonJsExported(target);
  }
  const symbol = checker.getSymbolAtLocation(nameNode);
  const sourceFile = target.getSourceFile();
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (symbol !== undefined && moduleSymbol !== undefined) {
    const deref = (s: ts.Symbol): ts.Symbol =>
      (s.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(s) : s;
    const wanted = deref(symbol);
    const exported = checker.getExportsOfModule(moduleSymbol).some((s) => deref(s) === wanted);
    if (exported) {
      return true;
    }
  }

  // 4) CommonJS `module.exports` / `exports.X` fallback (checker's export table
  // does not model CommonJS under all module settings).
  return isCommonJsExported(target);
}

/** True when `param` is a parameter of an exported function/method. */
export function isExportedParameter(
  param: ts.ParameterDeclaration,
  checker: ts.TypeChecker,
): boolean {
  const fn = param.parent;
  return isFunctionLikeNode(fn) && isExportedDeclaration(fn, checker);
}

/**
 * Look up the authoritative type for a declaration from a sibling `.d.ts`.
 * Returns undefined when there is no contract for this declaration.
 *
 * Matching is by symbol name and declaration shape:
 *   - function parameter -> `functions.get(fnName).params[index]`
 *   - function return   -> `functions.get(fnName).returnType`
 *   - variable          -> `variables.get(name)`
 *   - class member      -> `members.get('Class.member')`
 */
export function declaredTypeOf(
  owner: ts.Node,
  provider: DeclarationProvider | undefined,
): string | undefined {
  if (provider === undefined) {
    return undefined;
  }
  // A function-like owner that is also a parameter's parent is handled through
  // the parameter owners; here we cover return types and variables/members.
  if (ts.isParameter(owner)) {
    const fn = owner.parent;
    const fnName = functionName(fn);
    if (fnName === undefined) {
      return undefined;
    }
    const index = fn.parameters.indexOf(owner);
    const sig = provider.functions.get(fnName) ?? memberSignature(provider, fn);
    if (sig === undefined || index < 0 || index >= sig.params.length) {
      return undefined;
    }
    const param = sig.params[index];
    if (param === undefined) {
      return undefined;
    }
    return param.type;
  }

  if (ts.isVariableDeclaration(owner) && ts.isIdentifier(owner.name)) {
    return provider.variables.get(owner.name.text);
  }

  if (isClassMember(owner) && owner.name !== undefined && ts.isIdentifier(owner.name)) {
    const parent = owner.parent;
    if (ts.isClassDeclaration(parent) && parent.name !== undefined) {
      const value = provider.members.get(`${parent.name.text}.${owner.name.text}`);
      if (value === undefined) {
        return undefined;
      }
      return typeof value === 'string' ? value : value.returnType;
    }
  }

  // Function-like owner: the `any` may be its return-type annotation. Only use
  // the d.ts return type when the owner has a concrete name (avoid guessing for
  // anonymous callbacks).
  if (isFunctionLikeNode(owner)) {
    const fnName = functionName(owner);
    if (fnName === undefined) {
      return undefined;
    }
    const sig = provider.functions.get(fnName) ?? memberSignature(provider, owner);
    if (sig?.returnType === undefined) {
      return undefined;
    }
    return sig.returnType;
  }

  return undefined;
}

function memberSignature(
  provider: DeclarationProvider,
  node: ts.Node,
): DtsSignature | undefined {
  if (isClassMember(node) && node.name !== undefined && ts.isIdentifier(node.name)) {
    const parent = node.parent;
    if (ts.isClassDeclaration(parent) && parent.name !== undefined) {
      const value = provider.members.get(`${parent.name.text}.${node.name.text}`);
      if (value !== undefined && typeof value !== 'string') {
        return value;
      }
    }
  }
  return undefined;
}

function functionName(node: ts.Node): string | undefined {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isFunctionExpression(node)) &&
    node.name !== undefined &&
    ts.isIdentifier(node.name)
  ) {
    return node.name.text;
  }
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent)) {
    const name = node.parent.name;
    return ts.isIdentifier(name) ? name.text : undefined;
  }
  return undefined;
}

function declarationName(node: ts.Node): ts.Node | undefined {
  if ('name' in node && node.name !== undefined) {
    return node.name as ts.Node;
  }
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent)) {
    return node.parent.name;
  }
  return undefined;
}

/** Walk from a parameter/expression to the declaration that carries export info. */
function declarationTarget(node: ts.Node): ts.Node | undefined {
  if (ts.isParameter(node) || isClassMember(node) || isFunctionLikeNode(node)) {
    return node;
  }
  return undefined;
}

/** For arrow/function expressions, the export modifier lives on the variable. */
function enclosingNamedDeclaration(node: ts.Node): ts.Node | undefined {
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent)) {
    const list = node.parent.parent;
    if (ts.isVariableDeclarationList(list) && ts.isVariableStatement(list.parent)) {
      return list.parent;
    }
    return node.parent;
  }
  return node;
}

function isFunctionLikeNode(node: ts.Node): node is ts.SignatureDeclaration {
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

function isClassMember(
  node: ts.Node,
): node is ts.MethodDeclaration | ts.PropertyDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration {
  return (
    ts.isMethodDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/** Detect CommonJS exports by scanning the source file's top-level statements. */
function isCommonJsExported(node: ts.Node): boolean {
  const nameNode = declarationName(node);
  if (nameNode === undefined || !ts.isIdentifier(nameNode)) {
    return false;
  }
  const name = nameNode.text;
  const sourceFile = node.getSourceFile();
  for (const statement of sourceFile.statements) {
    // exports.X = ... / module.exports.X = ...
    if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)) {
      const bin = statement.expression;
      if (bin.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
        continue;
      }
      const left = bin.left;
      if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.name) && left.name.text === name) {
        const root = left.expression;
        if (ts.isIdentifier(root) && root.text === 'exports') {
          return true;
        }
        if (
          ts.isPropertyAccessExpression(root) &&
          ts.isIdentifier(root.expression) &&
          root.expression.text === 'module' &&
          root.name.text === 'exports'
        ) {
          return true;
        }
      }
      // module.exports = { X, Y } / exports = { X }
      if (ts.isObjectLiteralExpression(bin.right)) {
        const target = bin.left;
        const isModuleExports =
          (ts.isPropertyAccessExpression(target) &&
            ts.isIdentifier(target.expression) &&
            target.expression.text === 'module' &&
            target.name.text === 'exports') ||
          (ts.isIdentifier(target) && target.text === 'exports');
        if (isModuleExports) {
          for (const prop of bin.right.properties) {
            if (
              ts.isShorthandPropertyAssignment(prop) &&
              ts.isIdentifier(prop.name) &&
              prop.name.text === name
            ) {
              return true;
            }
            if (
              ts.isPropertyAssignment(prop) &&
              ts.isIdentifier(prop.name) &&
              prop.name.text === name
            ) {
              return true;
            }
          }
        }
      }
    }
  }
  return false;
}
