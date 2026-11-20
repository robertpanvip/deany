import * as ts from 'typescript';

import type { InferenceContext } from './types.js';
import type { ImplicitPredicate } from './implicitPredicate.js';
import { isFunctionLike } from './util.js';

/**
 * One value exported by a module, paired with the declaration whose inferred
 * signature describes it. `name` is the property name under which the caller
 * sees the value (`guard.isObject`); `declaration` is the function/variable
 * node inside the required file that produces it.
 */
interface ModuleExport {
  readonly name: string;
  readonly declaration: ts.Node;
}

/**
 * A CommonJS module may export a single value directly (`module.exports = fn`)
 * rather than an object of named exports. In that case the requiring binding
 * *is* the function, not a namespace object.
 */
interface ModuleExports {
  readonly named: readonly ModuleExport[];
  readonly direct?: ts.Node;
}

/** Resolve the declaration a value expression was bound from. */
function declarationOfValue(value: ts.Expression, checker: ts.TypeChecker): ts.Node | undefined {
  const bare = value;
  if (ts.isShorthandPropertyAssignment(bare.parent) && bare.parent.name === bare) {
    const symbol = checker.getShorthandAssignmentValueSymbol(bare.parent);
    return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  }
  let symbol = checker.getSymbolAtLocation(bare);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
}

/**
 * Enumerate a required module's runtime exports from its source. Handles the
 * shapes deany actually converts:
 *   - `module.exports = { a, b: c }` (object literal, shorthand + named)
 *   - `exports.a = ...` / `module.exports.a = ...`
 *   - `module.exports = fn` / `module.exports = <identifier>` (direct export)
 *   - ESM `export function a` / `export const a = ...`
 */
function moduleExportsOf(sourceFile: ts.SourceFile, checker: ts.TypeChecker): ModuleExports {
  const named: ModuleExport[] = [];
  let direct: ts.Node | undefined;

  const addFromObject = (expr: ts.Expression): void => {
    if (!ts.isObjectLiteralExpression(expr)) return;
    for (const prop of expr.properties) {
      if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
      const name = prop.name.getText();
      const value: ts.Expression = ts.isShorthandPropertyAssignment(prop) ? prop.name : prop.initializer;
      const declaration = declarationOfValue(value, checker);
      if (declaration !== undefined) named.push({ name, declaration });
    }
  };

  for (const statement of sourceFile.statements) {
    // ESM named exports.
    if ((ts.isFunctionDeclaration(statement) || ts.isVariableStatement(statement)) &&
        statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      if (ts.isFunctionDeclaration(statement)) {
        const name = statement.name?.text;
        if (name !== undefined) named.push({ name, declaration: statement });
      } else {
        for (const decl of statement.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) named.push({ name: decl.name.text, declaration: decl });
        }
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      if (ts.isIdentifier(statement.expression)) {
        direct = declarationOfValue(statement.expression, checker) ?? statement.expression;
      } else {
        direct = statement.expression;
      }
      continue;
    }
    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) continue;
    const bin = statement.expression;
    if (bin.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
    const left = bin.left;
    if (ts.isPropertyAccessExpression(left)) {
      const leftText = left.getText();
      if (leftText === 'module.exports') {
        if (ts.isObjectLiteralExpression(bin.right)) {
          addFromObject(bin.right);
        } else {
          direct = ts.isIdentifier(bin.right)
            ? (declarationOfValue(bin.right, checker) ?? bin.right)
            : bin.right;
        }
      } else if (leftText === 'exports' || left.name.text !== undefined) {
        // `exports.foo = ...` or `module.exports.foo = ...`
        const isExportsRoot = ts.isIdentifier(left.expression) && left.expression.text === 'exports';
        const isModuleExportsRoot = ts.isPropertyAccessExpression(left.expression) &&
          left.expression.getText() === 'module.exports';
        if (isExportsRoot || isModuleExportsRoot) {
          const declaration = declarationOfValue(bin.right, checker);
          if (declaration !== undefined) named.push({ name: left.name.text, declaration });
        }
      }
    }
  }
  return { named, direct };
}

