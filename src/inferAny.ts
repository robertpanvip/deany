import * as path from 'node:path';
import * as ts from 'typescript';
import { hasTopLevelArrow } from './normalize.js';

export interface InferAnyOptions {
  /** Report ambiguous sites instead of silently leaving them untouched. */
  readonly reportAmbiguous: boolean;
  /** Also consider `as any` / `<any>x` assertions. */
  readonly includeAssertions: boolean;
}

export const DEFAULT_INFER_OPTIONS: InferAnyOptions = {
  reportAmbiguous: true,
  includeAssertions: false,
};

export interface AnySite {
  readonly file: string;
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly original: string;
  readonly inferred?: string;
  readonly reason?: string;
}

export interface InferFileResult {
  readonly fileName: string;
  readonly output: string;
  readonly sites: readonly AnySite[];
}

const TYPE_FORMAT =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseFullyQualifiedType |
  ts.TypeFormatFlags.WriteArrayAsGenericType;

type FunctionLikeWithBody =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLikeWithBody {
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

/** True only if the single matching paren for index 0 closes at the very end. */
function wrappedInOuterParens(type: string): boolean {
  if (!type.startsWith('(') || !type.endsWith(')')) {
    return false;
  }
  let depth = 0;
  for (let i = 0; i < type.length; i += 1) {
    const ch = type[i] ?? '';
    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        return i === type.length - 1;
      }
    }
  }
  return false;
}

/** Parenthesize a composite (union/intersection) type when used as a nested type. */
function parenthesizeIfComposite(type: string): string {
  if (type.includes('|') || type.includes('&')) {
    if (wrappedInOuterParens(type)) {
      return type;
    }
    return `(${type})`;
  }
  return type;
}

/**
 * Find the declaration that owns a type annotation containing `any`.
 * Walking upward handles `any[]`, `Array<any>`, `Map<string, any>`, etc.
 */
function ownerOf(anyNode: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = anyNode.parent;
  while (current !== undefined) {
    if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
      return undefined;
    }
    if (
      ts.isVariableDeclaration(current) ||
      ts.isParameter(current) ||
      ts.isPropertyDeclaration(current) ||
      ts.isPropertySignature(current) ||
      isFunctionLike(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * The structural position of an `any` token inside its type annotation, as a
 * sequence of type-argument indices from the outside in. Examples:
 *   `let x: any`                 -> []       (the whole type)
 *   `let a: any[]`               -> [0]      (array element)
 *   `let m: Map<string, any>`    -> [1]      (second type argument)
 *   `let g: Array<Map<string, any>>` -> [0, 1]
 * Walking stops as soon as a non-generic type node (or the declaration) is hit.
 */
function slotPathOf(anyNode: ts.Node): number[] {
  const path: number[] = [];
  let current: ts.Node = anyNode;
  let parent: ts.Node | undefined = current.parent;
  while (parent !== undefined) {
    if (ts.isArrayTypeNode(parent) && parent.elementType === current) {
      path.unshift(0);
    } else if (ts.isTypeReferenceNode(parent) && parent.typeArguments !== undefined) {
      const index = parent.typeArguments.indexOf(current as ts.TypeNode);
      if (index < 0) {
        break;
      }
      path.unshift(index);
    } else {
      break;
    }
    current = parent;
    parent = current.parent;
  }
  return path;
}

/**
 * Split `Name<A, B>` into its top-level type arguments, honoring nested
 * generics and delimiter pairs. Returns undefined when `type` has no trailing
 * generic argument list (i.e. it is not a `Name<...>` form).
 */
function splitTypeArguments(type: string): string[] | undefined {
  const text = type.trim();
  const open = text.indexOf('<');
  if (open <= 0) {
    return undefined;
  }
  let depth = 0;
  let close = -1;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i] ?? '';
    if (ch === '<') {
      depth += 1;
    } else if (ch === '>') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close !== text.length - 1) {
    return undefined;
  }
  const inner = text.slice(open + 1, close);
  const parts: string[] = [];
  let generic = 0;
  let delimiter = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i] ?? '';
    if (ch === '<') {
      generic += 1;
    } else if (ch === '>') {
      generic -= 1;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      delimiter += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      delimiter -= 1;
    } else if (ch === ',' && generic === 0 && delimiter === 0) {
      parts.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(inner.slice(start).trim());
  return parts;
}

/**
 * Project an inferred whole value type onto the slot an `any` token occupies.
 * `Array<number>` projected by [0] yields `number`; a scalar type projected by
 * a non-empty path (e.g. a function whose `Promise<any>` return was inferred
 * from a bare `return 1`) cannot be projected, so the whole type is returned —
 * that scalar is already aligned with the slot. `never` is returned as-is so
 * the caller can treat it as "no element evidence" (empty array).
 */
function projectSlotType(fullType: string, path: readonly number[]): string {
  if (path.length === 0) {
    return fullType;
  }
  let current = fullType.trim();
  for (const index of path) {
    if (current.endsWith('[]')) {
      current = current.slice(0, -2).trim();
      continue;
    }
    const args = splitTypeArguments(current);
    if (args === undefined) {
      return fullType;
    }
    const picked = args[index];
    if (picked === undefined) {
      return fullType;
    }
    current = picked;
  }
  return current;
}

function symbolOf(owner: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  if (
    ts.isVariableDeclaration(owner) ||
    ts.isParameter(owner) ||
    ts.isPropertyDeclaration(owner) ||
    ts.isPropertySignature(owner)
  ) {
    return checker.getSymbolAtLocation(owner.name);
  }
  return undefined;
}

/** Widen a literal type (`42` -> `number`, `'a'` -> `string`) and print it. */
function widenedTypeText(checker: ts.TypeChecker, type: ts.Type, node: ts.Node): string {
  if (type.isUnion()) {
    const parts = type.types.map((part) => {
      const text = widenedTypeText(checker, part, node);
      // A bare function type is illegal as a union member without parentheses.
      return hasTopLevelArrow(text) ? `(${text})` : text;
    });
    return [...new Set(parts)].join(' | ');
  }
  if (type.flags & ts.TypeFlags.StringLiteral) {
    return 'string';
  }
  if (type.flags & ts.TypeFlags.NumberLiteral) {
    return 'number';
  }
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    return 'boolean';
  }
  if (type.flags & ts.TypeFlags.BigIntLiteral) {
    return 'bigint';
  }
  return checker.typeToString(type, node, TYPE_FORMAT).trim();
}

