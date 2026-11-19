import * as ts from 'typescript';
import type {
  ConvertOptions,
  ConvertResult,
  Diagnostic,
  JsDocBlock,
  JsDocTag,
} from './types.js';
import { DEFAULT_OPTIONS } from './types.js';
import type { UsageResolver } from './inferAny.js';
import type { DeclarationProvider, DtsSignature } from './dts.js';
import { memberKey } from './dts.js';
import { leadingJsDoc, parseJsDocBlocks, parseTemplateNames } from './jsdoc.js';
import {
  extractCustomTypeNames,
  normalizeJsDocType,
  normalizeRestType,
  objectTypeFromDottedParams,
  objectTypeFromProperties,
  wrapAsyncReturn,
} from './normalize.js';

type FunctionLikeNode =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

interface Edit {
  readonly pos: number;
  readonly text: string;
  readonly order: number;
}

/**
 * Collects text insertions and applies them back-to-front so original offsets stay valid.
 * Pieces passed to one `add` call are emitted left-to-right at the target position.
 */
class EditBuffer {
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

function isFunctionLike(node: ts.Node): node is FunctionLikeNode {
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

function describe(node: ts.Node): string {
  if ('name' in node && typeof node.name === 'object' && node.name !== null && ts.isIdentifier(node.name as ts.Node)) {
    return (node.name as ts.Identifier).text;
  }
  return ts.SyntaxKind[node.kind] ?? 'declaration';
}

/** Locate the parameter-list parentheses of a function-like node. */
function findParens(
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
function keywordEnd(
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

function hasModifier(node: FunctionLikeNode, kind: ts.SyntaxKind): boolean {
  return node.modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function isGenerator(node: FunctionLikeNode): boolean {
  return 'asteriskToken' in node && node.asteriskToken !== undefined;
}

function parameterName(node: ts.ParameterDeclaration): string | undefined {
  return ts.isIdentifier(node.name) ? node.name.text : undefined;
}

/** Callbacks passed as arguments get their types from the callee; annotating them with
 * `unknown` would destroy contextual typing. */
function isCallbackArgument(node: FunctionLikeNode): boolean {
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
function isReturnPositionArrow(node: ts.Node): boolean {
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

/**
 * Detect a callback passed to a method call on a receiver that the converter
 * will give a concrete type via JSDoc, so lib.d.ts will contextually type the
 * callback parameters. Covers `sum(nums)` where `nums` has `@param {...number}`
 * (converted to `number[]`), or a variable with an inline `@type` array tag.
 */
function callbackReceiverHasJSDocType(
  node: FunctionLikeNode,
  sourceFile: ts.SourceFile,
  source: string,
  blocks: readonly JsDocBlock[],
): boolean {
  let call: ts.Node | undefined = node.parent;
  while (call !== undefined && !ts.isCallExpression(call)) {
    call = call.parent;
  }
  if (call === undefined || !ts.isCallExpression(call)) {
    return false;
  }
  // The callback must actually be an argument of this call.
  if (!call.arguments.some((arg) => arg === node || (arg as ts.Node).pos === node.pos)) {
    return false;
  }
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) {
    return false;
  }
  const receiverName = callee.expression.text;

  // Find the receiver's declaration (parameter or variable) in the file by
  // name, then check whether it carries a JSDoc that yields an array/object
  // type after conversion.
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    let declName: ts.Identifier | undefined;
    if ((ts.isParameter(n) || ts.isVariableDeclaration(n)) && ts.isIdentifier(n.name)) {
      declName = n.name;
    }
    if (declName !== undefined && declName.text === receiverName) {
      // For a parameter, its JSDoc `@param` lives on the enclosing function;
      // for a variable, the `@type` tag lives on the declaration itself.
      let doc = leadingJsDoc(n, sourceFile, source, blocks);
      if (doc === undefined && ts.isParameter(n) && isFunctionLike(n.parent)) {
        doc = leadingJsDoc(n.parent, sourceFile, source, blocks);
      }
      if (doc !== undefined) {
        for (const tag of doc.tags) {
          const namesReceiver =
            tag.tag === 'type' || (tag.tag === 'param' && tag.name === receiverName);
          if (
            namesReceiver &&
            tag.typeText !== undefined &&
            (/\[\]/.test(tag.typeText) || /Array\s*</.test(tag.typeText) || tag.variadic)
          ) {
            found = true;
            return;
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * Annotate only those callback parameters that are genuinely implicit `any`
 * (no contextual type from the callee). Parameters whose types come from
 * contextual typing are left untouched, so `map`/`filter`/`reduce` inference
 * keeps working. Requires a resolver (checker); without one we do nothing.
 */
function annotateImplicitAnyCallback(
  node: FunctionLikeNode,
  resolver: UsageResolver | undefined,
  sourceFile: ts.SourceFile,
  source: string,
  defaultType: string,
  edits: EditBuffer,
  blocks: readonly JsDocBlock[],
): void {
  if (resolver === undefined || node.parameters.length === 0) {
    return;
  }
  // If the callback is an argument to a method call whose receiver will be
  // concretely typed after conversion (e.g. `sum(nums)` where nums carries a
  // JSDoc `@param {...number}` that converts to `number[]`), lib.d.ts supplies
  // contextual types for the callback parameters. Annotating them `unknown`
  // here would override that and break strict mode (TS18046/TS2322). The
  // checker cannot see this because it reads the pre-conversion source, so
  // detect the JSDoc-typed receiver from the AST instead.
  if (callbackReceiverHasJSDocType(node, sourceFile, source, blocks)) {
    return;
  }
  const toAnnotate = node.parameters.filter(
    (parameter) => resolver.isImplicitAnyParameter(parameter),
  );
  if (toAnnotate.length === 0) {
    return;
  }

  const parens = findParens(node, sourceFile, source);
  const unparenthesized =
    ts.isArrowFunction(node) && parens === undefined && node.parameters.length === 1;

  // Prefer a concrete usage-derived type for the parameter over the blind
  // default. E.g. `(s) => s.length` used as a call argument gives `s` a
  // `{ length: unknown; }` shape from its own member access; annotating it
  // `unknown` instead would make `s.length` a TS18046.
  const paramType = (parameter: ts.ParameterDeclaration): string => {
    const inferred = resolver.infer(parameter);
    const usable =
      inferred !== undefined &&
      inferred !== 'any' &&
      inferred !== 'unknown' &&
      inferred !== 'never' &&
      inferred !== 'void';
    const base = usable ? (inferred as string) : defaultType;
    return parameter.dotDotDotToken && !base.endsWith('[]') ? `${base}[]` : base;
  };

  if (unparenthesized) {
    // `x => ...` cannot carry a type annotation; rewrite to `(x: T) => ...`.
    const first = toAnnotate[0];
    if (first !== undefined && resolver.isImplicitAnyParameter(first)) {
      const start = first.getStart(sourceFile);
      const end = first.name.end;
      const rest = paramType(first);
      edits.add(start, '(');
      edits.add(end, `: ${rest})`);
    }
    return;
  }

  for (const parameter of toAnnotate) {
    edits.add(parameter.name.end, `: ${paramType(parameter)}`);
  }
}

function enclosingClass(node: ts.Node): ts.ClassLikeDeclaration | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function functionTypeFromCallback(
  block: JsDocBlock,
  options: ConvertOptions,
): string {
  const params = block.tags
    .filter((tag) => tag.tag === 'param')
    .map((tag, index) => {
      const name = tag.name ?? `arg${index}`;
      const rest = tag.variadic ? '...' : '';
      const optional = tag.optional && !tag.variadic ? '?' : '';
      const rawType = tag.typeText ?? options.defaultType;
      const type = tag.variadic
        ? normalizeRestType(rawType, options)
        : normalizeJsDocType(rawType, options);
      return `${rest}${name}${optional}: ${type}`;
    });
  const returnTag = block.tags.find((tag) => tag.tag === 'returns' || tag.tag === 'return');
  const returnType = normalizeJsDocType(returnTag?.typeText ?? 'void', options);
  return `(${params.join(', ')}) => ${returnType}`;
}

function typeForTaggedDeclaration(
  doc: JsDocBlock,
  options: ConvertOptions,
): string | undefined {
  const typeTag = doc.tags.find((tag) => tag.tag === 'type');
  if (typeTag?.typeText === undefined) {
    return undefined;
  }
  const properties = doc.tags.filter((tag) => tag.tag === 'property');
  if (typeTag.typeText === 'Object' && properties.length > 0) {
    return objectTypeFromProperties(properties, options);
  }
  return normalizeJsDocType(typeTag.typeText, options);
}

/** Convert a JavaScript source string into strict TypeScript source text. */
export function convertSource(
  fileName: string,
  source: string,
  optionsInput: Partial<ConvertOptions> = {},
  resolver?: UsageResolver,
  declarations?: DeclarationProvider,
): ConvertResult {
  const options: ConvertOptions = { ...DEFAULT_OPTIONS, ...optionsInput };
  // When a resolver is supplied, use its SourceFile so checker symbols line up.
  const sourceFile =
    (resolver !== undefined
      ? (resolver.getSourceFile(fileName) ?? resolver.getSourceFile(ts.sys.resolvePath(fileName)))
      : undefined) ??
    ts.createSourceFile(
      fileName,
      source,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.JS,
    );
  const blocks = parseJsDocBlocks(source);
  const edits = new EditBuffer();
  const diagnostics: Diagnostic[] = [];
  const processed = new Set<ts.Node>();
  const thisFields = new Map<ts.ClassLikeDeclaration, Set<string>>();

  const warn = (message: string, offset: number): void => {
    diagnostics.push({ severity: 'warn', message, file: fileName, offset });
  };

  // A sibling `.d.ts` is the authoritative contract for a symbol. When one is
  // present its signature wins over JSDoc and usage inference: this is how a
  // JS implementation gets "combined" with its declaration into exact TS.
  const dtsSignatureForFunction = (node: FunctionLikeNode): DtsSignature | undefined => {
    if (declarations === undefined) {
      return undefined;
    }
    const key = memberKey(node);
    if (key !== undefined) {
      const member = declarations.members.get(key);
      return typeof member === 'object' ? member : undefined;
    }
    if ('name' in node && node.name !== undefined && ts.isIdentifier(node.name)) {
      return declarations.functions.get(node.name.text);
    }
    return undefined;
  };

  const processFunction = (
    node: FunctionLikeNode,
    doc: JsDocBlock | undefined,
  ): void => {
    const tags = doc?.tags ?? [];
    const paramTags = tags.filter((tag) => tag.tag === 'param');
    const templateTag = tags.find((tag) => tag.tag === 'template');
    const typeParameters = templateTag === undefined ? [] : parseTemplateNames(templateTag);
    const thisTag = tags.find((tag) => tag.tag === 'this' && tag.typeText !== undefined);
    const returnTag = tags.find((tag) => tag.tag === 'returns' || tag.tag === 'return');
    const parens = findParens(node, sourceFile, source);
    const unparenthesizedArrow =
      ts.isArrowFunction(node) && parens === undefined && node.parameters.length > 0;
    const async = hasModifier(node, ts.SyntaxKind.AsyncKeyword);
    const generator = isGenerator(node);
    const skipReturn =
      generator || ts.isConstructorDeclaration(node) || ts.isSetAccessorDeclaration(node);
    const dtsSig = dtsSignatureForFunction(node);
    const genericSuffix =
      dtsSig?.typeParams ??
      (typeParameters.length > 0 ? `<${typeParameters.join(', ')}>` : undefined);

    let returnAnnotation: string | undefined;
    // A function/method that already carries a return type annotation (e.g. a
    // `declare` class method `bar(): void;`) must not get a second one — that
    // emits `bar(): unknown: void` (TS1144). Pure declarations are off-limits.
    const hasExplicitReturnType =
      'type' in node && (node as ts.SignatureDeclaration).type !== undefined;
    if (!skipReturn && !hasExplicitReturnType) {
      if (dtsSig?.returnType !== undefined) {
        // The d.ts return type is authoritative and already fully written
        // (including any Promise<...> for async functions) — do not re-wrap.
        returnAnnotation = `: ${dtsSig.returnType}`;
      } else if (returnTag?.typeText !== undefined) {
        let returnType = normalizeJsDocType(returnTag.typeText, options);
        if (async) {
          returnType = wrapAsyncReturn(returnType, options);
        }
        returnAnnotation = `: ${returnType}`;
      } else {
        const inferred = resolver?.infer(node);
        if (inferred !== undefined) {
          returnAnnotation = `: ${async ? wrapAsyncReturn(inferred, options) : inferred}`;
        } else if (options.annotateUntyped && !isReturnPositionArrow(node)) {
          // A curried/returned arrow (`return b => c => ...`) usually has an
          // enclosing declaration whose JSDoc @returns already spells out the
          // nested function type. Annotating its inner arrows with `: unknown`
          // contradicts that declared type (TS2322) — let TypeScript infer the
          // inner return from the expression instead. See isReturnPositionArrow.
          returnAnnotation = `: ${async ? 'Promise<unknown>' : options.defaultType}`;
        }
      }
    } else if (returnTag !== undefined) {
      warn(`@returns is ignored on ${describe(node)} (generator/constructor/setter).`, doc?.start ?? 0);
    }

    const usedTags = new Set<JsDocTag>();

    if (unparenthesizedArrow) {
      const first = node.parameters[0];
      if (first !== undefined && parens === undefined) {
        const start = first.getStart(sourceFile);
        const end = first.name.end;
        edits.add(start, ...(genericSuffix === undefined ? ['('] : [genericSuffix, '(']));

        const tag = paramTags[0];
        if (tag !== undefined) {
          usedTags.add(tag);
        }
        let annotation = '';
        const dtsParam = dtsSig?.params[0];
        if (dtsParam !== undefined) {
          const restType =
            dtsParam.rest && !dtsParam.type.endsWith('[]') ? `${dtsParam.type}[]` : dtsParam.type;
          annotation = `: ${restType}`;
        } else if (tag?.typeText !== undefined) {
          const type = first.dotDotDotToken
            ? normalizeRestType(tag.typeText, options)
            : normalizeJsDocType(tag.typeText, options);
          annotation = `: ${type}`;
        } else {
          const inferred = resolver?.infer(first);
          if (inferred !== undefined) {
            const restType = first.dotDotDotToken && !inferred.endsWith('[]') ? `${inferred}[]` : inferred;
            annotation = `: ${restType}`;
          } else if (options.annotateUntyped) {
            annotation = `: ${first.dotDotDotToken ? `${options.defaultType}[]` : options.defaultType}`;
          }
        }
        edits.add(
          end,
          annotation,
          ')',
          returnAnnotation ?? '',
        );
      }
    } else {
      if (genericSuffix !== undefined) {
        if (ts.isArrowFunction(node) && parens !== undefined) {
          edits.add(parens.open, genericSuffix);
        } else if (
          (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
          node.name !== undefined
        ) {
          edits.add(node.name.end, genericSuffix);
        } else if (!ts.isConstructorDeclaration(node)) {
          const fnEnd = keywordEnd(node, sourceFile, ts.SyntaxKind.FunctionKeyword);
          if (fnEnd !== undefined) {
            edits.add(fnEnd, genericSuffix);
          }
        }
      }

      if (thisTag?.typeText !== undefined && parens !== undefined && !ts.isArrowFunction(node)) {
        const thisType = normalizeJsDocType(thisTag.typeText, options);
        const suffix = node.parameters.length > 0 ? ', ' : '';
        edits.add(parens.open + 1, `this: ${thisType}${suffix}`);
      }

      for (let index = 0; index < node.parameters.length; index += 1) {
        const parameter = node.parameters[index];
        if (parameter === undefined) {
          continue;
        }
        const name = parameterName(parameter);
        let tag = name === undefined ? undefined : paramTags.find((item) => item.name === name && !usedTags.has(item));
        if (tag === undefined && name === undefined) {
          tag = paramTags.find((item) => !usedTags.has(item));
        }
        if (tag !== undefined) {
          usedTags.add(tag);
        }

        let annotation: string | undefined;
        const dtsParam = dtsSig?.params[index];
        if (dtsParam !== undefined) {
          const restType =
            dtsParam.rest && !dtsParam.type.endsWith('[]') ? `${dtsParam.type}[]` : dtsParam.type;
          const optional =
            dtsParam.optional &&
            parameter.initializer === undefined &&
            parameter.dotDotDotToken === undefined;
          annotation = `${optional ? '?' : ''}: ${restType}`;
        }
        // `@param {string} [options.foo]` describes a field of `options`, not a
        // separate parameter. The checker collapses these to a bare `object` and
        // drops the fields, so fold every dotted tag back into an inline shape.
        const dottedTags =
          name === undefined
            ? []
            : paramTags.filter(
                (item) =>
                  !usedTags.has(item) &&
                  item.name !== undefined &&
                  item.name.startsWith(`${name}.`),
              );
        if (annotation === undefined && dottedTags.length > 0) {
          for (const dotted of dottedTags) {
            usedTags.add(dotted);
          }
          const shape = objectTypeFromDottedParams(name ?? '', dottedTags, options);
          const optional =
            tag !== undefined &&
            tag.optional &&
            parameter.initializer === undefined &&
            parameter.dotDotDotToken === undefined;
          annotation = `${optional ? '?' : ''}: ${shape}`;
        } else if (annotation === undefined && tag?.typeText !== undefined) {
          const type = parameter.dotDotDotToken || tag.variadic
            ? normalizeRestType(tag.typeText, options)
            : normalizeJsDocType(tag.typeText, options);
          const optional =
            tag.optional && parameter.initializer === undefined && parameter.dotDotDotToken === undefined;
          annotation = `${optional ? '?' : ''}: ${type}`;
        } else if (annotation === undefined) {
          const inferred = resolver?.infer(parameter);
          if (inferred !== undefined) {
            annotation = `: ${parameter.dotDotDotToken && !inferred.endsWith('[]') ? `${inferred}[]` : inferred}`;
          } else if (options.annotateUntyped) {
            annotation = `: ${parameter.dotDotDotToken ? `${options.defaultType}[]` : options.defaultType}`;
          }
        }
        // As with `const { a } = src`, a destructured parameter must not carry a
        // hollow `{}` / `unknown` annotation: it masks the shapes folded into
        // the parameter's `= {}` default by the resolver.
        if (
          annotation !== undefined &&
          ts.isObjectBindingPattern(parameter.name) &&
          (annotation === ': {}' || annotation === ': unknown')
        ) {
          continue;
        }
        // A parameter that already has a type annotation (e.g. in a `declare`
        // function) must not get a second one — that emits `a: unknown: string`
        // (TS1005). Leave explicitly typed parameters untouched.
        if (annotation !== undefined && parameter.type === undefined) {
          edits.add(parameter.name.end, annotation);
        }
      }

      if (returnAnnotation !== undefined && parens !== undefined) {
        edits.add(parens.close + 1, returnAnnotation);
      }
    }

    for (const tag of paramTags) {
      if (!usedTags.has(tag)) {
        warn(
          `@param ${tag.name ?? '(unnamed)'} has no matching parameter in ${describe(node)}.`,
          doc?.start ?? 0,
        );
      }
    }
  };

  const processVariable = (node: ts.VariableDeclaration, doc: JsDocBlock | undefined): void => {
    // Never stack an annotation onto a binding that already has one. Doing so
    // on `declare const X: number;` emits `declare const X: unknown: number;`
    // (TS1005 double colon) — pure type declarations must be left untouched.
    if (node.type !== undefined) {
      return;
    }
    // `for (const x of ys)` forbids a type annotation on the loop binding.
    if (
      ts.isVariableDeclarationList(node.parent) &&
      (ts.isForOfStatement(node.parent.parent) || ts.isForInStatement(node.parent.parent))
    ) {
      return;
    }
    // A catch binding may only be annotated `any` / `unknown` in TypeScript
    // (TS1196). Inferring an object shape from `err.message` etc. and writing it
    // here would be illegal, so leave catch variables untouched (they default
    // to `unknown` under strict / useUnknownInCatchVariables).
    if (node.parent !== undefined && ts.isCatchClause(node.parent)) {
      return;
    }
    let type =
      declarations !== undefined && ts.isIdentifier(node.name)
        ? declarations.variables.get(node.name.text)
        : undefined;
    if (type === undefined) {
      type = doc === undefined ? undefined : typeForTaggedDeclaration(doc, options);
    }
    if (type === undefined) {
      type = resolver?.infer(node);
    }
    if (type === undefined && options.annotateUntyped) {
      type = options.defaultType;
    }
    if (type === undefined) {
      return;
    }
    // A documented function is annotated on the function itself, not on the binding.
    if (doc?.tags.some((tag) => tag.tag === 'param' || tag.tag === 'returns' || tag.tag === 'return') ?? false) {
      return;
    }
    // Likewise, when the initializer is itself a function and the type came
    // from inference (not an explicit @type), the function expression carries
    // its own parameter/return annotations. Adding a separate binding
    // annotation from the checker's function type (which may contain `any`)
    // duplicates the type in two places with different normalizations and
    // produces assignability errors. Let TS infer the binding from the
    // annotated function instead.
    const hasExplicitTypeTag = doc?.tags.some((tag) => tag.tag === 'type') ?? false;
    if (
      !hasExplicitTypeTag &&
      node.initializer !== undefined &&
      isFunctionLike(node.initializer)
    ) {
      return;
    }
    // A destructuring pattern (`const { a, b } = src`) must not carry a
    // meaningless `{}` / `unknown` annotation: it would override the accurate
    // shape already present on `src`, making every destructured binding
    // `unknown` (TS2339/TS18046). Let TS infer the pattern from its source;
    // the source is annotated separately with the folded element shapes.
    if (ts.isObjectBindingPattern(node.name) && (type === '{}' || type === 'unknown')) {
      return;
    }
    edits.add(node.name.end, `: ${type}`);
  };

  const processProperty = (node: ts.PropertyDeclaration, doc: JsDocBlock | undefined): void => {
    const key = memberKey(node);
    const memberType = key === undefined || declarations === undefined ? undefined : declarations.members.get(key);
    let type = typeof memberType === 'string' ? memberType : undefined;
    if (type === undefined) {
      type = doc === undefined ? undefined : typeForTaggedDeclaration(doc, options);
    }
    if (type === undefined) {
      type = resolver?.infer(node);
    }
    if (type === undefined && options.annotateUntyped) {
      type = options.defaultType;
    }
    if (type === undefined) {
      return;
    }
    // An already-annotated member (e.g. `declare foo: number;`) must not get a
    // second annotation — that produces a double colon (TS1005).
    if (node.type !== undefined) {
      return;
    }
    const needsDefiniteAssignment =
      node.initializer === undefined &&
      node.questionToken === undefined &&
      !(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) ?? false);
    edits.add(node.name.end, needsDefiniteAssignment ? `!: ${type}` : `: ${type}`);
  };

  // Infer the type of a literal initializer without a checker, so `this.x = 1`
  // is still promoted when convertSource is used without a UsageResolver. Only
  // unambiguous primitive/container literals are named; anything else is left
  // to the resolver or dropped rather than guessed.
  const literalTypeOf = (expr: ts.Expression): string | undefined => {
    if (ts.isNumericLiteral(expr)) {
      return 'number';
    }
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      return 'string';
    }
    if (
      expr.kind === ts.SyntaxKind.TrueKeyword ||
      expr.kind === ts.SyntaxKind.FalseKeyword
    ) {
      return 'boolean';
    }
    if (ts.isArrayLiteralExpression(expr)) {
      return 'unknown[]';
    }
    if (ts.isObjectLiteralExpression(expr)) {
      return 'object';
    }
    if (expr.kind === ts.SyntaxKind.NullKeyword) {
      return 'null';
    }
    return undefined;
  };

  const processThisAssignment = (
    node: ts.BinaryExpression,
    doc: JsDocBlock | undefined,
  ): void => {
    const left = node.left;
    if (!ts.isPropertyAccessExpression(left) || !ts.isIdentifier(left.name)) {
      return;
    }
    // README promises `this.x = ...` is promoted to a class field. The JSDoc
    // `@type` is authoritative when present; otherwise the assigned value is
    // real evidence for the field's type (e.g. `this.x = 1` -> number), so use
    // it instead of leaving the field undeclared (which makes every `this.x`
    // access a TS2339). Only a concrete, informative type qualifies — no
    // `any`/`unknown`/`void` guessing.
    let type = doc === undefined ? undefined : typeForTaggedDeclaration(doc, options);
    if (type === undefined) {
      const fromValue = resolver?.typeOf(node.right) ?? literalTypeOf(node.right);
      if (
        fromValue !== undefined &&
        fromValue !== 'any' &&
        fromValue !== 'unknown' &&
        fromValue !== 'never' &&
        fromValue !== 'void'
      ) {
        type = fromValue;
      }
    }
    if (type === undefined) {
      return;
    }
    const className = left.name.text;
    const classNode = enclosingClass(node);
    if (classNode === undefined) {
      return;
    }
    const names = thisFields.get(classNode) ?? new Set<string>();
    if (names.has(className)) {
      return;
    }
    names.add(className);
    thisFields.set(classNode, names);
    // JS assigns these fields dynamically (often in a helper method rather
    // than the constructor), which TS's strictPropertyInitialization cannot
    // see. A definite-assignment assertion keeps every access strict-clean
    // without weakening the declared type.
    edits.add(classNode.members.pos, `\n  ${className}!: ${type};`);
  };

  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node) && !processed.has(node)) {
      processed.add(node);
      let doc = leadingJsDoc(node, sourceFile, source, blocks);
      if (doc === undefined) {
        // `module.exports = function(){}` / `exports.foo = fn` / `x = fn`:
        // the JSDoc is attached to the enclosing assignment, whose start
        // position equals the binary expression's, not to the function
        // expression itself (there is non-whitespace text in between).
        const parent = node.parent;
        if (
          ts.isBinaryExpression(parent) &&
          parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          parent.right === node
        ) {
          doc = leadingJsDoc(parent, sourceFile, source, blocks);
        }
      }
      if (doc !== undefined || !isCallbackArgument(node)) {
        processFunction(node, doc);
      } else if (options.annotateUntypedCallbacks) {
        // A callback without JSDoc: only annotate parameters that truly lack
        // contextual typing. Contextual callbacks are left to TS inference.
        annotateImplicitAnyCallback(node, resolver, sourceFile, source, options.defaultType, edits, blocks);
      }
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      const doc = leadingJsDoc(node, sourceFile, source, blocks);
      processThisAssignment(node, doc);
    }

    if (ts.isVariableDeclaration(node)) {
      let doc = leadingJsDoc(node, sourceFile, source, blocks);
      if (doc === undefined && ts.isVariableDeclarationList(node.parent)) {
        const statement = node.parent.parent;
        if (ts.isVariableStatement(statement)) {
          doc = leadingJsDoc(statement, sourceFile, source, blocks);
        }
      }
      processVariable(node, doc);
      const initializer = node.initializer;
      if (doc !== undefined && initializer !== undefined && isFunctionLike(initializer) && !processed.has(initializer)) {
        processed.add(initializer);
        processFunction(initializer, doc);
      }
    }

    if (ts.isPropertyDeclaration(node)) {
      const doc = leadingJsDoc(node, sourceFile, source, blocks);
      processProperty(node, doc);
    }

    if (ts.isClassDeclaration(node) && node.name !== undefined && !processed.has(node)) {
      processed.add(node);
      const doc = leadingJsDoc(node, sourceFile, source, blocks);
      // `@template T` on a class must produce `class Box<T>`, exactly as on
      // functions; otherwise the referenced T stays undeclared (TS2304).
      const templateTag = doc?.tags.find((tag) => tag.tag === 'template');
      if (templateTag !== undefined && (node.typeParameters === undefined || node.typeParameters.length === 0)) {
        const names = parseTemplateNames(templateTag);
        if (names.length > 0) {
          edits.add(node.name.end, `<${names.join(', ')}>`);
        }
      }
      // The tool's own strict tsconfig enables `noImplicitOverride`, so a
      // subclass member that genuinely overrides a base member must carry
      // `override` (TS4114). The resolver confirms the base really has a member
      // of the same name via the checker — only real overrides are marked,
      // never guessed from shape or name alone.
      if (resolver !== undefined) {
        for (const member of node.members) {
          if (member.name === undefined || ts.isConstructorDeclaration(member)) {
            continue;
          }
          const hasOverride =
            ts.canHaveModifiers(member) &&
            (ts.getModifiers(member) ?? []).some((m) => m.kind === ts.SyntaxKind.OverrideKeyword);
          if (!hasOverride && resolver.overridesBase(member)) {
            edits.add(member.getStart(sourceFile), 'override ');
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (options.emitTypedefs) {
    for (const block of blocks) {
      for (const tag of block.tags) {
        if (tag.tag !== 'typedef' && tag.tag !== 'callback') {
          continue;
        }
        const name = tag.name;
        if (name === undefined || !/^[A-Za-z_$][\w$]*$/.test(name)) {
          warn(`Skipping ${tag.tag} with invalid or missing name.`, block.start);
          continue;
        }
        const properties = block.tags.filter((tag) => tag.tag === 'property');
        const type =
          tag.tag === 'callback'
            ? functionTypeFromCallback(block, options)
            : tag.tag === 'typedef' && tag.typeText === 'Object' && properties.length > 0
              ? objectTypeFromProperties(properties, options)
              : typeForTaggedDeclaration(block, options) ??
                normalizeJsDocType(tag.typeText ?? options.defaultType, options);
        if (type.startsWith('Record<string, unknown>') && tag.typeText === undefined) {
          warn(`@typedef ${name} has no type; using ${options.defaultType}.`, block.start);
        }
        edits.add(block.end, `\n\ntype ${name} = ${type};`);
      }
    }
  }

  // JSDoc may reference custom type names that have no `@typedef` in this file
  // (cross-file typedefs, or simply missing definitions). Emit fallback aliases
  // so the generated TS stays valid; the name is preserved for later completion.
  // A @typedef only counts as "defined" when it was actually emitted. With
  // --no-typedef no `type User = ...` is generated, yet references like `u:
  // User` remain; treating User as defined left them dangling (TS2304) and made
  // the option unusable on its own. Let such names fall through to the fallback
  // aliases below so the output still compiles.
  const definedNames = new Set<string>();
  if (options.emitTypedefs) {
    for (const block of blocks) {
      for (const tag of block.tags) {
        if ((tag.tag === 'typedef' || tag.tag === 'callback') && tag.name !== undefined) {
          definedNames.add(tag.name);
        }
      }
    }
  }
  const templateNames = new Set<string>();
  for (const block of blocks) {
    for (const tag of block.tags) {
      if (tag.tag === 'template') {
        for (const name of parseTemplateNames(tag)) {
          templateNames.add(name);
        }
      }
    }
  }
  const dtsTypeNames = new Set<string>(
    declarations === undefined ? [] : declarations.typeDeclarations.map((decl) => decl.name),
  );
  // Never emit a fallback `type X = unknown` when X is already a real
  // declaration in the source (class/interface/enum/type alias). Doing so for
  // `class Foo` + `@returns {x is Foo}` produced `type Foo = unknown` alongside
  // `class Foo` (TS2300 duplicate identifier), even though the `x is Foo`
  // predicate itself converted correctly.
  const localDeclaredNames = new Set<string>();
  const collectDeclaredName = (n: ts.Node): void => {
    if (
      (ts.isClassDeclaration(n) ||
        ts.isInterfaceDeclaration(n) ||
        ts.isEnumDeclaration(n) ||
        ts.isTypeAliasDeclaration(n)) &&
      n.name !== undefined
    ) {
      localDeclaredNames.add(n.name.text);
    }
    ts.forEachChild(n, collectDeclaredName);
  };
  collectDeclaredName(sourceFile);
  const dangling = new Set<string>();
  for (const block of blocks) {
    for (const tag of block.tags) {
      if (tag.typeText === undefined) {
        continue;
      }
      for (const name of extractCustomTypeNames(tag.typeText, definedNames, templateNames)) {
        // A sibling d.ts already provides this type — emitting a fallback
        // `type X = unknown` would conflict with the real declaration.
        if (!dtsTypeNames.has(name) && !localDeclaredNames.has(name)) {
          dangling.add(name);
        }
      }
    }
  }

  // Emit the sibling d.ts's type-level declarations (interfaces / type aliases
  // / enums) verbatim, so the exact signatures pasted onto the JS functions
  // resolve to their real shapes. Skip any name a @typedef already defines.
  if (declarations !== undefined && declarations.typeDeclarations.length > 0) {
    const emitted = new Set(definedNames);
    const declTexts: string[] = [];
    for (const decl of declarations.typeDeclarations) {
      if (emitted.has(decl.name)) {
        continue;
      }
      emitted.add(decl.name);
      declTexts.push(decl.text);
    }
    if (declTexts.length > 0) {
      const insertAt = source.startsWith('#!') ? (source.indexOf('\n') + 1 || 0) : 0;
      edits.add(insertAt, `${declTexts.join('\n\n')}\n\n`);
      warn(
        `Merged ${declTexts.length} type declaration(s) from ${declarations.dtsPath}.`,
        insertAt,
      );
    }
  }

  if (options.banner) {
    const banner = [
      '/**',
      ' * Generated by deany from JSDoc and inferred usage.',
      ' * Regenerate instead of editing this file by hand.',
      ' */',
      '',
    ].join('\n');
    const insertAt = source.startsWith('#!') ? (source.indexOf('\n') + 1 || 0) : 0;
    edits.add(insertAt, banner);
  }

  if (dangling.size > 0) {
    const aliases = [...dangling]
      .sort()
      .map((name) => `type ${name} = unknown;`)
      .join('\n');
    const insertAt = source.startsWith('#!') ? (source.indexOf('\n') + 1 || 0) : 0;
    edits.add(insertAt, `${aliases}\n\n`);
    warn(
      `Generated ${dangling.size} fallback type alias(es) for unresolved JSDoc types: ${[...dangling].sort().join(', ')}.`,
      insertAt,
    );
  }

  return { fileName, output: edits.apply(source), diagnostics };
}