/** Render a function-like declaration as an inline function type, preserving
 * any inferred type predicate so callers still narrow across the file boundary. */
function functionTypeOf(
  declaration: ts.SignatureDeclaration & { readonly parameters: readonly ts.ParameterDeclaration[] },
  ctx: InferenceContext,
  predicates: ReadonlyMap<ts.SignatureDeclaration, readonly ImplicitPredicate[]>,
): string {
  const declared = predicates.get(declaration) ?? [];
  const strongest = declared.reduce<ImplicitPredicate | undefined>(
    (best, p) => best === undefined || p.strength > best.strength ? p : best,
    undefined,
  );
  const params = declaration.parameters.map((param, index) => {
    const name = param.name.getText();
    const predicate = declared.find((p) => p.paramIndex === index);
    // A guarded parameter must stay wide for `param is T` to be legal; the
    // converter widens it to `unknown` too, so keep the two consistent.
    let type = predicate !== undefined
      ? 'unknown'
      : (ctx.table.declarations.get(param) ?? 'unknown');
    if (type === 'any') type = 'unknown';
    return `${name}: ${type}`;
  });
  const returnType = strongest !== undefined
    ? `${strongest.paramName} is ${strongest.narrowType}`
    : (ctx.table.returns.get(declaration) ?? 'unknown');
  return `(${params.join(', ')}) => ${returnType}`;
}

/** Inline type text for one exported declaration. */
function exportTypeOf(
  declaration: ts.Node,
  ctx: InferenceContext,
  predicates: ReadonlyMap<ts.SignatureDeclaration, readonly ImplicitPredicate[]>,
): string {
  if (isFunctionLike(declaration)) {
    return functionTypeOf(declaration as ts.SignatureDeclaration & { readonly parameters: readonly ts.ParameterDeclaration[] }, ctx, predicates);
  }
  return ctx.table.declarations.get(declaration) ?? 'unknown';
}

function safeKey(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

/**
 * Build a self-contained object/function type for a relative CommonJS
 * `require('./mod')` call by reading the required file's exports from the same
 * program and reusing deany's inferred signatures (including implicit type
 * predicates). The emitted text inlines the shape, so strict-checking the
 * converted caller works without the sibling file being present at check time.
 *
 * Returns undefined for non-relative specifiers, unresolved modules, or
 * modules with no discoverable exports — those keep the existing behaviour.
 */
export function moduleNamespaceType(
  requireCall: ts.CallExpression,
  ctx: InferenceContext,
  predicates: ReadonlyMap<ts.SignatureDeclaration, readonly ImplicitPredicate[]>,
): string | undefined {
  if (!ts.isIdentifier(requireCall.expression) || requireCall.expression.text !== 'require') return undefined;
  const arg = requireCall.arguments[0];
  if (arg === undefined || !ts.isStringLiteralLike(arg)) return undefined;
  const spec = arg.text;
  if (spec.length === 0 || (!spec.startsWith('.') && !spec.startsWith('/'))) return undefined;

  const containingFile = requireCall.getSourceFile().fileName;
  const resolved = ts.resolveModuleName(
    spec,
    containingFile,
    ctx.program.getCompilerOptions(),
    ts.sys,
  ).resolvedModule;
  if (resolved === undefined) return undefined;
  const target = ctx.program.getSourceFile(resolved.resolvedFileName);
  if (target === undefined) return undefined;

  const exports = moduleExportsOf(target, ctx.checker);
  if (exports.direct !== undefined && exports.named.length === 0) {
    return exportTypeOf(exports.direct, ctx, predicates);
  }
  if (exports.named.length === 0) return undefined;
  const fields = exports.named.map((e) => `${safeKey(e.name)}: ${exportTypeOf(e.declaration, ctx, predicates)};`);
  return `{ ${fields.join(' ')} }`;
}