/**
 * The fixed-point inference table. `declarations` holds the inferred type of a
 * value binding (variable / parameter / property); `returns` holds the inferred
 * return type of a function-like declaration. Nodes are used directly as keys
 * because they are identity-stable within a single `ts.Program`.
 */
interface InferenceTable {
  readonly declarations: Map<ts.Node, string>;
  readonly returns: Map<ts.Node, string>;
  /** Owners inferred only from weak (property-shape) evidence; re-evaluated. */
  readonly weakOwners: Set<ts.Node>;
}

function createTable(): InferenceTable {
  return { declarations: new Map(), returns: new Map(), weakOwners: new Set() };
}

interface InferenceContext {
  readonly checker: ts.TypeChecker;
  readonly program: ts.Program;
  readonly table: InferenceTable;
  readonly referenceCache: Map<ts.Symbol, ts.Identifier[]>;
  readonly callCache: Map<ts.SignatureDeclaration, ts.CallExpression[]>;
}

function createContext(
  checker: ts.TypeChecker,
  program: ts.Program,
  table: InferenceTable,
): InferenceContext {
  return {
    checker,
    program,
    table,
    referenceCache: new Map(),
    callCache: new Map(),
  };
}

/** Table lookup for a node whose checker type is `any`. This is the positive
 * propagation edge: a call resolves to a callee's inferred return type, and an
 * identifier resolves to a binding's inferred type. */
function resolveViaTable(ctx: InferenceContext, node: ts.Node): string | undefined {
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    const declaration = ctx.checker.getResolvedSignature(node)?.declaration;
    if (declaration !== undefined) {
      return ctx.table.returns.get(declaration);
    }
    return undefined;
  }
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
    let symbol = ctx.checker.getSymbolAtLocation(node);
    if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      const aliased = ctx.checker.getAliasedSymbol(symbol);
      if (aliased !== undefined) {
        symbol = aliased;
      }
    }
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (declaration !== undefined) {
      return ctx.table.declarations.get(declaration);
    }
  }
  return undefined;
}

function typeText(
  ctx: InferenceContext,
  node: ts.Node,
  type?: ts.Type,
): string | undefined {
  const raw = type ?? ctx.checker.getTypeAtLocation(node);
  const widened = ctx.checker.getWidenedType(raw);
  if (widened.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) {
    return resolveViaTable(ctx, node);
  }
  const text = widenedTypeText(ctx.checker, widened, node);
  if (text.length === 0 || text === 'any' || text === 'unknown') {
    return resolveViaTable(ctx, node);
  }
  return text;
}

