import * as ts from 'typescript';
import type { ConvertOptions, JsDocBlock } from '../types.js';
import { leadingJsDoc } from '../jsdoc.js';
import type { UsageResolver } from '../inferAny.js';
import { normalizeJsDocType, normalizeRestType, objectTypeFromProperties } from '../normalize.js';

import { EditBuffer, findParens, isFunctionLike } from './astUtil.js';
import type { FunctionLikeNode } from './astUtil.js';

/**
 * Detect a callback passed to a method call on a receiver that the converter
 * will give a concrete type via JSDoc, so lib.d.ts will contextually type the
 * callback parameters. Covers `sum(nums)` where `nums` has `@param {...number}`
 * (converted to `number[]`), or a variable with an inline `@type` array tag.
 */
export function callbackReceiverHasJSDocType(
  node: FunctionLikeNode,
  resolver: UsageResolver | undefined,
  sourceFile: ts.SourceFile,
  source: string,
  blocks: readonly JsDocBlock[],
): boolean {
  if (resolver === undefined) {
    return false;
  }
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
  const receiver = callee.expression;
  const receiverName = receiver.text;
  // Compare by symbol identity, not by spelling. The checker resolves
  // shadowing, same-named parameters in sibling scopes, closures and import
  // aliases for us; matching `declName.text === receiverName` can latch onto a
  // same-named declaration elsewhere in the file and wrongly skip callback
  // annotation (leaving `x` an implicit any).
  const receiverSymbol = resolver.symbolOf(receiver);
  if (receiverSymbol === undefined) {
    return false;
  }

  // Find the receiver's actual declaration (parameter or variable) by symbol,
  // then check whether it carries a JSDoc yielding an array type after
  // conversion.
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    let declName: ts.Identifier | undefined;
    if ((ts.isParameter(n) || ts.isVariableDeclaration(n)) && ts.isIdentifier(n.name)) {
      declName = n.name;
    }
    if (declName !== undefined && resolver.symbolOf(declName) === receiverSymbol) {
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
export function annotateImplicitAnyCallback(
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
  if (callbackReceiverHasJSDocType(node, resolver, sourceFile, source, blocks)) {
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

export function functionTypeFromCallback(
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

export function typeForTaggedDeclaration(
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
