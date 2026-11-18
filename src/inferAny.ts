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

/**
 * `Object(value)` boxes its argument into an object (primitives become their
 * wrapper objects); lib.d.ts types the return as `any`, which carries no
 * information. Recognize only the genuine global constructor — the symbol's
 * declarations must all live in a declaration file — so a user shadowing
 * `Object` is never mistaken for it.
 */
function objectConstructorResult(ctx: InferenceContext, node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) {
    return undefined;
  }
  if (node.expression.text !== 'Object') {
    return undefined;
  }
  const declarations = ctx.checker.getSymbolAtLocation(node.expression)?.declarations;
  if (declarations === undefined || declarations.length === 0) {
    return undefined;
  }
  if (!declarations.every((d) => d.getSourceFile().isDeclarationFile)) {
    return undefined;
  }
  return INDEXABLE_OBJECT;
}

function typeText(
  ctx: InferenceContext,
  node: ts.Node,
  type?: ts.Type,
): string | undefined {
  const raw = type ?? ctx.checker.getTypeAtLocation(node);
  const widened = ctx.checker.getWidenedType(raw);
  if (widened.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) {
    return objectConstructorResult(ctx, node) ?? resolveViaTable(ctx, node);
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
    operator === ts.SyntaxKind.AsteriskAsteriskToken ||
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
 * A node in a recursively collected property-shape tree. Used to describe the
 * element type of an array from the property chains accessed on an iteration
 * callback's element parameter (e.g. `xs.map(it => it.a.b)` -> { a: { b: unknown } }).
 */
interface ShapeNode {
  readonly children: Map<string, ShapeNode>;
}

function insertShapeChain(root: ShapeNode, chain: readonly string[]): void {
  let node = root;
  for (const key of chain) {
    let child = node.children.get(key);
    if (child === undefined) {
      child = { children: new Map<string, ShapeNode>() };
      node.children.set(key, child);
    }
    node = child;
  }
}

function renderShapeNode(node: ShapeNode): string {
  if (node.children.size === 0) {
    return 'unknown';
  }
  const fields = [...node.children.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, child]) => {
      const name = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
      return `${name}: ${renderShapeNode(child)};`;
    });
  return `{ ${fields.join(' ')} }`;
}

/** Render accessed properties as an inline object type, e.g. `{ a: number; }`. */
function renderPropertyShape(properties: ReadonlyMap<string, string>): string {
  const fields = [...properties.entries()].map(([name, type]) => {
    const key = /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
    return `${key}: ${type};`;
  });
  return `{ ${fields.join(' ')} }`;
}

/**
 * Merge property-write evidence into an object-literal shape source. A value
 * built as `{ reject }` and later extended with `obj.run = ...` really has
 * both members; the checker reports only the initializer's fields. Keep the
 * initializer's own field types (the authoritative observed values) and append
 * any property evidence not already present. Returns the source unchanged when
 * it is not a plain object shape (e.g. a concrete class or a union member).
 */
