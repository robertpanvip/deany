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

  // 1b) An anonymous function/class expression used directly as the default
  // export (`export default (v) => ...`, `export default function(){}`). The
  // `export`/`default` modifier lives on the parent ExportAssignment, not on
  // the expression, so the modifier check above cannot see it. (Arch review 2.7.)
  if (isDefaultExportExpression(target)) {
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
    return isCommonJsExported(target, checker);
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
  return isCommonJsExported(target, checker);
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
  checker?: ts.TypeChecker,
): string | undefined {
  if (provider === undefined) {
    return undefined;
  }
  // A function-like owner that is also a parameter's parent is handled through
  // the parameter owners; here we cover return types and variables/members.
  if (ts.isParameter(owner)) {
    const fn = owner.parent;
    // A sibling `.d.ts` describes the MODULE'S PUBLIC CONTRACT. A private,
    // same-named inner function (`function internal(){ function process(){} }`)
    // is not that contract, so a name match alone must not apply its signature.
    // Gate on export status (symbol-backed) before consulting the d.ts.
    // (Architecture review 1.3.)
    if (checker !== undefined && !isExportedDeclaration(fn, checker)) {
      return undefined;
    }
    // Constructors have no function name; signatureFor() handles them via the
    // `Class.constructor` member key, so a placeholder name is sufficient.
    const fnName = ts.isConstructorDeclaration(fn) ? 'constructor' : functionName(fn);
    if (fnName === undefined) {
      return undefined;
    }
    const index = fn.parameters.indexOf(owner);
    const sig = signatureFor(provider, fn, fnName);
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
  // anonymous callbacks) and is actually exported (see the parameter branch).
  if (isFunctionLikeNode(owner)) {
    if (checker !== undefined && !isExportedDeclaration(owner, checker)) {
      return undefined;
    }
    const fnName = functionName(owner);
    if (fnName === undefined) {
      return undefined;
    }
    const sig = signatureFor(provider, owner, fnName);
    if (sig?.returnType === undefined) {
      return undefined;
    }
    return sig.returnType;
  }

  return undefined;
}

/**
 * When a sibling `.d.ts` declares a generic signature (e.g. `id<T>(x: T): T`),
 * its type parameters are used to fill the implementation's `any` slots. But
 * the implementation itself was written without `<T>`, so the filled slots
 * reference an undeclared name (TS2304). This reports where to inject the
 * type-parameter list onto the function signature, once per function.
 *
 * Only fires when: the owner is a signature slot (parameter or function return),
 * the function is exported (d.ts is a public contract), the d.ts signature
 * actually has type params, and the declared slot text references one of them
 * (so we never inject an unused `<T>`).
 */
export interface GenericParamInsertion {
  readonly typeParams: string;
  readonly insertPos: number;
}

export function dtsGenericParamInsertionFor(
  owner: ts.Node,
  provider: DeclarationProvider | undefined,
  checker: ts.TypeChecker,
): GenericParamInsertion | undefined {
  if (provider === undefined) {
    return undefined;
  }
  let fn: ts.Node | undefined;
  if (ts.isParameter(owner)) {
    fn = owner.parent;
  } else if (isFunctionLikeNode(owner)) {
    fn = owner;
  } else {
    return undefined;
  }
  if (fn === undefined || !isFunctionLikeNode(fn)) {
    return undefined;
  }
  // Already generic in the source — do not inject a duplicate list.
  if (fn.typeParameters !== undefined && fn.typeParameters.length > 0) {
    return undefined;
  }
  if (!isExportedDeclaration(fn, checker)) {
    return undefined;
  }
  const fnName = functionName(fn);
  if (fnName === undefined) {
    return undefined;
  }
  const sig = signatureFor(provider, fn, fnName);
  const typeParams = sig?.typeParams;
  if (typeParams === undefined) {
    return undefined;
  }
  // The slot this `any` occupies must actually use a declared type parameter.
  const declared = declaredTypeOf(owner, provider, checker);
  if (declared === undefined) {
    return undefined;
  }
  const names = typeParams
    .slice(1, -1)
    .split(',')
    .map((part) => part.trim().match(/^[A-Za-z_$][\w$]*/)?.[0])
    .filter((name): name is string => name !== undefined);
  if (!names.some((name) => new RegExp(`\\b${name}\\b`).test(declared))) {
    return undefined;
  }
  // Insert just after a named function's name, or before an arrow/anonymous
  // function's parameter list.
  const insertPos =
    'name' in fn && fn.name !== undefined && ts.isIdentifier(fn.name)
      ? fn.name.end
      : fn.getStart();
  return { typeParams, insertPos };
}

/**
 * Resolve the d.ts signature for a function-like declaration. A class method
 * must match `Class.member` — it must NEVER fall back to a same-named top-level
 * function (`provider.functions.get(fnName)`), or a `Worker.process` would pick
 * up a free `process(value: string)` contract meant for a different symbol.
 * Only genuinely top-level functions consult `functions` (Architecture review 3).
 */
function signatureFor(
  provider: DeclarationProvider,
  node: ts.Node,
  fnName: string,
): DtsSignature | undefined {
  // A constructor has no `name`, so memberSignature cannot handle it. Match
  // the `Class.constructor` key collected by parseDeclarationFile instead.
  if (ts.isConstructorDeclaration(node)) {
    const parent = node.parent;
    if (ts.isClassDeclaration(parent) && parent.name !== undefined) {
      const value = provider.members.get(`${parent.name.text}.constructor`);
      return typeof value === 'string' ? undefined : value;
    }
    return undefined;
  }
  if (isClassMember(node)) {
    return memberSignature(provider, node);
  }
  return provider.functions.get(fnName);
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
  if (
    ts.isParameter(node) ||
    isClassMember(node) ||
    isFunctionLikeNode(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  ) {
    return node;
  }
  return undefined;
}

/**
 * True when `node` is a function-like/class expression that is itself the
 * default-exported value (`export default (v) => ...`). `isExportEquals`
 * distinguishes `export default X` from the CommonJS `export = X` form.
 */
function isDefaultExportExpression(node: ts.Node): boolean {
  if (
    !ts.isArrowFunction(node) &&
    !ts.isFunctionExpression(node) &&
    !ts.isClassExpression(node)
  ) {
    return false;
  }
  // Track the OUTERMOST transparent wrapper around the expression: for
  // `export default ((v) => ...)`, the ExportAssignment's `.expression` is a
  // ParenthesizedExpression, not the arrow itself. Compare against that
  // wrapper rather than the raw node. (Line-by-line review bug B4.)
  let exported: ts.Node = node;
  let current: ts.Node | undefined = node.parent;
  while (
    current !== undefined &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current))
  ) {
    exported = current;
    current = current.parent;
  }
  return (
    current !== undefined &&
    ts.isExportAssignment(current) &&
    !current.isExportEquals &&
    current.expression === exported
  );
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
): node is ts.MethodDeclaration | ts.PropertyDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration | ts.ConstructorDeclaration {
  return (
    ts.isMethodDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    // A constructor of an exported class is public API: its parameter types
    // form the construction contract for external callers, so S4 must protect
    // them from internal `new C(...)` call-site narrowing. Private/protected
    // constructors are filtered out by the modifier check in the caller.
    // (Architecture review 2.5.)
    ts.isConstructorDeclaration(node)
  );
}

