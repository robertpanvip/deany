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
}

function createTable(): InferenceTable {
  return { declarations: new Map(), returns: new Map() };
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

interface Evidence {
  readonly types: string[];
  readonly properties: Map<string, string>;
}

function emptyEvidence(): Evidence {
  return { types: [], properties: new Map<string, string>() };
}

function addType(evidence: Evidence, type: string | undefined): void {
  if (type !== undefined) {
    evidence.types.push(type);
  }
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
    addType(evidence, typeText(ctx, parent.right));
  }

  if (ts.isPropertyAccessExpression(parent) && parent.expression === reference) {
    const propertyType = typeText(ctx, parent) ?? 'unknown';
    evidence.properties.set(parent.name.text, propertyType);
  }

  // `this.field = expr` / `obj.field = expr`: the reference is the property name.
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.name === reference &&
    ts.isBinaryExpression(parent.parent) &&
    parent.parent.left === parent &&
    parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    addType(evidence, typeText(ctx, parent.parent.right));
  }

  if (ts.isCallExpression(parent)) {
    const index = parent.arguments.indexOf(reference);
    if (index >= 0) {
      const signature = ctx.checker.getResolvedSignature(parent);
      const parameter = signature?.getParameters()[index];
      if (parameter !== undefined) {
        addType(evidence, symbolTypeText(ctx, parameter, parent));
      }
    }
  }

  if (
    ts.isBinaryExpression(parent) &&
    (parent.left === reference || parent.right === reference)
  ) {
    addType(evidence, arithmeticNumberType(ctx, parent));
  }

  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
    if (
      parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken ||
      parent.operator === ts.SyntaxKind.PlusToken ||
      parent.operator === ts.SyntaxKind.MinusToken
    ) {
      addType(evidence, 'number');
    }
  }

  if (ts.isTypeOfExpression(parent)) {
    // `typeof x === 'string'` is a useful hint but not authoritative.
    const binary = parent.parent;
    if (ts.isBinaryExpression(binary) && ts.isStringLiteral(binary.right)) {
      addType(evidence, binary.right.text);
    }
  }
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
      addType(evidence, typeText(ctx, owner.initializer));
    }
  }

  if (isFunctionLike(owner) && owner.body !== undefined) {
    const visit = (node: ts.Node): void => {
      if (isFunctionLike(node) && node !== owner) {
        return;
      }
      if (ts.isReturnStatement(node) && node.expression !== undefined) {
        addType(
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
        addType(evidence, typeText(ctx, argument));
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

/** Merge collected evidence into a single type, or explain why it is ambiguous. */
function mergeEvidence(evidence: Evidence): { type?: string; reason?: string } {
  const candidates = [...evidence.types];
  if (evidence.properties.size > 0) {
    const members = [...evidence.properties.entries()].map(([name, type]) => {
      const key = /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
      return `${key}: ${type};`;
    });
    candidates.push(`{ ${members.join(' ')} }`);
  }

  const unique = [...new Set(candidates)];
  if (unique.length === 0) {
    return { reason: 'no usage evidence' };
  }
  if (unique.length === 1) {
    const only = unique[0];
    return only === undefined ? { reason: 'no usage evidence' } : { type: only };
  }
  return { reason: `ambiguous candidates: ${unique.join(' | ')}` };
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
 * into the table so chained declarations resolve. Once an owner has a concrete
 * type it is fixed; a type is only stored when usage evidence is conclusive.
 * Converges in at most `owners.length` rounds; capped defensively.
 */
function buildInferenceTable(owners: readonly ts.Node[], ctx: InferenceContext): InferenceTable {
  const MAX_ROUNDS = 16;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    let changed = false;
    for (const owner of owners) {
      if (ownerType(ctx.table, owner) !== undefined) {
        continue;
      }
      const merged = mergeEvidence(collectEvidence(owner, ctx));
      if (merged.type !== undefined) {
        setOwnerType(ctx.table, owner, merged.type);
        changed = true;
      }
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
          const inferred = ownerType(ctx.table, owner);
          if (inferred !== undefined) {
            edits.push({
              start: node.getStart(sourceFile),
              end: node.end,
              text: parenthesizeIfComposite(inferred),
            });
            sites.push({ file: fileName, line, start: node.getStart(sourceFile), end: node.end, original, inferred });
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