/** Recognize arithmetic expressions that imply a numeric operand type in JS. */
function arithmeticNumberType(
  ctx: InferenceContext,
  expression: ts.Expression,
): string | undefined {
  if (!ts.isBinaryExpression(expression)) {
    return undefined;
  }
  const operator = expression.operatorToken.kind;
  const arithmetic =
    operator === ts.SyntaxKind.PlusToken ||
    operator === ts.SyntaxKind.MinusToken ||
    operator === ts.SyntaxKind.AsteriskToken ||
    operator === ts.SyntaxKind.SlashToken ||
    operator === ts.SyntaxKind.PercentToken;
  if (!arithmetic) {
    return undefined;
  }
  if (
    typeText(ctx, expression.left) === 'number' ||
    typeText(ctx, expression.right) === 'number'
  ) {
    return 'number';
  }
  return undefined;
}

function symbolTypeText(
  ctx: InferenceContext,
  symbol: ts.Symbol,
  location: ts.Node,
): string | undefined {
  return typeText(ctx, location, ctx.checker.getTypeOfSymbolAtLocation(symbol, location));
}

function nonDeclarationFiles(program: ts.Program): ts.SourceFile[] {
  return program.getSourceFiles().filter((sourceFile) => !sourceFile.isDeclarationFile);
}

