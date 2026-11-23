// Declaration-level evidence collection and the opaque-callback signature.
import * as ts from 'typescript';

import { isClassifierParamReference, isTypeClassifierParameter } from './classifiers.js';
import { statementsMayFallThrough } from './flow.js';
import { collectedType, ownerFunctionName, ownerHasNumericNameHint } from './helpers.js';
import { constraintsFromReference } from './reference.js';
import { callsOf, referencesOf } from '../collect.js';
import { functionNameSuggestsReturnType, variableNameSuggestsType } from '../constants.js';
import { collectMutationEvidence, containerInstantiationFromMutations } from '../mutation.js';
import { declaredTypeOf, isExportedParameter } from '../publicApi.js';
import { addSource, addWeakSource, emptyEvidence } from '../state.js';
import type { Evidence, InferenceContext } from '../types.js';
import { arithmeticNumberType, typeText } from '../typeText.js';
import { arrayElementTypeOf, isFunctionLike, isSelfReferentialType, mergeMutationEvidence, requireModuleType, symbolOf } from '../util.js';

export function collectEvidence(owner: ts.Node, ctx: InferenceContext, depth = 0): Evidence {
  // Attribute every table read in this collection (including recursive ones)
  // to the top-level owner being inferred, so dependency edges point at the
  // real owner rather than an intermediate recursive node.
  if (depth === 0) ctx.activeOwner = owner;
  const evidence = emptyEvidence();

  // Weak naming hints (lowest confidence), consumed only when NO real evidence
  // exists — never outrank sources, constraints or properties.
  // - numeric-accumulator function name -> its PARAMETERS are numeric (round 12)
  // - boolean/array/string function name -> its RETURN type (round 15)
  evidence.nameHintNumber = ownerHasNumericNameHint(owner);
  if (isFunctionLike(owner) && !ts.isConstructorDeclaration(owner)) {
    const fnName = ownerFunctionName(owner);
    if (fnName !== undefined) {
      evidence.nameHintReturnType = functionNameSuggestsReturnType(fnName);
    }
  }

  // Weak variable-name hint: a variable with NO initializer and no other name
  // evidence may get a low-confidence type from its name (`let names;` ->
  // `unknown[]`). Variables WITH an initializer are left alone — the
  // initializer is real evidence and will populate `sources`. The hint is only
  // consumed when no real evidence exists, so it never overrides real data.
  // (Review round 14.)
  if (ts.isVariableDeclaration(owner) && owner.initializer === undefined) {
    const varName = ts.isIdentifier(owner.name) ? owner.name.text : undefined;
    if (varName !== undefined) {
      evidence.nameHintType = variableNameSuggestsType(varName);
    }
  }

  // A sibling `.d.ts` is the authoritative contract. If this declaration is
  // covered by one, its declared type is the highest-confidence evidence and
  // short-circuits all usage inference — an internal call site must never
  // narrow a value whose public type was already declared.
  if (ctx.dtsProviders !== undefined) {
    const sourceFile = owner.getSourceFile();
    const provider = sourceFile === undefined ? undefined : ctx.dtsProviders.get(sourceFile.fileName);
    const declared = declaredTypeOf(owner, provider, ctx.checker);
    if (declared !== undefined) {
      addSource(evidence, declared);
      return evidence;
    }
  }

  // Type-classifier parameters accept any value: keep them `unknown` instead
  // of narrowing from their own type probes or from call-site arguments.
  if (isTypeClassifierParameter(owner, ctx)) {
    addSource(evidence, 'unknown');
    return evidence;
  }

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
        // A destructured binding — `function f({ a = 1, b = 'x' } = {})` or
        // `const { signal } = opts` — declares its object shape partly through
        // the binding elements themselves. Without this, the `= {}` initializer
        // (or an opaque `opts`) yields a bare `{}` and every `a`/`signal` access
        // raises TS2339/TS18046. Two authoritative, non-guessed sources feed each
        // field: the element's default value, and — when it has none — the shape
        // inferred from how that element is used (`signal.aborted`,
        // `signal.addEventListener(...)`). objectLiteralInit lets mergeEvidence
        // emit fields as optional where the whole binding may be omitted.
        if (ts.isObjectBindingPattern(owner.name)) {
          for (const element of owner.name.elements) {
            if (element.dotDotDotToken !== undefined) {
              continue;
            }
            const keyNode = element.propertyName ?? element.name;
            if (!ts.isIdentifier(keyNode) && !ts.isStringLiteral(keyNode) && !ts.isNumericLiteral(keyNode)) {
              continue;
            }
            const key = keyNode.text;
            let fieldType = element.initializer !== undefined ? typeText(ctx, element.initializer) : undefined;
            if (fieldType === undefined) {
              // No default: fall back to the element's own usage-derived shape.
              // Compute directly rather than reading the table — a parent is
              // visited before its binding elements, so the table may be empty
              // for the element on the first pass and the parent then freezes.
              const elementType = collectedType(element, ctx, depth + 1);
              if (elementType !== undefined && elementType !== 'unknown' && elementType !== 'never') {
                fieldType = elementType;
              }
            }
            if (fieldType !== undefined && !evidence.properties.has(key)) {
              evidence.properties.set(key, fieldType);
            }
          }
        }
        // A non-empty array literal that is later pushed/assigned with values
        // of other types must widen its element type to their union. The checker
        // fixes the element type at the literal (`const a = [1]` -> number[]),
        // so `a.push('x')` would be TS2345. Container mutation is covariant
        // evidence, so merge it with the literal's own element type — the same
        // treatment the empty-array branch above already applies. `unshift` and
        // index assignment are handled by collectMutationEvidence too.
        let arrayLiteralHandled = false;
        if (ts.isArrayLiteralExpression(init) && init.elements.length > 0) {
          const elementType = typeText(ctx, init); // e.g. `number[]` / `Array<number>`
          const element = arrayElementTypeOf(elementType);
          if (element !== undefined) {
            const writes = collectMutationEvidence(owner, 'collection', ctx);
            const merged = mergeMutationEvidence(element, writes.filter((t) => t !== 'never'));
            if (merged !== undefined && merged !== element) {
              addSource(evidence, `Array<${merged}>`);
              arrayLiteralHandled = true;
            }
          }
        }

        // A CommonJS `require('mod')` initializer prints as a self-referential
        // type (`typeof util`, `path.PlatformPath`, `typeof fs`) that TypeScript
        // rejects (TS2502/TS2503). Re-express it as `typeof import("mod")`,
        // which keeps the real module type without naming the local binding.
        let initializerType = requireModuleType(init) ?? typeText(ctx, init);
        // `new Map()` / `new Set()` / `new Promise(...)` without explicit type
        // arguments get `Map<any, any>` etc. from the checker. A tool whose
        // purpose is to eliminate `any` must not emit it: those slots are
        // genuinely unknown, so normalize them. Only do this when the source
        // has no explicit type arguments (`new Map<string, n>()` is the user's
        // declared choice and must be kept).
        if (ts.isNewExpression(init) && init.typeArguments === undefined) {
          // `new Map()` / `new Set()` without explicit generics: prefer a
          // concrete instantiation recovered from `set(k, v)` / `add(v)`
          // mutations (the same covariant evidence used for arrays). Only
          // accept it when the checker's own type was an opaque `any` slot —
          // a non-any initializer type must not be overridden by a guess.
          const ctorText = init.expression.getText();
          const containerKind: 'map' | 'set' | undefined =
            /^(Readonly)?Map$/.test(ctorText)
              ? 'map'
              : /^(Readonly)?Set$/.test(ctorText)
                ? 'set'
                : undefined;
          let instantiated: string | undefined;
          if (
            containerKind !== undefined &&
            initializerType !== undefined &&
            /\bany\b/.test(initializerType)
          ) {
            instantiated = containerInstantiationFromMutations(owner, containerKind, ctx);
          }
          if (instantiated !== undefined) {
            initializerType = instantiated;
          } else if (initializerType !== undefined && /\bany\b/.test(initializerType)) {
            initializerType = initializerType.replace(/\bany\b/g, 'unknown');
          }
        }
        const bindingName = ts.isIdentifier(owner.name) ? owner.name.text : undefined;
        if (
          !arrayLiteralHandled &&
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
        // JS `+` yields number (addition) or string (concatenation). When its
        // operands carry no concrete type the expression is opaque and the
        // fallback below emits `unknown`. Record that the returned expression
        // is a `+` so the merge stage can narrow that bare-`unknown` fallback
        // to the honest `string | number`. Purely syntactic (no dependency on
        // fixed-point type state). (Review round 13.)
        if (
          ts.isBinaryExpression(node.expression) &&
          node.expression.operatorToken.kind === ts.SyntaxKind.PlusToken
        ) {
          evidence.returnsAddExpression = true;
        }
        const returned =
          typeText(ctx, node.expression) ?? arithmeticNumberType(ctx, node.expression);
        // An opaque returned expression (e.g. `return x[0]` / `return x.length`
        // while `x` is still implicit any) yields no type text. Dropping that
        // branch would let the *other* concrete returns define the function's
        // annotated return type, which strict mode then rejects as too narrow
        // (TS2322/TS2345) because the opaque value is really returned. Contribute
        // `unknown` so the function's return is the honest union of all branches
        // — "cannot tell" must not turn into a confident narrower type.
        addSource(evidence, returned ?? 'unknown');
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
    } else if (hasValueReturn && statementsMayFallThrough(owner.body.statements)) {
      // Some paths return a value but control can also reach the end of the
      // body, so the function implicitly returns `undefined` on those paths.
      // Without this the inferred `T` is too narrow and strict mode emits
      // TS2366. Add `undefined` so the honest union `T | undefined` is emitted.
      addSource(evidence, 'undefined');
    }
  } else if (isFunctionLike(owner) && owner.body !== undefined && !ts.isBlock(owner.body)) {
    // Expression-bodied arrow (`(a, b) => a + b`): the body expression is the
    // implicit return value. If it is an anchor-less `+` (neither operand has a
    // concrete number type), record it so the merge stage can fall back to
    // `string | number` instead of an opaque `unknown`. The anchor check is
    // essential: in `c => a + b + c` with a/b/c typed number (e.g. a nested
    // JSDoc function type), the result is a concrete number and must NOT be
    // widened — arithmeticNumberType returns 'number' there, so no mark.
    // (Review round 13.)
    if (
      ts.isBinaryExpression(owner.body) &&
      owner.body.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      arithmeticNumberType(ctx, owner.body) === undefined
    ) {
      evidence.returnsAddExpression = true;
    }
  }

  const symbol = symbolOf(owner, ctx.checker);
  if (symbol !== undefined) {
    for (const reference of referencesOf(symbol, ctx)) {
      constraintsFromReference(reference, ctx, evidence, depth);
    }
  }

  if (ts.isParameter(owner) && isFunctionLike(owner.parent)) {
    const functionNode = owner.parent;
    const index = functionNode.parameters.indexOf(owner);
    // S4: for an exported (public-API) parameter, internal call-site arguments
    // are NOT a reliable contract — outside callers may supply any value. Route
    // that evidence to `weakSources`, which never outranks real usage evidence
    // and cannot by itself narrow the parameter. Non-exported parameters keep
    // the original strong behaviour so internal inference is unaffected.
    const weakCallSites = ctx.narrowExportedParams === true && isExportedParameter(owner, ctx.checker);
    for (const call of callsOf(functionNode, ctx)) {
      const argument = call.arguments?.[index];
      if (argument !== undefined) {
        // A type-classifier parameter's `unknown` is an honest "any value"
        // answer, not a concrete observation — do not let it flow into this
        // parameter as call-site evidence (which would erode, e.g., a `has(k)`
        // that reads `k._reactInternals` down to `unknown` and raise TS18046).
        if (isClassifierParamReference(argument, ctx)) {
          continue;
        }
        // An unannotated callback argument (`apply(s => s.length, 'x')`) has
        // no useful checker type — its params are implicit `any`, so typeText
        // yields `(s: any) => any`. Instead of injecting `any`, build a
        // signature from each callback parameter's own usage-derived type
        // (e.g. `s.length` -> `{ length: unknown }`). This gives the higher-
        // order parameter a precise callable type that the callback argument
        // satisfies, instead of a generic `(...args: unknown[])` that cannot
        // accept a narrowed callback (TS2345).
        const callbackSig = opaqueCallbackSignature(argument, ctx, depth);
        let evidenceType = callbackSig ?? typeText(ctx, argument);
        // A call-site empty-array literal (`f([], items)`) has checker type
        // `never[]`. Taken as a strong source for the parameter it freezes the
        // parameter at `Array<never>`, so every later `param.push(x)` inside
        // the callee fails with TS2345 ("number not assignable to never").
        // This is the call-site counterpart of the initializer empty-array
        // widening above (and review 0.1.17 P1-16): use the parameter's own
        // covariant `push`/index writes to synthesize `Array<T>`, or fall back
        // to the strict-safe `Array<unknown>` when every write is opaque.
        // Never invent a concrete element type — only real writes qualify.
        if (
          callbackSig === undefined &&
          ts.isArrayLiteralExpression(argument) &&
          argument.elements.length === 0 &&
          evidenceType !== undefined &&
          /^(Array<never>|never\[\])$/.test(evidenceType)
        ) {
          const writes = collectMutationEvidence(owner, 'collection', ctx);
          const element = mergeMutationEvidence(undefined, writes.filter((t) => t !== 'never'));
          evidenceType = element !== undefined ? `Array<${element}>` : 'Array<unknown>';
        }
        if (weakCallSites) {
          addWeakSource(evidence, evidenceType);
        } else {
          addSource(evidence, evidenceType);
        }
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
            constraintsFromReference(reference, ctx, evidence, depth);
          }
        }
      }
    }
  }

  return evidence;
}

