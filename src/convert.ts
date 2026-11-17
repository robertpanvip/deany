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
import { leadingJsDoc, parseJsDocBlocks, parseTemplateNames } from './jsdoc.js';
import {
  extractCustomTypeNames,
  normalizeJsDocType,
  normalizeRestType,
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
): void {
  if (resolver === undefined || node.parameters.length === 0) {
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

  if (unparenthesized) {
    // `x => ...` cannot carry a type annotation; rewrite to `(x: T) => ...`.
    const first = toAnnotate[0];
    if (first !== undefined && resolver.isImplicitAnyParameter(first)) {
      const start = first.getStart(sourceFile);
      const end = first.name.end;
      const rest = first.dotDotDotToken ? `${defaultType}[]` : defaultType;
      edits.add(start, '(');
      edits.add(end, `: ${rest})`);
    }
    return;
  }

  for (const parameter of toAnnotate) {
    const rest = parameter.dotDotDotToken ? `${defaultType}[]` : defaultType;
    edits.add(parameter.name.end, `: ${rest}`);
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
    const genericSuffix =
      typeParameters.length > 0 ? `<${typeParameters.join(', ')}>` : undefined;

    let returnAnnotation: string | undefined;
    if (!skipReturn) {
      if (returnTag?.typeText !== undefined) {
        let returnType = normalizeJsDocType(returnTag.typeText, options);
        if (async) {
          returnType = wrapAsyncReturn(returnType, options);
        }
        returnAnnotation = `: ${returnType}`;
      } else {
        const inferred = resolver?.infer(node);
        if (inferred !== undefined) {
          returnAnnotation = `: ${async ? wrapAsyncReturn(inferred, options) : inferred}`;
        } else if (options.annotateUntyped) {
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
        if (tag?.typeText !== undefined) {
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
        if (tag?.typeText !== undefined) {
          const type = parameter.dotDotDotToken || tag.variadic
            ? normalizeRestType(tag.typeText, options)
            : normalizeJsDocType(tag.typeText, options);
          const optional =
            tag.optional && parameter.initializer === undefined && parameter.dotDotDotToken === undefined;
          annotation = `${optional ? '?' : ''}: ${type}`;
        } else {
          const inferred = resolver?.infer(parameter);
          if (inferred !== undefined) {
            annotation = `: ${parameter.dotDotDotToken && !inferred.endsWith('[]') ? `${inferred}[]` : inferred}`;
          } else if (options.annotateUntyped) {
            annotation = `: ${parameter.dotDotDotToken ? `${options.defaultType}[]` : options.defaultType}`;
          }
        }
        if (annotation !== undefined) {
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
    // `for (const x of ys)` forbids a type annotation on the loop binding.
    if (
      ts.isVariableDeclarationList(node.parent) &&
      (ts.isForOfStatement(node.parent.parent) || ts.isForInStatement(node.parent.parent))
    ) {
      return;
    }
    let type = doc === undefined ? undefined : typeForTaggedDeclaration(doc, options);
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
    edits.add(node.name.end, `: ${type}`);
  };

  const processProperty = (node: ts.PropertyDeclaration, doc: JsDocBlock | undefined): void => {
    let type = doc === undefined ? undefined : typeForTaggedDeclaration(doc, options);
    if (type === undefined) {
      type = resolver?.infer(node);
    }
    if (type === undefined && options.annotateUntyped) {
      type = options.defaultType;
    }
    if (type === undefined) {
      return;
    }
    const needsDefiniteAssignment =
      node.initializer === undefined &&
      node.questionToken === undefined &&
      !(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) ?? false);
    edits.add(node.name.end, needsDefiniteAssignment ? `!: ${type}` : `: ${type}`);
  };

  const processThisAssignment = (
    node: ts.BinaryExpression,
    doc: JsDocBlock,
  ): void => {
    const left = node.left;
    if (!ts.isPropertyAccessExpression(left) || !ts.isIdentifier(left.name)) {
      return;
    }
    const type = typeForTaggedDeclaration(doc, options);
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
    edits.add(classNode.members.pos, `\n  ${className}: ${type};`);
  };

  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node) && !processed.has(node)) {
      processed.add(node);
      const doc = leadingJsDoc(node, sourceFile, source, blocks);
      if (doc !== undefined || !isCallbackArgument(node)) {
        processFunction(node, doc);
      } else if (options.annotateUntypedCallbacks) {
        // A callback without JSDoc: only annotate parameters that truly lack
        // contextual typing. Contextual callbacks are left to TS inference.
        annotateImplicitAnyCallback(node, resolver, sourceFile, source, options.defaultType, edits);
      }
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      const doc = leadingJsDoc(node, sourceFile, source, blocks);
      if (doc !== undefined) {
        processThisAssignment(node, doc);
      }
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
  const definedNames = new Set<string>();
  for (const block of blocks) {
    for (const tag of block.tags) {
      if ((tag.tag === 'typedef' || tag.tag === 'callback') && tag.name !== undefined) {
        definedNames.add(tag.name);
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
  const dangling = new Set<string>();
  for (const block of blocks) {
    for (const tag of block.tags) {
      if (tag.typeText === undefined) {
        continue;
      }
      for (const name of extractCustomTypeNames(tag.typeText, definedNames, templateNames)) {
        dangling.add(name);
      }
    }
  }

  if (options.banner) {
    const banner = [
      '/**',
      ' * Generated by jsdoc2strict-ts from JSDoc annotations.',
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
