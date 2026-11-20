import { DEFAULT_OPTIONS } from '../types.js';
import type { ConvertOptions, ConvertResult, Diagnostic, JsDocBlock, JsDocTag } from '../types.js';
import type { UsageResolver } from '../inferAny.js';
import { memberKey } from '../dts.js';
import type { DeclarationProvider, DtsSignature } from '../dts.js';
import * as ts from 'typescript';
import { leadingJsDoc, parseJsDocBlocks, parseTemplateNames } from '../jsdoc.js';
import { extractCustomTypeNames, normalizeJsDocType, normalizeRestType, objectTypeFromDottedParams, objectTypeFromProperties, wrapAsyncReturn } from '../normalize.js';

import { EditBuffer, describe, enclosingClass, findParens, functionBodyYieldsValue, hasModifier, isCallbackArgument, isFunctionLike, isGenerator, isReturnPositionArrow, keywordEnd, parameterName } from './astUtil.js';
import type { FunctionLikeNode } from './astUtil.js';
import { annotateImplicitAnyCallback, functionTypeFromCallback, typeForTaggedDeclaration } from './callback.js';

/** Convert a JavaScript source string into strict TypeScript source text. */
export function convertSource(
  fileName: string,
  sourceInput: string,
  optionsInput: Partial<ConvertOptions> = {},
  resolver?: UsageResolver,
  declarations?: DeclarationProvider,
): ConvertResult {
  const options: ConvertOptions = { ...DEFAULT_OPTIONS, ...optionsInput };
  // A UTF-8 BOM is counted by ts.createSourceFile as leading trivia (token
  // offsets start after it) but stays in the raw string used by EditBuffer.
  // That one-character skew made every annotation land before its name
  // (`const : numbera = 1;`, TS1134/TS1138). Strip it up front so the string,
  // the AST offsets and the edits all share one coordinate system.
  const source = sourceInput.charCodeAt(0) === 0xfeff ? sourceInput.slice(1) : sourceInput;
  // When a resolver is supplied, use its SourceFile so checker symbols line up.
  // A resolver built from a BOM-bearing file carries the same skew, so prefer
  // a fresh, BOM-free parse whenever the resolver's text does not match ours.
  const fromResolver =
    resolver !== undefined
      ? (resolver.getSourceFile(fileName) ?? resolver.getSourceFile(ts.sys.resolvePath(fileName)))
      : undefined;
  const sourceFile =
    fromResolver !== undefined && fromResolver.text === source
      ? fromResolver
      : ts.createSourceFile(
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
          // When the body provably yields no value (empty / side-effect-only),
          // `void` is the honest contract even without a resolver; `unknown`
          // would describe a value that is never returned (review P0-1).
          const fallback = functionBodyYieldsValue(node) ? options.defaultType : 'void';
          returnAnnotation = `: ${async ? wrapAsyncReturn(fallback, options) : fallback}`;
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
      let fromValue = resolver?.typeOf(node.right) ?? literalTypeOf(node.right);
      // An empty array literal is `Array<never>` to the checker; promoting a
      // field with that type rejects every later `push` (TS2345). Widen to the
      // honest `Array<unknown>` (review 0.1.17 P1-16).
      if (fromValue !== undefined && /^(Array<never>|never\[\])$/.test(fromValue)) {
        fromValue = 'Array<unknown>';
      }
      if (
        fromValue !== undefined &&
        fromValue !== 'any' &&
        fromValue !== 'never' &&
        fromValue !== 'void'
      ) {
        // `unknown` is a valid field type under strict mode. Promoting
        // `this.x = x` (x unresolved) to `x!: unknown` removes TS2339 on later
        // reads — omitting the field entirely left every `this.x` unresolved
        // (review 0.1.17 P1-15). `any`/`never`/`void` stay excluded (they add no
        // useful contract or are illegal as a field type).
        type = fromValue;
      }
    }
    if (type === undefined && ts.isIdentifier(node.right)) {
      // `this.x = x` where `x` is a (possibly still-untyped) constructor
      // parameter: the resolver has no standalone type for the parameter slot,
      // so promote the field with the honest `unknown` fallback. Leaving the
      // field undeclared made every later `this.x` a TS2339 (review P1-15).
      type = options.defaultType;
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
    // Idempotency: when a previously converted file is fed back in, the
    // promoted field (`v!: number;`) is already a real property declaration.
    // Promoting again emits a second one -> TS2300 Duplicate identifier.
    // Never re-promote a field the class already declares.
    const alreadyDeclared = classNode.members.some(
      (member) =>
        (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) &&
        member.name !== undefined &&
        ts.isIdentifier(member.name) &&
        member.name.text === className,
    );
    if (alreadyDeclared) {
      names.add(className);
      thisFields.set(classNode, names);
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