/** All identifier references to `symbol`, across the whole program (cached). */
function referencesOf(symbol: ts.Symbol, ctx: InferenceContext): ts.Identifier[] {
  const cached = ctx.referenceCache.get(symbol);
  if (cached !== undefined) {
    return cached;
  }
  const references: ts.Identifier[] = [];
  for (const sourceFile of nonDeclarationFiles(ctx.program)) {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === symbol.getName()) {
        let found = ctx.checker.getSymbolAtLocation(node);
        if (found !== undefined && (found.flags & ts.SymbolFlags.Alias) !== 0) {
          found = ctx.checker.getAliasedSymbol(found);
        }
        if (found === symbol) {
          references.push(node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  ctx.referenceCache.set(symbol, references);
  return references;
}

/** Call sites whose resolved signature belongs to `declaration` (cached). */
function callsOf(
  declaration: ts.SignatureDeclaration,
  ctx: InferenceContext,
): ts.CallExpression[] {
  const cached = ctx.callCache.get(declaration);
  if (cached !== undefined) {
    return cached;
  }
  const calls: ts.CallExpression[] = [];
  for (const sourceFile of nonDeclarationFiles(ctx.program)) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const signature = ctx.checker.getResolvedSignature(node);
        if (signature?.declaration === declaration) {
          calls.push(node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  ctx.callCache.set(declaration, calls);
  return calls;
}

/**
 * Usage evidence is split by variance:
 * - `sources` are covariant (values the binding receives: initializers,
 *   assignments, returns, arithmetic). Multiple sources form a union.
 * - `constraints` are contravariant (types the binding must be assignable to,
 *   e.g. when passed as a call argument). Multiple constraints are intersected.
 * - `properties` describe an object's shape, used only as a last-resort source.
 */
interface Evidence {
  readonly sources: string[];
  readonly constraints: string[];
  readonly properties: Map<string, string>;
}

function emptyEvidence(): Evidence {
  return { sources: [], constraints: [], properties: new Map<string, string>() };
}

function addSource(evidence: Evidence, type: string | undefined): void {
  if (type !== undefined) {
    evidence.sources.push(type);
  }
}

function addConstraint(evidence: Evidence, type: string | undefined): void {
  if (type !== undefined) {
    evidence.constraints.push(type);
  }
}

/**
 * `Array.isArray(x)` is a type guard narrowing `x` to an array. Recognize the
 * call by its callee text so it can be a covariant source for the binding.
 */
function isArrayIsArrayCall(call: ts.CallExpression): boolean {
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.expression.getText(call.getSourceFile()) === 'Array' &&
    call.expression.name.text === 'isArray'
  );
}

/**
 * Instance type produced by `x instanceof Ctor`, or undefined if the right
 * operand has no usable class/function symbol (e.g. a complex expression).
 */
/**
 * For `x instanceof Ctor`, checker's declared type of a generic class leaks
 * uninstantiated type parameters (`Map<K, V>`, `Set<T>`) which produce TS2304
 * when written back. Prefer the construct signature's return type (already
 * instantiated, e.g. `Map<any, any>`), then normalize both `any` slots and any
 * remaining bare single-letter parameters to `unknown` — the element type is
 * genuinely unknown from an instanceof check alone.
 */
function sanitizeInstanceType(text: string): string {
  let result = text;
  result = result.replace(/<([A-Z](?:\s*,\s*[A-Z])*)>/g, (_m, inner: string) => {
    const args = inner.split(',').map((part) => part.trim());
    return args.every((part) => /^[A-Z]$/.test(part))
      ? `<${args.map(() => 'unknown').join(', ')}>`
      : _m;
  });
  // `Map<any, any>` from a construct signature: an `any` slot from instanceof
  // carries no real information, so use `unknown` to keep strict soundness.
  result = result.replace(/\bany\b/g, 'unknown');
  return result;
}

function instanceTypeOf(
  ctx: InferenceContext,
  right: ts.Expression,
): string | undefined {
  let symbol = ctx.checker.getSymbolAtLocation(right);
  if (symbol === undefined) {
    return undefined;
  }
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    const resolved = ctx.checker.getAliasedSymbol(symbol);
    if (resolved !== undefined) {
      symbol = resolved;
    }
  }
  // Prefer the instantiated instance type from the construct signature.
  const rightType = ctx.checker.getTypeAtLocation(right);
  const constructReturn = rightType.getConstructSignatures()[0]?.getReturnType();
  const instance = constructReturn ?? (symbol === undefined ? undefined : ctx.checker.getDeclaredTypeOfSymbol(symbol));
  if (instance === undefined) {
    return undefined;
  }
  const text = sanitizeInstanceType(ctx.checker.typeToString(instance, right, TYPE_FORMAT).trim());
  return text.length === 0 || text === 'any' || text === 'unknown' ? undefined : text;
}

/** Extract constraints from one reference to the `any`-typed binding. */
function constraintsFromReference(
  reference: ts.Identifier,
  ctx: InferenceContext,
  evidence: Evidence,
): void {
  const parent = reference.parent;

  if (
    ts.isBinaryExpression(parent) &&
    parent.left === reference &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    addSource(evidence, typeText(ctx, parent.right));
  }

  // A property access on the binding. If it is used as a call (`x.for(1)`),
  // record a callable signature so strict mode does not reject `x.for(...)`;
  // `unknown` would trigger TS18046 ("not callable"). A method signature, once
  // recorded, is never downgraded to a plain `unknown` by a later read.
  if (ts.isPropertyAccessExpression(parent) && parent.expression === reference) {
    const grandparent = parent.parent;
    const isMethodCall =
      ts.isCallExpression(grandparent) && grandparent.expression === parent;
    const METHOD_TYPE = '(...args: unknown[]) => unknown';
    const previous = evidence.properties.get(parent.name.text);
    if (isMethodCall || previous === METHOD_TYPE) {
      evidence.properties.set(parent.name.text, METHOD_TYPE);
    } else {
      evidence.properties.set(parent.name.text, typeText(ctx, parent) ?? 'unknown');
    }
  }

  // `this.field = expr` / `obj.field = expr`: the reference is the property name.
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.name === reference &&
    ts.isBinaryExpression(parent.parent) &&
    parent.parent.left === parent &&
    parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    addSource(evidence, typeText(ctx, parent.parent.right));
  }

  // `Array.isArray(x)` narrows x to an array. This is a covariant source for
  // the binding, not a normal call-argument constraint. `unknown[]` is used so
  // strict mode stays intact without inventing an element type.
  if (ts.isCallExpression(parent) && parent.arguments[0] === reference && isArrayIsArrayCall(parent)) {
    addSource(evidence, 'unknown[]');
  } else if (ts.isCallExpression(parent)) {
    const index = parent.arguments.indexOf(reference);
    if (index >= 0) {
      const signature = ctx.checker.getResolvedSignature(parent);
      const parameter = signature?.getParameters()[index];
      if (parameter !== undefined) {
        const parameterDecl = parameter.valueDeclaration ?? parameter.declarations?.[0];
        const inferred =
          parameterDecl === undefined ? undefined : ctx.table.declarations.get(parameterDecl);
        addConstraint(evidence, inferred ?? symbolTypeText(ctx, parameter, parent));
      }
    }
  }

  // `x instanceof Ctor` narrows x to the constructor's instance type.
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === reference &&
    parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
  ) {
    addSource(evidence, instanceTypeOf(ctx, parent.right));
  }

  if (
    ts.isBinaryExpression(parent) &&
    (parent.left === reference || parent.right === reference)
  ) {
    addSource(evidence, arithmeticNumberType(ctx, parent));
  }

  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
    if (
      parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken ||
      parent.operator === ts.SyntaxKind.PlusToken ||
      parent.operator === ts.SyntaxKind.MinusToken
    ) {
      addSource(evidence, 'number');
    }
  }

  if (ts.isTypeOfExpression(parent)) {
    // `typeof x === 'string'` is a useful hint but not authoritative.
    const binary = parent.parent;
    if (ts.isBinaryExpression(binary) && ts.isStringLiteral(binary.right)) {
      addSource(evidence, binary.right.text);
    }
  }
}