function mergeObjectShapeWithProperties(
  source: string,
  properties: ReadonlyMap<string, string>,
): string {
  const trimmed = source.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return source;
  }
  const body = trimmed.slice(1, -1).trim();
  const existing = new Set<string>();
  for (const field of splitTopLevelFields(body)) {
    const colon = field.indexOf(':');
    if (colon >= 0) {
      const name = field.slice(0, colon).trim().replace(/^['"]|['"]$/g, '');
      if (name.length > 0) {
        existing.add(name);
      }
    }
  }
  const additions: string[] = [];
  for (const [name, type] of properties) {
    if (existing.has(name)) {
      continue;
    }
    const key = /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
    // Fields written after construction are optional at the initializer site:
    // `{ reject }` legitimately lacks `run` until `obj.run = ...` runs. Making
    // them required would raise TS2741 on the initializer; optional keeps both
    // the initializer and later accesses valid under strict mode.
    additions.push(`${key}?: ${type};`);
  }
  if (additions.length === 0) {
    return source;
  }
  // `body` already ends with `;` for checker-generated shapes; keep it so
  // appended fields are separated. Trim a trailing space only.
  const fields = body.length > 0 ? [`${body.trimEnd()}`, ...additions] : additions;
  return `{ ${fields.join(' ')} }`;
}

/** Split an object-type body on top-level semicolons, honoring nested types. */
function splitTopLevelFields(body: string): string[] {
  const parts: string[] = [];
  let generic = 0;
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] ?? '';
    if (ch === '<') generic += 1;
    else if (ch === '>') generic -= 1;
    else if (ch === '(') paren += 1;
    else if (ch === ')') paren -= 1;
    else if (ch === '{') brace += 1;
    else if (ch === '}') brace -= 1;
    else if (ch === '[') bracket += 1;
    else if (ch === ']') bracket -= 1;
    else if (ch === ';' && generic === 0 && paren === 0 && brace === 0 && bracket === 0) {
      parts.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(body.slice(start).trim());
  return parts.filter((part) => part.length > 0);
}

/**
 * Build a typed callback signature for a custom method called on a narrowed
 * array, e.g. `xs.custom(it => it.a.b)` becomes
 * `(callback: (arg: { a: { b: unknown; }; }) => void) => unknown`. The element
 * shape is structural evidence from the callback body, not a name guess, so
 * `it.a.b` type-checks inside the callback.
 */
function customArrayMethodSignature(
  call: ts.CallExpression,
  ctx: InferenceContext,
): string {
  const callback = call.arguments[0];
  if (
    callback === undefined ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    callback.parameters.length === 0
  ) {
    return '(callback: (...args: unknown[]) => void) => unknown';
  }
  const elementParam = callback.parameters[0];
  if (
    elementParam === undefined ||
    !ts.isIdentifier(elementParam.name) ||
    callback.body === undefined
  ) {
    return '(callback: (...args: unknown[]) => void) => unknown';
  }
  const shape: ShapeNode = { children: new Map<string, ShapeNode>() };
  for (const chain of propertyChainsOf(elementParam.name, callback.body, ctx)) {
    insertShapeChain(shape, chain);
  }
  const argType = shape.children.size > 0 ? renderShapeNode(shape) : 'unknown';
  return `(callback: (arg: ${argType}) => void) => unknown`;
}

/**
 * Array iteration methods whose callback's first parameter is an element. The
 * element's accessed property chain is a strong, structural hint about the
 * array's element type. `reduce`/`reduceRight` are excluded because their first
 * callback parameter is the accumulator, not an element.
 */
const ITERATION_METHODS = new Set<string>([
  'map', 'forEach', 'filter', 'find', 'findIndex', 'some', 'every',
  'flatMap', 'includes', 'indexOf', 'lastIndexOf',
]);

/** Standard Array members — calling one says nothing about a custom shape. */
const ARRAY_BUILTIN_MEMBERS = new Set<string>([
  ...ITERATION_METHODS,
  'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'concat', 'join',
  'reverse', 'sort', 'fill', 'copyWithin', 'reduce', 'reduceRight', 'flat',
  'entries', 'keys', 'values', 'length', 'at', 'findLast', 'findLastIndex',
  'toReversed', 'toSorted', 'toSpliced', 'with', 'toString',
]);

/**
 * Collect every property-access chain rooted at `root` inside `body` as an
 * array of key paths (e.g. `root.a.b` -> ['a', 'b']). Symbol identity is
 * checked when available so a same-named inner variable is not mistaken for
 * the callback element.
 */
function propertyChainsOf(
  root: ts.Identifier,
  body: ts.Node,
  ctx: InferenceContext,
): string[][] {
  const rootSymbol = ctx.checker.getSymbolAtLocation(root);
  const chains: string[][] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      const chain: string[] = [];
      let current: ts.Expression = node;
      while (ts.isPropertyAccessExpression(current)) {
        chain.unshift(current.name.text);
        current = current.expression;
      }
      if (ts.isIdentifier(current)) {
        const symbol = ctx.checker.getSymbolAtLocation(current);
        const same = symbol !== undefined && symbol === rootSymbol;
        const sameText = symbol === undefined && rootSymbol === undefined && current.text === root.text;
        if ((same || sameText) && chain.length > 0) {
          chains.push(chain);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return chains;
}

/**
 * Usage evidence is split by variance:
 * - `sources` are covariant (values the binding receives: initializers,
 *   assignments, returns, arithmetic). Multiple sources form a union.
 * - `constraints` are contravariant (types the binding must be assignable to,
 *   e.g. when passed as a call argument). Multiple constraints are intersected.
 * - `properties` describe an object's shape, used only as a last-resort source.
 * - `elementShape` describes an array element type inferred from iteration
 *   callback property chains; it refines an otherwise-unknown `unknown[]`.
 * - `arrayOwnMethods` are custom methods called on an array binding (detected
 *   via `Array.isArray` context); intersected into the array type so the calls
 *   type-check without inventing an element shape for unknown methods.
 * - `objectLiteralInit` marks an object-literal initializer, whose shape source
 *   may absorb properties written onto the binding after construction.
 */
interface Evidence {
  readonly sources: string[];
  readonly constraints: string[];
  readonly properties: Map<string, string>;
  readonly elementShape: ShapeNode;
  readonly arrayOwnMethods: Map<string, string>;
  objectLiteralInit: boolean;
  /** True when the binding was seen only in string-like contexts. Weak hint. */
  stringContext: boolean;
}

function emptyEvidence(): Evidence {
  return {
    sources: [],
    constraints: [],
    properties: new Map<string, string>(),
    elementShape: { children: new Map<string, ShapeNode>() },
    arrayOwnMethods: new Map<string, string>(),
    objectLiteralInit: false,
    stringContext: false,
  };
}

function addSource(evidence: Evidence, type: string | undefined): void {
  if (type !== undefined) {
    evidence.sources.push(type);
  }
}

function addConstraint(evidence: Evidence, type: string | undefined): void {
  if (type === undefined) {
    return;
  }
  // `void` / `Promise<void>` describe a function's *return*, not a value. A
  // constraint is an intersection that narrows a value binding (e.g. a real
  // argument passed to a parameter); intersecting with `void` forces that
  // value to become `void`, which is wrong — passing a value to a `void`
  // parameter is exactly what strict mode rejects (TS2345/TS2322). This arises
  // with `const next = async total => { resolve(total); return; }; next(x)`:
  // the parameter's inferred void return leaked in as a constraint on `x`.
  // Drop it so the binding falls back to `unknown` instead of a value-less
  // type. Function returns are unaffected: they carry void via `addSource`.
  if (type === 'void' || type === 'Promise<void>') {
    return;
  }
  evidence.constraints.push(type);
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
 * TypeChecker prints a CommonJS `require('x')` initializer's module namespace
 * type using the *local binding name*, e.g. `var util = require('util')` prints
 * as `typeof util`, `var path = require('path')` as `path.PlatformPath`, and
 * `var fs = require('fs')` as `typeof fs`. Emitting that as an annotation makes
 * the binding reference itself, which TypeScript rejects (TS2502 / TS2503).
 * Detect such self-referential text so the initializer is not used as a type
 * source; the module's real shape is still learned from member accesses.
 */
function isSelfReferentialType(text: string, bindingName: string): boolean {
  return (
    text === `typeof ${bindingName}` ||
    text.startsWith(`typeof ${bindingName}.`) ||
    text.startsWith(`${bindingName}.`)
  );
}

/**
 * Re-express a CommonJS `require('mod')` call as a self-reference-free module
 * type query (`typeof import("mod")`). TypeChecker prints these initializer
 * types using the local binding name (`typeof util`, `path.PlatformPath`),
 * which is only resolvable because the module type exists — so an equivalent
 * `typeof import("mod")` is equally resolvable but never self-references.
 * Bare-specifier modules only: relative paths are left to other evidence.
 */
function requireModuleType(node: ts.Node): string | undefined {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'require' &&
    node.arguments.length > 0 &&
    ts.isStringLiteralLike(node.arguments[0]!)
  ) {
    const spec = (node.arguments[0] as ts.StringLiteralLike).text;
    if (spec.length > 0 && !spec.startsWith('.') && !spec.startsWith('/')) {
      return `typeof import(${JSON.stringify(spec)})`;
    }
  }
  return undefined;
}

/**
 * True if `node` sits inside a branch guarded by `Array.isArray(<same>)` —
 * e.g. `if (Array.isArray(xs)) { xs.custom(...) }`. Walking up to the nearest
 * conditional and testing its expression for an isArray call on the same
 * binding identifies methods called on a value *after* it was narrowed to an
 * array. Used to give those custom methods a typed callback signature.
 */
function isUnderArrayIsArrayGuard(node: ts.Identifier, ctx: InferenceContext): boolean {
  const symbol = ctx.checker.getSymbolAtLocation(node);
  let current: ts.Node | undefined = node;
  while (current !== undefined) {
    const parent: ts.Node | undefined = current.parent;
    if (parent === undefined) {
      break;
    }
    let guard: ts.Expression | undefined;
    if (ts.isIfStatement(parent) && parent.thenStatement === current) {
      guard = parent.expression;
    } else if (ts.isConditionalExpression(parent) && parent.whenTrue === current) {
      guard = parent.condition;
    }
    if (guard !== undefined && containsIsArrayCall(guard, node.text, symbol, ctx)) {
      return true;
    }
    current = parent;
  }
  return false;
}

/** Does `expr` contain `Array.isArray(a)` on the same binding (by symbol or text)? */
function containsIsArrayCall(
  expr: ts.Expression,
  name: string,
  symbol: ts.Symbol | undefined,
  ctx: InferenceContext,
): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }
    if (ts.isCallExpression(node) && isArrayIsArrayCall(node)) {
      const arg = node.arguments[0];
      if (arg !== undefined && ts.isIdentifier(arg)) {
        const argSymbol = ctx.checker.getSymbolAtLocation(arg);
        if (
          (symbol !== undefined && argSymbol === symbol) ||
          (symbol === undefined && arg.text === name)
        ) {
          found = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(expr);
  return found;
}

/**
 * Map a `typeof` result string to a legal, strict-safe TypeScript type.
 * `typeof x === 'function'` is the notable trap: `function` is a keyword, not
 * a type name, so writing it back produces invalid syntax. Most other results
 * (`string`, `number`, `boolean`, `symbol`, `bigint`, `undefined`, `object`)
 * are already legal type keywords.
 */
function typeofLiteralToType(literal: string): string {
  if (literal === 'function') {
    return 'Function';
  }
  return literal;
}

/**
 * Minimal strict-safe contract for a value indexed by arbitrary keys. Using
 * `PropertyKey` covers string, number and symbol keys, so the same type works
 * for `x[k]`, `x[symbol]` and `for (k in x)` without inventing a value type.
 */
const INDEXABLE_OBJECT = 'Record<PropertyKey, unknown>';

/**
 * Memberless object sources produced by type guards: `typeof x === 'object'`
 * and `'k' in x` yield `object`; `typeof x === 'function'` yields `Function`.
 * They narrow the *category* but declare no members, so a real `.foo()` /
 * `x.bar` call on the guarded value is rejected in strict mode (TS2339 /
 * TS18046). These are refined with the members actually accessed on the value
 * — the same structural evidence used for `Array.isArray`'s elementShape —
 * never by a "method name looks like X" guess.
 */
const MEMBERLESS_OBJECT_SOURCES = new Set(['object', 'Function']);

/** True for an array type string produced by this tool (`unknown[]`, `T[]`, `Array<T>`). */
function isArrayTypeString(type: string): boolean {
  return type === 'unknown[]' || type.endsWith('[]') || type.startsWith('Array<') || type.startsWith('ReadonlyArray<');
}

/** Bitwise operators coerce both operands to int32 in JavaScript. */
const BITWISE_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
]);

/** Relational operators only accept orderable primitives (number/string). */
const RELATIONAL_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

/**
 * Built-in APIs whose parameter slots semantically require an object even
 * though their `lib.d.ts` signatures type the slot as `any` or a bare generic
 * `T` (e.g. `Object.defineProperty<T>(o: T, ...)`). Passing an `any` binding
 * into one of these slots is a contravariant constraint: the value must be
 * assignable to `object`. Keyed by `<receiver>.<method>`; values are the
 * zero-based argument indices that require an object.
 */
const OBJECT_ARGUMENT_APIS: Readonly<Record<string, readonly number[]>> = {
  'Object.assign': [0], // target (trailing sources may legally be null/undefined)
  'Object.defineProperties': [0],
  'Object.defineProperty': [0],
  'Object.entries': [0],
  'Object.freeze': [0],
  'Object.getOwnPropertyDescriptor': [0],
  'Object.getOwnPropertyDescriptors': [0],
  'Object.getOwnPropertyNames': [0],
  'Object.getOwnPropertySymbols': [0],
  'Object.getPrototypeOf': [0],
  'Object.hasOwn': [0],
  'Object.isExtensible': [0],
  'Object.isFrozen': [0],
  'Object.isSealed': [0],
  'Object.keys': [0],
  'Object.preventExtensions': [0],
  'Object.seal': [0],
  'Object.setPrototypeOf': [0],
  'Object.values': [0],
  'Reflect.apply': [0],
  'Reflect.construct': [0],
  'Reflect.defineProperty': [0],
  'Reflect.deleteProperty': [0],
  'Reflect.get': [0],
  'Reflect.getOwnPropertyDescriptor': [0],
  'Reflect.getPrototypeOf': [0],
  'Reflect.has': [0],
  'Reflect.ownKeys': [0],
  'Reflect.set': [0],
  'Reflect.setPrototypeOf': [0],
};

/** Argument indices that require an object for a known built-in call. */
function objectArgumentIndices(call: ts.CallExpression): readonly number[] | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) {
    return undefined;
  }
  const receiver = callee.expression.getText(callee.getSourceFile());
  if (receiver !== 'Object' && receiver !== 'Reflect') {
    return undefined;
  }
  return OBJECT_ARGUMENT_APIS[`${receiver}.${callee.name.text}`];
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

/**
 * For a custom type-guard call like `isFoo(x)` declared as
 * `function isFoo(v: unknown): v is Foo`, return the type `Foo` that the guard
 * narrows its argument to. `getResolvedSignature` erases the predicate, so read
 * it from the callee declaration's `TypePredicateNode`. Only the predicate's
 * own parameter (matched by symbol, then by name) is narrowed.
 */
function typePredicateOfArgument(
  call: ts.CallExpression,
  argument: ts.Expression,
  ctx: InferenceContext,
): string | undefined {
  const declaration = ctx.checker.getResolvedSignature(call)?.declaration;
  if (declaration === undefined || declaration.type === undefined) {
    return undefined;
  }
  const signatureDeclaration = declaration as ts.SignatureDeclaration;
  if (signatureDeclaration.type === undefined || !ts.isTypePredicateNode(signatureDeclaration.type)) {
    return undefined;
  }
  const predicate = signatureDeclaration.type;
  if (predicate.type === undefined) {
    return undefined;
  }
  // Resolve which parameter the predicate names (`v is Foo` names `v`).
  // `this is T` predicates have no named parameter and are not argument guards.
  let predicateIndex = -1;
  const parameterName =
    typeof predicate.parameterName === 'string'
      ? predicate.parameterName
      : ts.isIdentifier(predicate.parameterName)
        ? predicate.parameterName.text
        : undefined;
  if (parameterName === undefined) {
    return undefined;
  }
  for (let i = 0; i < signatureDeclaration.parameters.length; i += 1) {
    const p = signatureDeclaration.parameters[i];
    if (p !== undefined && ts.isIdentifier(p.name) && p.name.text === parameterName) {
      predicateIndex = i;
      break;
    }
  }
  if (predicateIndex < 0 || call.arguments[predicateIndex] !== argument) {
    return undefined;
  }
  const type = ctx.checker.getTypeAtLocation(predicate.type);
  const text = sanitizeInstanceType(
    ctx.checker.typeToString(type, predicate.type, TYPE_FORMAT).trim(),
  );
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

  // Logical assignment (`x ||= v`, `x &&= v`, `x ??= v`): v is a value the
  // binding receives, so it is a covariant source, just like `x = v`.
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === reference &&
    (parent.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken ||
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
      parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken)
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
    // `obj.field = expr`: the checker reports `any` for the read of a field
    // not yet present on an evolving object literal, but the RHS carries the
    // real type. Use it so the synthesized shape records the written value.
    const isPropertyWrite =
      ts.isBinaryExpression(grandparent) &&
      grandparent.left === parent &&
      grandparent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
    const METHOD_TYPE = '(...args: unknown[]) => unknown';
    const previous = evidence.properties.get(parent.name.text);
    if (isMethodCall || previous === METHOD_TYPE) {
      evidence.properties.set(parent.name.text, METHOD_TYPE);
    } else if (isPropertyWrite) {
      evidence.properties.set(
        parent.name.text,
        typeText(ctx, (grandparent as ts.BinaryExpression).right) ?? 'unknown',
      );
    } else {
      evidence.properties.set(parent.name.text, typeText(ctx, parent) ?? 'unknown');
    }

    // `if (Array.isArray(xs)) { xs.custom(cb) }`: a custom method called on a
    // narrowed array is a real member of that value. Record a typed signature
    // (building the callback's element shape from what its body accesses) so
    // both `xs.custom(...)` and the callback body type-check. Standard Array
    // members are excluded — they carry no information about a custom shape.
    if (
      isMethodCall &&
      ts.isIdentifier(reference) &&
      !ARRAY_BUILTIN_MEMBERS.has(parent.name.text) &&
      isUnderArrayIsArrayGuard(reference, ctx)
    ) {
      evidence.arrayOwnMethods.set(
        parent.name.text,
        customArrayMethodSignature(grandparent as ts.CallExpression, ctx),
      );
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
  } else if (
    ts.isCallExpression(parent) &&
    typePredicateOfArgument(parent, reference, ctx) !== undefined
  ) {
    // `if (isFoo(x))` where `isFoo(v): v is T` narrows x to T. This is a real
    // control-flow type guard, so T is a covariant source for the binding.
    addSource(evidence, typePredicateOfArgument(parent, reference, ctx));
  } else if (ts.isCallExpression(parent)) {
    const index = parent.arguments.indexOf(reference);
    if (index >= 0) {
      // Built-ins like Object.defineProperty / Reflect.set demand an object at
      // this slot even though lib.d.ts types it as `any` / a bare `T` / `{}`.
      // That is a contravariant constraint: the binding must at least be an
      // object. Skip the lib-declared parameter type for these slots — checker
      // widens `object` to `{}`, which would intersect with `object` into an
      // empty set and erase the evidence.
      const objectArgs = objectArgumentIndices(parent);
      const isObjectSlot = objectArgs !== undefined && objectArgs.includes(index);
      if (isObjectSlot) {
        addConstraint(evidence, 'object');
      } else {
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
  }

  // `fn(...)`: the binding is used as the callee itself. Record a callable
  // signature as a contravariant constraint (the value must be callable) —
  // not a covariant source — so a concrete signature observed at a call site
  // still wins, while a binding seen only as a callee becomes callable instead
  // of `unknown` (which strict mode would reject with TS18046). This also
  // reaches callees invoked inside nested callbacks, since referencesOf walks
  // the whole program rather than a single function body.
  if (ts.isCallExpression(parent) && parent.expression === reference) {
    addConstraint(evidence, '(...args: unknown[]) => unknown');
  }

  // `new Ctor()`: same idea, but the value must be constructable.
  if (ts.isNewExpression(parent) && parent.expression === reference) {
    addConstraint(evidence, 'new (...args: unknown[]) => unknown');
  }

  // `xs.map/forEach(it => it.a.b)`: the receiver is an array, and the property
  // chains accessed on the callback's element parameter describe its element
  // type. Collect them into a shape tree; mergeEvidence uses it to refine an
  // otherwise-opaque `unknown[]` into `Array<{...}>`. This is structural evidence
  // (the code actually depends on those properties), not a heuristic guess.
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === reference &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent &&
    ITERATION_METHODS.has(parent.name.text)
  ) {
    const callback = parent.parent.arguments[0];
    if (
      callback !== undefined &&
      (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
      callback.parameters.length > 0
    ) {
      const elementParam = callback.parameters[0];
      if (
        elementParam !== undefined &&
        ts.isIdentifier(elementParam.name) &&
        callback.body !== undefined
      ) {
        for (const chain of propertyChainsOf(elementParam.name, callback.body, ctx)) {
          insertShapeChain(evidence.elementShape, chain);
        }
      }
    }
  }

  // Spreading `[...x]` or `f(...x)` requires x to be iterable. `unknown[]` is
  // the strict-safe stand-in (same guarantee as for-of), as a contravariant
  // constraint so a concrete source can still refine it. Object spread
  // (`{...x}`) is deliberately excluded: spreading accepts any value there.
  if (
    ts.isSpreadElement(parent) &&
    parent.expression === reference &&
    !ts.isObjectLiteralExpression(parent.parent)
  ) {
    addConstraint(evidence, 'unknown[]');
  }

  // `x[k]` (read or write) and `for (k in x)` both require x to be an
  // indexable object. Record over PropertyKey is a contravariant constraint:
  // the binding must be indexable by arbitrary keys, but a more specific
  // covariant source (e.g. `number[]` from a call site) can still override it.
  if (
    ts.isElementAccessExpression(parent) &&
    parent.expression === reference
  ) {
    addConstraint(evidence, INDEXABLE_OBJECT);
  }
  if (ts.isForInStatement(parent) && parent.expression === reference) {
    addConstraint(evidence, INDEXABLE_OBJECT);
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
    // Any bitwise operator coerces both operands to int32, so an operand seen
    // in `x | 0`, `x & y`, `x << 2` etc. is definitely numeric.
    if (BITWISE_OPERATORS.has(parent.operatorToken.kind)) {
      addSource(evidence, 'number');
    }
    // Relational comparisons only apply to orderable primitives (number or
    // string). This is a *constraint* — the operand must be assignable to
    // `number | string` — not an observed value. Adding it as a covariant
    // source would widen an operand that already has a concrete source (e.g.
    // `let n = 0; n < limit` -> `number | string`), producing TS2365 at the
    // comparison itself. As a constraint it intersects with concrete sources
    // (number ∩ (number|string) = number) and still serves as a last-resort
    // estimate when there is no other evidence.
    if (RELATIONAL_OPERATORS.has(parent.operatorToken.kind)) {
      addConstraint(evidence, 'number | string');
    }
    // `key in x` requires x to be an object (the left side is the key).
    if (
      parent.operatorToken.kind === ts.SyntaxKind.InKeyword &&
      parent.right === reference
    ) {
      addSource(evidence, 'object');
    }
  }

  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
    if (
      parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken ||
      parent.operator === ts.SyntaxKind.PlusToken ||
      parent.operator === ts.SyntaxKind.MinusToken ||
      // `~x` coerces x to int32 (same guarantee as binary bitwise operators).
      parent.operator === ts.SyntaxKind.TildeToken
    ) {
      addSource(evidence, 'number');
    }
  }

  // String-like contexts: `${x}`, `'a' + x` / `x + 'a'`, and `x === 'literal'`
  // (also `!==`). They prove the value can be used as a string, but do not
  // prove it is a string — interpolation and `+` accept numbers too. So this is
  // recorded as a weak hint, consumed only as a last resort in mergeEvidence:
  // real sources (`x = 1`, `x + 1`, call-site arguments) always win and are
  // never widened into `string | number`.
  if (ts.isTemplateSpan(parent) && parent.expression === reference) {
    evidence.stringContext = true;
  }
  if (
    ts.isBinaryExpression(parent) &&
    (parent.left === reference || parent.right === reference)
  ) {
    const operator = parent.operatorToken.kind;
    const other = parent.left === reference ? parent.right : parent.left;
    const stringOperand =
      ts.isStringLiteral(other) ||
      ts.isNoSubstitutionTemplateLiteral(other) ||
      ts.isTemplateExpression(other) ||
      typeText(ctx, other) === 'string';
    if (
      stringOperand &&
      (operator === ts.SyntaxKind.PlusToken ||
        operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        operator === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      evidence.stringContext = true;
    }
  }

  if (ts.isTypeOfExpression(parent)) {
    // `typeof x === 'string'` is a useful hint but not authoritative. Some
    // `typeof` result strings are not legal TypeScript type names (`function`
    // in particular), so map them to a strict-safe equivalent before recording.
    const binary = parent.parent;
    if (ts.isBinaryExpression(binary) && ts.isStringLiteral(binary.right)) {
      addSource(evidence, typeofLiteralToType(binary.right.text));
    }
  }

  // `for (const v of x)` -> x must be iterable. `unknown[]` is the strict-safe
  // stand-in (its elements are the loop variable's type).
  if (ts.isForOfStatement(parent) && parent.expression === reference) {
    addConstraint(evidence, 'unknown[]');
  }

  // Destructuring: `const [a, b] = x` -> x is array-like; `const { foo } = x`
  // -> x has those properties (a synthesized object shape, as a weak source).
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === reference &&
    ts.isArrayBindingPattern(parent.name)
  ) {
    addConstraint(evidence, 'unknown[]');
  }
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === reference &&
    ts.isObjectBindingPattern(parent.name)
  ) {
    for (const element of parent.name.elements) {
      const keyNode = element.propertyName ?? element.name;
      if (ts.isIdentifier(keyNode) || ts.isStringLiteral(keyNode) || ts.isNumericLiteral(keyNode)) {
        const key = keyNode.text;
        if (!evidence.properties.has(key)) {
          evidence.properties.set(key, 'unknown');
        }
      }
    }
  }

  // `const n: number = x`: x is assigned into a target with an explicit type
  // annotation. That annotation is a user-declared contract the value must
  // satisfy, so it is a strong contravariant constraint on x. Only explicit
  // annotations count (an inferred `var n = x` carries no independent signal),
  // and an `any`/`unknown` annotation is disregarded as information-free.
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === reference &&
    parent.type !== undefined
  ) {
    const declared = typeText(ctx, parent.type);
    if (declared !== undefined && declared !== 'any' && declared !== 'unknown') {
      addConstraint(evidence, declared);
    }
  }

  // `await x` -> x is thenable. It is a constraint, not a source: `await` also
  // accepts plain values, but a binding seen only here is most likely a
  // Promise, and a concrete source still overrides this.
  if (ts.isAwaitExpression(parent) && parent.expression === reference) {
    addConstraint(evidence, 'PromiseLike<unknown>');
  }

  // `x || fallback` / `x ?? fallback` -> the fallback's type is an observed
  // value for x (a common "default value" idiom, so x likely shares it).
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === reference &&
    (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    addSource(evidence, typeText(ctx, parent.right));
  }

  // `cond ? x : other` -> the other branch's type is a possible value for x.
  if (ts.isConditionalExpression(parent)) {
    if (parent.whenTrue === reference) {
      addSource(evidence, typeText(ctx, parent.whenFalse));
    } else if (parent.whenFalse === reference) {
      addSource(evidence, typeText(ctx, parent.whenTrue));
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
    if (node === undefined) {
      return;
    }
    const text = typeText(ctx, node);
    if (text !== undefined) {
      collected.push(text);
    } else {
      // The written value is an opaque `any`/`unknown` (e.g. `r.push(fn(x))`
      // where `fn` is an implicit-any callback, or `r.push(await v)`). It is
      // still a real write: the element slot can hold that value, so record
      // `unknown`. This keeps `[]` from freezing at `Array<never>` (which
      // rejects every push with TS2345) without inventing a concrete type.
      collected.push('unknown');
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
    ts.isPropertySignature(owner) ||
    ts.isParameter(owner)
  ) {
    // An empty array literal widens to `never[]`/`any[]`, which rejects every
    // `push`. Real values written through `push`/`unshift`/index assignment are
    // covariant evidence for the element type (the same structural evidence
    // used for container mutation on the explicit-any path), so synthesize
    // `Array<T>` from them instead of freezing the binding at `never[]`.
    if ('initializer' in owner && owner.initializer !== undefined) {
      const init = owner.initializer;
      if (ts.isArrayLiteralExpression(init) && init.elements.length === 0) {
        const writes = collectMutationEvidence(owner, 'collection', ctx);
        const element = mergeMutationEvidence(undefined, writes.filter((t) => t !== 'never'));
        if (element !== undefined) {
          addSource(evidence, `Array<${element}>`);
        } else if (writes.length > 0) {
          // Values were pushed, but every pushed value was an opaque `any`
          // (e.g. `r.push(mapper(1))` / `r.push(await v)` where `typeText`
          // could not name a concrete type). `Array<never>` — the checker's
          // default for `[]` — would reject every one of those pushes with
          // TS2345. Use `Array<unknown>`: it accepts any pushed value and is
          // the strict-safe "type not known" fallback, never an invented type.
          addSource(evidence, 'Array<unknown>');
        } else {
          addSource(evidence, typeText(ctx, init));
        }
      } else {
        if (
          ts.isObjectLiteralExpression(init) &&
          init.properties.every((p) => ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p))
        ) {
          evidence.objectLiteralInit = true;
        }
        // A destructured parameter with defaults — `function f({ a = 1, b = 'x' } = {})`
        // — declares its own shape through the binding elements' default values.
        // Those defaults are authoritative observed values, so synthesize the
        // object shape from them. Without this, the `= {}` initializer alone
        // yields a bare `{}` and every `a`/`b` access raises TS2339. Marking
        // objectLiteralInit lets mergeEvidence emit the fields as optional
        // (the whole argument may be omitted), matching the checker's own
        // `{ a?: number; b?: string }` shape.
        if (
          ts.isParameter(owner) &&
          ts.isObjectBindingPattern(owner.name) &&
          init !== undefined
        ) {
          for (const element of owner.name.elements) {
            if (element.dotDotDotToken !== undefined) {
              continue;
            }
            const keyNode = element.propertyName ?? element.name;
            if (!ts.isIdentifier(keyNode) && !ts.isStringLiteral(keyNode) && !ts.isNumericLiteral(keyNode)) {
              continue;
            }
            const key = keyNode.text;
            const fieldType =
              (element.initializer !== undefined ? typeText(ctx, element.initializer) : undefined) ?? 'unknown';
            if (!evidence.properties.has(key)) {
              evidence.properties.set(key, fieldType);
            }
          }
        }
        // A CommonJS `require('mod')` initializer prints as a self-referential
        // type (`typeof util`, `path.PlatformPath`, `typeof fs`) that TypeScript
        // rejects (TS2502/TS2503). Re-express it as `typeof import("mod")`,
        // which keeps the real module type without naming the local binding.
        const initializerType = requireModuleType(init) ?? typeText(ctx, init);
        const bindingName = ts.isIdentifier(owner.name) ? owner.name.text : undefined;
        if (
          initializerType !== undefined &&
          !(bindingName !== undefined && isSelfReferentialType(initializerType, bindingName))
        ) {
          addSource(evidence, initializerType);
        }
      }
    }
  }

  // A block-bodied function whose body contains no value-returning `return`
  // always yields `undefined` at runtime, so its return type is precisely
  // `void` — not a fallback `unknown`/`any`. Expression-bodied arrows are
  // excluded here: their single expression is the implicit return value and
  // is handled by the call-site / initializer evidence instead.
  if (isFunctionLike(owner) && owner.body !== undefined && ts.isBlock(owner.body)) {
    let hasValueReturn = false;
    const visit = (node: ts.Node): void => {
      if (isFunctionLike(node) && node !== owner) {
        return;
      }
      if (ts.isReturnStatement(node) && node.expression !== undefined) {
        hasValueReturn = true;
        addSource(
          evidence,
          typeText(ctx, node.expression) ?? arithmeticNumberType(ctx, node.expression),
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(owner.body);
    // Generators, constructors and setters cannot carry a `void` return
    // annotation; leave them to their own evidence / the converter's skip list.
    const isGenerator = 'asteriskToken' in owner && owner.asteriskToken !== undefined;
    const cannotReturnVoid =
      isGenerator || ts.isConstructorDeclaration(owner) || ts.isSetAccessorDeclaration(owner);
    if (!hasValueReturn && !cannotReturnVoid) {
      addSource(evidence, 'void');
    }
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
  // `any` / `unknown` / `never` / `{}` carry no usable information — lib.d.ts
  // uses them for many generic slots (e.g. Object.assign's `{}` source type) —
  // so keep them from erasing a meaningful constraint by intersecting empty.
  const informative = constraints.filter(
    (c) => c !== 'any' && c !== 'unknown' && c !== 'never' && c !== '{}',
  );
  // The indexable-object contract is itself an `object`, so when both are
  // required keep only the narrower Record instead of intersecting to an
  // empty set (string equality would otherwise see them as disjoint).
  const normalized = informative.includes(INDEXABLE_OBJECT)
    ? informative.filter((c) => c !== 'object')
    : informative;
  if (normalized.length === 0) {
    return undefined;
  }
  let acc: string[] | undefined;
  for (const constraint of normalized) {
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

  // Refine an otherwise-opaque `unknown[]` into an array of the shape collected
  // from iteration callback property chains. Only when `unknown[]` is the sole
  // source: a concrete array source (e.g. `number[]` from a call site) wins.
  if (
    evidence.elementShape.children.size > 0 &&
    sources.length === 1 &&
    sources[0] === 'unknown[]'
  ) {
    sources[0] = `Array<${renderShapeNode(evidence.elementShape)}>`;
  }

  // Custom methods called on an `Array.isArray`-narrowed array are real members
  // of that value. Intersect their typed signatures so `xs.custom(cb)` and the
  // callback body type-check — the callback element shape is structural
  // evidence from its body, not a name guess. Only array sources are touched;
  // standard Array members were filtered out when the evidence was collected.
  if (
    evidence.arrayOwnMethods.size > 0 &&
    sources.length === 1 &&
    sources[0] !== undefined &&
    isArrayTypeString(sources[0])
  ) {
    sources[0] = `${sources[0]} & ${renderPropertyShape(evidence.arrayOwnMethods)}`;
  }

  // A type guard narrows a value to a memberless category (`object` / `Function`),
  // and real method/property calls on that narrowed value declare the members
  // it must have. Intersect those members back so strict mode accepts the
  // calls (TS2339 / TS18046). Only memberless sources are refined — concrete
  // classes and unions of concrete types are left untouched, so incidental
  // accesses never pollute a known type. Marked weak so a later round's
  // concrete call-site type can refine it, as the property-shape last resort.
  let narrowedFromGuards = false;
  if (evidence.properties.size > 0) {
    const shape = renderPropertyShape(evidence.properties);
    for (let i = 0; i < sources.length; i += 1) {
      const source = sources[i];
      if (source === undefined) {
        continue;
      }
      if (MEMBERLESS_OBJECT_SOURCES.has(source)) {
        sources[i] = `${source} & ${shape}`;
        narrowedFromGuards = true;
      } else if (evidence.objectLiteralInit) {
        // An object literal later extended with `obj.field = v` / `obj.m()`
        // really has those members. Absorb them into its own shape source;
        // the helper no-ops on concrete classes and non-object sources, so
        // call-site/具体类型 and `instanceof` results stay untouched.
        sources[i] = mergeObjectShapeWithProperties(source, evidence.properties);
      }
    }
  }

  // A shape synthesized purely from accessed properties is weak evidence: a
  // later round may find a concrete type (e.g. a call-site argument) that is
  // more precise and should replace it.
  let weak = narrowedFromGuards;

  if (sources.length > 0) {
    // Observed values are authoritative; constraints may narrow them.
    const narrowed = allowed === undefined ? sources : sources.filter((member) => allowed.includes(member));
    // If every observed value violates the constraints, the constraints are
    // likely over-narrow (e.g. any passed to a generic); keep what was observed.
    members = narrowed.length > 0 ? narrowed : sources;
    // An empty object literal written through `x[k]` is being used as a
    // dictionary. Its `{}` type is not indexable, so adopt the indexable-object
    // constraint — a `{}` initializer is assignable to Record<PropertyKey,
    // unknown>. Boxed primitives (String/Number/Boolean) are deliberately not
    // widened this way: they are not assignable to Record and would raise
    // TS2322 at the initializer, so we keep their real type instead.
    if (
      allowed !== undefined &&
      allowed.includes(INDEXABLE_OBJECT) &&
      members.every((member) => member === '{}')
    ) {
      members = [INDEXABLE_OBJECT];
    }
  } else if (allowed !== undefined && allowed.length > 0) {
    // No observed values: the required argument types are our best estimate.
    members = allowed;
  } else if (evidence.properties.size > 0) {
    // Last resort: synthesize an object shape from accessed properties.
    members = [renderPropertyShape(evidence.properties)];
    weak = true;
  } else if (evidence.stringContext) {
    // Last resort: a binding observed only in string-like contexts (template
    // interpolation, `+` with a string, `===` a string literal) is string-like.
    // Weak so a later fixed-point round with a concrete source still refines it:
    // interpolation and `+` also accept numbers, so this must never override
    // real evidence such as `x = 1` or `x + 1`.
    members = ['string'];
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

/** True when `node` is the return-type annotation slot of a function-like owner. */
function isReturnTypeAnnotationOf(node: ts.Node, owner: ts.Node): boolean {
  return (
    isFunctionLike(owner) &&
    node.parent === owner &&
    (owner as ts.SignatureDeclaration).type === node
  );
}

/** Mirror the JS converter's async return wrapping on the explicit-`any` path:
 * an async function returning `T` actually returns `Promise<T>` at runtime. */
function wrapAsyncReturnForInfer(type: string, owner: ts.Node): string {
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
          let usable = mergeMutationEvidence(usableProjected, mutationTypes);
          if (usable !== undefined && isReturnTypeAnnotationOf(node, owner)) {
            usable = wrapAsyncReturnForInfer(usable, owner);
          }
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

/**
 * True when `param` is the element parameter of a known iteration callback
 * whose receiver binding was inferred as an array of shapes. In that case the
 * rewritten source gives the parameter a contextual type, so it must not be
 * annotated (a redundant `unknown` would shadow the element shape).
 */
function isInferredArrayElementParameter(
  param: ts.ParameterDeclaration,
  ctx: InferenceContext,
): boolean {
  const func = param.parent;
  if (!isFunctionLike(func) || func.parameters[0] !== param) {
    return false;
  }
  const call = func.parent;
  if (!ts.isCallExpression(call) || !call.arguments.includes(func as ts.Expression)) {
    return false;
  }
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !ITERATION_METHODS.has(callee.name.text)) {
    return false;
  }
  let symbol = ctx.checker.getSymbolAtLocation(callee.expression);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = ctx.checker.getAliasedSymbol(symbol);
  }
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (declaration === undefined) {
    return false;
  }
  const inferred = ctx.table.declarations.get(declaration);
  return inferred !== undefined && inferred.startsWith('Array<');
}

/**
 * True when `param` is the callback of a custom method called on a narrowed
 * array (`xs.custom(it => ...)`) whose receiver was inferred with a typed
 * method signature via an intersection. The rewritten source supplies a
 * contextual parameter type, so an `unknown` annotation must not be added.
 */
function isCustomArrayMethodCallback(
  param: ts.ParameterDeclaration,
  ctx: InferenceContext,
): boolean {
  const func = param.parent;
  if (!isFunctionLike(func) || func.parameters[0] !== param) {
    return false;
  }
  const call = func.parent;
  if (!ts.isCallExpression(call) || call.arguments[0] !== func) {
    return false;
  }
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || ARRAY_BUILTIN_MEMBERS.has(callee.name.text)) {
    return false;
  }
  let symbol = ctx.checker.getSymbolAtLocation(callee.expression);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = ctx.checker.getAliasedSymbol(symbol);
  }
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (declaration === undefined) {
    return false;
  }
  const inferred = ctx.table.declarations.get(declaration);
  return inferred !== undefined && inferred.includes('&') && isArrayTypeString(inferred.split('&')[0]?.trim() ?? '');
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
      // If this parameter is an iteration callback's element and the receiver
      // was inferred as an array of shapes, the rewritten source will supply a
      // contextual element type. Annotating it `unknown` would override that
      // and reintroduce TS18046, so leave it unannotated.
      if (isInferredArrayElementParameter(param, ctx)) {
        return false;
      }
      if (isCustomArrayMethodCallback(param, ctx)) {
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