/**
 * Detect CommonJS exports by scanning the source file's top-level statements.
 *
 * The identity of the *exported value* comes from the right-hand side of an
 * assignment, not from the property name on the left. For
 * `exports.foo = implementation` the declaration that becomes public is
 * `implementation`, never a different function merely named `foo`.
 * Symbol identity is preferred; a name comparison is kept only as a fallback
 * for module configs where the checker does not bind CommonJS symbols.
 * (Architecture review 2.6.)
 */
function isCommonJsExported(node: ts.Node, checker: ts.TypeChecker): boolean {
  const nameNode = declarationName(node);
  if (nameNode === undefined || !ts.isIdentifier(nameNode)) {
    return false;
  }
  const name = nameNode.text;
  const nodeSymbol = symbolOfName(nameNode, checker);
  const sourceFile = node.getSourceFile();

  const sameSymbol = (exprSymbol: ts.Symbol | undefined, fallbackName: string): boolean => {
    if (nodeSymbol !== undefined && exprSymbol !== undefined) {
      return nodeSymbol === exprSymbol;
    }
    // Fallback when the checker cannot bind one side: compare spellings.
    return fallbackName === name;
  };
  const sameDeclaration = (expr: ts.Expression, fallbackName: string): boolean =>
    sameSymbol(symbolOfAssignedValue(expr, checker), fallbackName);

  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) {
      continue;
    }
    const bin = statement.expression;
    if (bin.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
      continue;
    }
    const left = bin.left;
    // exports.X = ... / module.exports.X = ...
    if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.name)) {
      const root = left.expression;
      const isExports =
        (ts.isIdentifier(root) && root.text === 'exports') ||
        (ts.isPropertyAccessExpression(root) &&
          ts.isIdentifier(root.expression) &&
          root.expression.text === 'module' &&
          root.name.text === 'exports');
      if (isExports && sameDeclaration(bin.right, left.name.text)) {
        return true;
      }
    }
    // module.exports = { X, Y } / exports = { ... }
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
          // `{ foo }` — the value is the identifier `foo` itself. Use the
          // dedicated API: getSymbolAtLocation on a shorthand name returns the
          // property symbol in some module configs, not the bound variable.
          if (ts.isShorthandPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
            if (sameSymbol(checker.getShorthandAssignmentValueSymbol(prop), prop.name.text)) {
              return true;
            }
          }
          // `{ publicName: implementation }` — the value is the RHS expression.
          if (ts.isPropertyAssignment(prop)) {
            const keyText = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)
              ? prop.name.text
              : undefined;
            if (keyText !== undefined && sameDeclaration(prop.initializer, keyText)) {
              return true;
            }
          }
        }
      }
    }
  }
  return false;
}

/** Resolve the symbol a declaration name binds to, following aliases. */
function symbolOfName(name: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(name);
  if (symbol === undefined) {
    return undefined;
  }
  return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

/** Resolve the symbol of an assigned RHS expression (identifier or function name). */
function symbolOfAssignedValue(expr: ts.Expression, checker: ts.TypeChecker): ts.Symbol | undefined {
  if (ts.isIdentifier(expr)) {
    return symbolOfName(expr, checker);
  }
  if (
    (ts.isFunctionExpression(expr) || ts.isClassExpression(expr)) &&
    expr.name !== undefined
  ) {
    return symbolOfName(expr.name, checker);
  }
  return undefined;
}