type MutationKind = 'collection' | 'map' | 'set';

/**
 * When an `any` occupies the mutable element/value slot of a container type
 * (`any[]`, `Array<any>`, `Map<K, any>`, `Set<any>`), mutations through that
 * binding are additional covariant sources for the slot type. Read-only
 * accesses (`a.length`, `a.map`) remain noise and are never used.
 */
function mutationKindOf(anyNode: ts.Node): MutationKind | undefined {
  const parent = anyNode.parent;
  if (ts.isArrayTypeNode(parent) && parent.elementType === anyNode) {
    return 'collection';
  }
  if (ts.isTypeReferenceNode(parent) && parent.typeArguments !== undefined) {
    const name = parent.typeName.getText();
    const index = parent.typeArguments.indexOf(anyNode as ts.TypeNode);
    if (index < 0) {
      return undefined;
    }
    if (name === 'Array' || name === 'ReadonlyArray') {
      return 'collection';
    }
    if ((name === 'Map' || name === 'ReadonlyMap' || name === 'WeakMap') && index === 1) {
      return 'map';
    }
    if ((name === 'Set' || name === 'ReadonlySet' || name === 'WeakSet') && index === 0) {
      return 'set';
    }
  }
  return undefined;
}

/**
 * Collect element/value types written into a container through its binding:
 * `push`/`unshift` and index assignment for arrays, `set(k, v)` for maps,
 * `add(v)` for sets. These are covariant sources for the `any` slot.
 */
function collectMutationEvidence(
  owner: ts.Node,
  kind: MutationKind,
  ctx: InferenceContext,
): string[] {
  const symbol = symbolOf(owner, ctx.checker);
  if (symbol === undefined) {
    return [];
  }
  const collected: string[] = [];
  const add = (node: ts.Expression | undefined): void => {
    const text = node === undefined ? undefined : typeText(ctx, node);
    if (text !== undefined) {
      collected.push(text);
    }
  };
  for (const ref of referencesOf(symbol, ctx)) {
    const parent = ref.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === ref) {
      const call = parent.parent;
      if (ts.isCallExpression(call) && call.expression === parent) {
        const method = parent.name.text;
        if (kind === 'collection' && (method === 'push' || method === 'unshift')) {
          for (const argument of call.arguments) {
            add(argument);
          }
        } else if (kind === 'map' && method === 'set') {
          add(call.arguments[1]);
        } else if (kind === 'set' && method === 'add') {
          add(call.arguments[0]);
        }
      }
    }
    // `a[i] = v`: the reference is the element-access base.
    if (
      kind === 'collection' &&
      ts.isElementAccessExpression(parent) &&
      parent.expression === ref
    ) {
      const binary = parent.parent;
      if (
        ts.isBinaryExpression(binary) &&
        binary.left === parent &&
        binary.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        add(binary.right);
      }
    }
  }
  return collected;
}