/**
 * Build a callable signature for an unannotated callback argument from its
 * parameters' usage-derived types. The checker reports implicit-any for these
 * parameters (`(s: any) => any`), which is information-free; the inference
 * table (populated from member accesses inside the callback body) has the real
 * shape. Returns undefined when no parameter has a concrete inferred type.
 */
export function opaqueCallbackSignature(
  node: ts.Expression,
  ctx: InferenceContext,
  depth = 0,
): string | undefined {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) {
    return undefined;
  }
  if (node.parameters.length === 0) {
    return undefined;
  }
  const params: string[] = [];
  for (const param of node.parameters) {
    if (param.type !== undefined) {
      return undefined; // annotated callback: let typeText use the real type
    }
    const apparent = ctx.checker.getTypeAtLocation(param);
    if ((apparent.flags & ts.TypeFlags.Any) === 0) {
      return undefined; // has a real contextual type: not opaque
    }
    // Compute directly: a call argument is visited before its callback's
    // parameters are entered into the table, so reading the table here would
    // see `undefined` on the first fixed-point pass.
    const inferred = collectedType(param, ctx, depth + 1);
    params.push(
      param.dotDotDotToken
        ? `...${param.name.getText()}: ${inferred ?? 'unknown'}[]`
        : `${param.name.getText()}: ${inferred ?? 'unknown'}`,
    );
  }
  return `( ${params.join(', ')} ) => unknown`;
}