/** Collect type evidence for the declaration that owns an `any` annotation. */
function collectEvidence(owner: ts.Node, ctx: InferenceContext): Evidence {
  const evidence = emptyEvidence();

  if (
    ts.isVariableDeclaration(owner) ||
    ts.isPropertyDeclaration(owner) ||
    ts.isPropertySignature(owner)
  ) {
    if ('initializer' in owner && owner.initializer !== undefined) {
      addSource(evidence, typeText(ctx, owner.initializer));
    }
  }

  if (isFunctionLike(owner) && owner.body !== undefined) {
    const visit = (node: ts.Node): void => {
      if (isFunctionLike(node) && node !== owner) {
        return;
      }
      if (ts.isReturnStatement(node) && node.expression !== undefined) {
        addSource(
          evidence,
          typeText(ctx, node.expression) ?? arithmeticNumberType(ctx, node.expression),
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(owner.body);
  }

  const symbol = symbolOf(owner, ctx.checker);
  if (symbol !== undefined) {
    for (const reference of referencesOf(symbol, ctx)) {
      constraintsFromReference(reference, ctx, evidence);
    }
  }

  if (ts.isParameter(owner) && isFunctionLike(owner.parent)) {
    const functionNode = owner.parent;
    const index = functionNode.parameters.indexOf(owner);
    for (const call of callsOf(functionNode, ctx)) {
      const argument = call.arguments[index];
      if (argument !== undefined) {
        addSource(evidence, typeText(ctx, argument));
      }
    }
  }

  if (isFunctionLike(owner)) {
    for (const call of callsOf(owner, ctx)) {
      const parent = call.parent;
      if (ts.isVariableDeclaration(parent) && parent.initializer === call && ts.isIdentifier(parent.name)) {
        const symbol = ctx.checker.getSymbolAtLocation(parent.name);
        if (symbol !== undefined) {
          for (const reference of referencesOf(symbol, ctx)) {
            constraintsFromReference(reference, ctx, evidence);
          }
        }
      }
    }
  }

  return evidence;
}

/**
 * Split a type string on top-level `|`, honoring nested generics, parentheses,
 * braces and brackets so unions inside type arguments are left intact.
 */
function splitTopLevelUnion(type: string): string[] {
  const parts: string[] = [];
  let generic = 0;
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  let start = 0;
  for (let i = 0; i < type.length; i += 1) {
    const ch = type[i] ?? '';
    if (ch === '<') {
      generic += 1;
    } else if (ch === '>') {
      generic -= 1;
    } else if (ch === '(') {
      paren += 1;
    } else if (ch === ')') {
      paren -= 1;
    } else if (ch === '{') {
      brace += 1;
    } else if (ch === '}') {
      brace -= 1;
    } else if (ch === '[') {
      bracket += 1;
    } else if (ch === ']') {
      bracket -= 1;
    } else if (ch === '|' && generic === 0 && paren === 0 && brace === 0 && bracket === 0) {
      parts.push(type.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(type.slice(start).trim());
  return parts.filter((part) => part.length > 0);
}

/** Set intersection of top-level union members across several constraints. */
function intersectConstraints(constraints: readonly string[]): string[] | undefined {
  if (constraints.length === 0) {
    return undefined;
  }
  let acc: string[] | undefined;
  for (const constraint of constraints) {
    const members = splitTopLevelUnion(constraint);
    if (acc === undefined) {
      acc = members;
    } else {
      acc = acc.filter((member) => members.includes(member));
    }
  }
  return acc ?? [];
}

/**
 * Merge variance-tagged evidence into a single concrete type.
 *
 * Covariant `sources` (values the binding receives) form a union: a binding
 * seen as both `number` and `string` is genuinely `number | string`. Nested
 * unions are flattened, de-duplicated and sorted for deterministic output.
 *
 * Contravariant `constraints` (types the binding must satisfy, e.g. call
 * arguments) are intersected: a value passed to `f(number|string)` and
 * `g(boolean|string)` must be `string`. If both exist, sources are narrowed to
 * the members allowed by every constraint; when that leaves nothing the
 * (possibly over-narrow) sources win, since they are observed concrete values.
 *
 * Synthesized object `properties` are a last resort, used only when there is
 * no source evidence — otherwise incidental accesses like `arr.push` on an
 * already-typed array would pollute the inferred type.
 */
function mergeEvidence(evidence: Evidence): {
  type?: string;
  reason?: string;
  weak?: boolean;
} {
  const sources = [...new Set(evidence.sources.flatMap(splitTopLevelUnion))];
  const allowed = intersectConstraints(evidence.constraints);
  let members: string[];
  // A shape synthesized purely from accessed properties is weak evidence: a
  // later round may find a concrete type (e.g. a call-site argument) that is
  // more precise and should replace it.
  let weak = false;

  if (sources.length > 0) {
    // Observed values are authoritative; constraints may narrow them.
    const narrowed = allowed === undefined ? sources : sources.filter((member) => allowed.includes(member));
    // If every observed value violates the constraints, the constraints are
    // likely over-narrow (e.g. any passed to a generic); keep what was observed.
    members = narrowed.length > 0 ? narrowed : sources;
  } else if (allowed !== undefined && allowed.length > 0) {
    // No observed values: the required argument types are our best estimate.
    members = allowed;
  } else if (evidence.properties.size > 0) {
    // Last resort: synthesize an object shape from accessed properties.
    const fields = [...evidence.properties.entries()].map(([name, type]) => {
      const key = /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
      return `${key}: ${type};`;
    });
    members = [`{ ${fields.join(' ')} }`];
    weak = true;
  } else {
    return { reason: 'no usage evidence' };
  }

  members = [...new Set(members)].sort();
  if (members.length === 0) {
    return { reason: 'contradictory constraints' };
  }
  if (members.length === 1) {
    const only = members[0];
    return only === undefined ? { reason: 'no usage evidence' } : { type: only, weak };
  }
  // A bare function type is illegal as a union member without parentheses.
  const formatted = members.map((member) => (hasTopLevelArrow(member) ? `(${member})` : member));
  return { type: formatted.join(' | '), weak };
}

/**
 * Combine a projected whole-value type with element/value types written through
 * a mutable container into one union for the `any` slot. Flattens nested unions,
 * de-duplicates and sorts for deterministic output. Returns undefined only when
 * there is no evidence at all.
 */
function mergeMutationEvidence(
  projected: string | undefined,
  mutations: readonly string[],
): string | undefined {
  // `any`/`unknown` carry no information and, worse, `any | T` collapses to
  // `any` in TypeScript. Drop them so concrete mutations can win.
  const informative = (value: string | undefined): boolean =>
    value !== undefined && value !== 'any' && value !== 'unknown';
  const all = [...(informative(projected) ? [projected as string] : []), ...mutations];
  if (all.length === 0) {
    return undefined;
  }
  const members = [...new Set(all.flatMap(splitTopLevelUnion))].sort();
  if (members.length === 1) {
    return members[0];
  }
  const formatted = members.map((member) => (hasTopLevelArrow(member) ? `(${member})` : member));
  return formatted.join(' | ');
}

/** All declarations that carry an `any` annotation, across non-declaration files. */
function collectAnyOwners(program: ts.Program): ts.Node[] {
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
function collectDeclarations(program: ts.Program): ts.Node[] {
  const owners: ts.Node[] = [];
  const seen = new Set<ts.Node>();
  for (const sourceFile of nonDeclarationFiles(program)) {
    const visit = (node: ts.Node): void => {
      const inferable =
        isFunctionLike(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isPropertySignature(node) ||
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

/** Store an owner's inferred type into the correct side of the table. */
function setOwnerType(table: InferenceTable, owner: ts.Node, type: string): void {
  if (isFunctionLike(owner)) {
    table.returns.set(owner, type);
  } else {
    table.declarations.set(owner, type);
  }
}

function ownerType(table: InferenceTable, owner: ts.Node): string | undefined {
  return isFunctionLike(owner) ? table.returns.get(owner) : table.declarations.get(owner);
}

/**
 * Fixed-point iteration: infer types for every owner and feed each result back
 * into the table so chained declarations resolve. Strong evidence fixes a type
 * permanently; weak evidence (an object shape synthesized from property
 * accesses alone) stays provisional and is re-evaluated each round, so a later
 * concrete type — e.g. a call-site argument that itself was inferred in a
 * previous round — can refine it. Converges in at most MAX_ROUNDS rounds.
 */
function buildInferenceTable(owners: readonly ts.Node[], ctx: InferenceContext): InferenceTable {
  const MAX_ROUNDS = 16;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    let changed = false;
    for (const owner of owners) {
      const current = ownerType(ctx.table, owner);
      const wasWeak = ctx.table.weakOwners.has(owner);
      // Strongly inferred owners are fixed. Weak ones stay open to refinement.
      if (current !== undefined && !wasWeak) {
        continue;
      }
      const merged = mergeEvidence(collectEvidence(owner, ctx));
      if (merged.type === undefined) {
        continue;
      }
      const isWeak = merged.weak === true;
      const sameType = current === merged.type;
      if (sameType && isWeak === wasWeak) {
        continue;
      }
      setOwnerType(ctx.table, owner, merged.type);
      if (isWeak) {
        ctx.table.weakOwners.add(owner);
      } else {
        ctx.table.weakOwners.delete(owner);
      }
      changed = true;
    }
    if (!changed) {
      break;
    }
  }
  return ctx.table;
}

/**
 * Infer concrete types for explicit `any` annotations in a TypeScript program.
 * Each returned result contains the rewritten source plus a per-site report.
 */
export function inferAnyInProject(
  rootNames: readonly string[],
  compilerOptions: ts.CompilerOptions,
  optionsInput: Partial<InferAnyOptions> = {},
): InferFileResult[] {
  const options: InferAnyOptions = { ...DEFAULT_INFER_OPTIONS, ...optionsInput };
  const program = ts.createProgram([...rootNames], compilerOptions);
  const checker = program.getTypeChecker();
  const ctx = createContext(checker, program, createTable());
  buildInferenceTable(collectAnyOwners(program), ctx);

  const results: InferFileResult[] = [];

  for (const fileName of rootNames) {
    const sourceFile = program.getSourceFile(fileName);
    if (sourceFile === undefined) {
      continue;
    }
    const source = sourceFile.getFullText();
    const edits: Array<{ start: number; end: number; text: string }> = [];
    const sites: AnySite[] = [];

    const visit = (node: ts.Node): void => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        const owner = ownerOf(node);
        if (owner === undefined) {
          if (options.includeAssertions) {
            const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
            sites.push({
              file: fileName,
              line,
              start: node.getStart(sourceFile),
              end: node.end,
              original: node.getText(sourceFile),
              reason: 'assertion or unsupported location',
            });
          }
        } else {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          const original = node.getText(sourceFile);
          const wholeType = ownerType(ctx.table, owner);
          // The owner's inferred type describes the whole value. Project it
          // onto the position this `any` token actually occupies so nested
          // slots (`any[]`, `Array<any>`, `Map<K, any>`) are not double-wrapped.
          const projected = wholeType === undefined ? undefined : projectSlotType(wholeType, slotPathOf(node));
          const usableProjected = projected !== 'never' ? projected : undefined;
          // For a mutable container slot, method calls that write into it
          // (`push`, `set`, `add`, index assignment) are covariant sources for
          // the slot type and must be unioned with the projected whole value.
          // Read-only accesses stay out as noise.
          const mutationKind = mutationKindOf(node);
          const mutationTypes =
            mutationKind === undefined ? [] : collectMutationEvidence(owner, mutationKind, ctx);
          const usable = mergeMutationEvidence(usableProjected, mutationTypes);
          if (usable !== undefined) {
            edits.push({
              start: node.getStart(sourceFile),
              end: node.end,
              text: parenthesizeIfComposite(usable),
            });
            sites.push({ file: fileName, line, start: node.getStart(sourceFile), end: node.end, original, inferred: usable });
          } else if (options.reportAmbiguous) {
            const merged = mergeEvidence(collectEvidence(owner, ctx));
            sites.push({ file: fileName, line, start: node.getStart(sourceFile), end: node.end, original, reason: merged.reason });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    let output = source;
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
    }
    results.push({ fileName, output, sites });
  }

  return results;
}

/**
 * A reusable type checker bound to a program. `infer` accepts a declaration node
 * from that program and returns a concrete type when usage evidence is conclusive.
 */
export interface UsageResolver {
  readonly getSourceFile: (fileName: string) => ts.SourceFile | undefined;
  readonly infer: (owner: ts.Node) => string | undefined;
  /**
   * True if `param` has no contextual type and resolves to `any`, i.e. the
   * parameter would trigger `noImplicitAny` (TS7006). Used to annotate only
   * callbacks that genuinely lack contextual typing, without breaking
   * `map`/`filter`-style callbacks whose types are inferred from the callee.
   */
  readonly isImplicitAnyParameter: (param: ts.ParameterDeclaration) => boolean;
}

/** Create a usage resolver over a set of root files (JS or TS). */
export function createUsageResolver(
  rootNames: readonly string[],
  compilerOptions: ts.CompilerOptions,
): UsageResolver {
  const program = ts.createProgram([...rootNames], compilerOptions);
  const checker = program.getTypeChecker();
  const ctx = createContext(checker, program, createTable());
  buildInferenceTable(collectDeclarations(program), ctx);
  return {
    getSourceFile: (fileName) => program.getSourceFile(fileName),
    infer: (owner) => ownerType(ctx.table, owner),
    isImplicitAnyParameter: (param) => {
      // A contextual type (even `any`) means the parameter is already typed by
      // the callee, and annotating it could break inference. Only when there is
      // no contextual type AND the resolved type is `any` do we have a true
      // implicit-any that strict mode will reject. The runtime checker accepts
      // parameter nodes here; the Expression cast satisfies the TS type surface.
      const paramExpr = param as unknown as ts.Expression;
      if (checker.getContextualType(paramExpr) !== undefined) {
        return false;
      }
      const apparent = checker.getTypeAtLocation(paramExpr);
      return (apparent.flags & ts.TypeFlags.Any) !== 0;
    },
  };
}

/** Convenience helper: read a tsconfig.json into compiler options. */
export function readCompilerOptions(configPath: string): ts.CompilerOptions {
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
  }
  const configDir = path.dirname(configPath);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, configDir);
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  }
  return parsed.options;
}
