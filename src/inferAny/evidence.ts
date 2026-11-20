import * as ts from 'typescript';

import type { Evidence, InferenceContext } from './types.js';
import { controlFlowNarrowedType } from './controlFlow.js';
import { addConstraint, addSource, addWeakSource, emptyEvidence } from './state.js';
import { declaredTypeOf, isExportedParameter } from './publicApi.js';
import { ARRAY_BUILTIN_MEMBERS, BITWISE_OPERATORS, BUILTIN_METHOD_RETURN, INDEXABLE_OBJECT, ITERATION_METHODS, MEMBERLESS_OBJECT_SOURCES, NUMERIC_COERCION_OPERATORS, REDUCER_METHODS, REDUCER_SIGNATURE, RELATIONAL_OPERATORS, VAGUE_RETURN_TYPES, nameSuggestsNumber } from './constants.js';
import { arrayElementTypeOf, isArrayIsArrayCall, isArrayTypeString, isFunctionLike, isSelfReferentialType, isUnderArrayIsArrayGuard, mergeMutationEvidence, objectArgumentIndices, requireModuleType, symbolOf, typeofLiteralToType, widenedTypeText } from './util.js';
import { customArrayMethodSignature, insertShapeChain, mergeEvidence, propertyChainsOf } from './shape.js';
import { arithmeticNumberType, instanceTypeOf, orderableOperandType, symbolTypeText, typePredicateOfArgument, typeText } from './typeText.js';
import { collectMutationEvidence, containerInstantiationFromMutations } from './mutation.js';
import { callsOf, referencesOf } from './collect.js';

/**
 * Whether control can reach the end of a statement list (i.e. fall through to
 * an implicit `undefined` return). Used so a function with a value return on
 * only *some* paths is typed `T | undefined`, not just `T` — otherwise strict
 * mode rejects it with TS2366 ("Function lacks ending return statement").
 * Conservative: anything we cannot prove always-terminating counts as a
 * possible fall-through, which only ever widens the type (safe).
 */
/**
 * For a call-argument spread `f(...x)` (or constructor spread `new C(...x)`),
 * resolve the callee's signature through the checker and return the constraint
 * the spread argument `x` must satisfy:
 *
 *  - rest signature (`...xs: number[]`) -> `number[]` (element type);
 *  - fixed-argument signature (`(a: number, b: string)`) -> a tuple
 *    `[number, string]`, because TypeScript only accepts a spread into fixed
 *    parameters when the argument is a tuple (TS2556 for a plain array);
 *  - optional parameters keep their `?` tuple marker;
 *  - zero resolvable information -> undefined, so the caller falls back to
 *    `unknown[]` (still an array, so the spread stays legal).
 *
 * Using the resolved signature — rather than the callee's source text — is
 * essential: a locally shadowed `Math.max` must not inherit the global one's
 * `number[]` contract (Architecture review 5). Sharing this logic between
 * calls and `new` expressions fixes the constructor-spread gap (review R5-1).
 */
function spreadCallConstraint(
  call: ts.CallExpression | ts.NewExpression,
  ctx: InferenceContext,
): string | undefined {
  const signature = ctx.checker.getResolvedSignature(call);
  if (signature === undefined) {
    return undefined;
  }

  // 1) Rest signature: the array's element type is the definite constraint.
  for (const parameter of signature.parameters) {
    const declaration = parameter.declarations?.[0];
    if (declaration === undefined || !ts.isParameter(declaration) || declaration.dotDotDotToken === undefined) {
      continue;
    }
    const restType = ctx.checker.getTypeOfSymbolAtLocation(parameter, call);
    // Arrays and tuples are both TypeReference in the checker's model.
    const elementType =
      (ctx.checker.isArrayType(restType) || ctx.checker.isTupleType(restType)) &&
      (restType.flags & ts.TypeFlags.Object) !== 0
        ? ctx.checker.getTypeArguments(restType as ts.TypeReference)[0]
        : undefined;
    if (elementType !== undefined) {
      const text = widenedTypeText(ctx.checker, elementType, call);
      if (text !== undefined && text !== 'never' && text !== 'any') {
        return `${text}[]`;
      }
    }
    // A rest parameter that is `any`/unresolved: constrain to an array so the
    // spread itself stays legal, without asserting an element type.
    return 'unknown[]';
  }

  // 2) Fixed-argument signature: TS requires a tuple for an argument spread.
  //    Build one from the resolved parameter types, preserving optionality.
  if (signature.parameters.length === 0) {
    return undefined; // zero-arg callee: any array spreads legally
  }
  const elements: string[] = [];
  for (const parameter of signature.parameters) {
    const parameterType = ctx.checker.getTypeOfSymbolAtLocation(parameter, call);
    let text = widenedTypeText(ctx.checker, parameterType, call);
    const declaration = parameter.declarations?.[0];
    const optional =
      declaration !== undefined &&
      ts.isParameter(declaration) &&
      (declaration.questionToken !== undefined || declaration.initializer !== undefined);
    if (text === undefined || text === 'never' || text === 'any') {
      text = 'unknown';
    }
    // A widened optional parameter reads `T | undefined`; a tuple's `?`
    // marker already carries that, so strip it to keep `T?` well-formed.
    if (optional) {
      text = text
        .replace(/\s*\|\s*undefined\b/g, '')
        .replace(/\bundefined\s*\|\s*/g, '');
      if (text === '' || text === 'undefined') {
        text = 'unknown';
      }
      elements.push(`${text}?`);
    } else {
      elements.push(text);
    }
  }
  return `[${elements.join(', ')}]`;
}

function statementsMayFallThrough(statements: readonly ts.Statement[]): boolean {
  for (const statement of statements) {
    if (statementAlwaysTerminates(statement)) {
      return false; // unreachable past this point
    }
  }
  return true;
}

function statementAlwaysTerminates(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
    return true;
  }
  if (ts.isBlock(statement)) {
    return statementsMayFallThrough(statement.statements) === false;
  }
  if (ts.isIfStatement(statement)) {
    // Terminates only if there is an else and BOTH branches terminate.
    return (
      statement.elseStatement !== undefined &&
      statementAlwaysTerminates(statement.thenStatement) &&
      statementAlwaysTerminates(statement.elseStatement)
    );
  }
  if (ts.isSwitchStatement(statement)) {
    // Terminates only with a default case and no fall-through out of any clause.
    const clauses = statement.caseBlock.clauses;
    if (!clauses.some((c) => ts.isDefaultClause(c))) {
      return false;
    }
    return clauses.every((clause) =>
      clause.statements.length > 0 && statementAlwaysTerminates(clause.statements[clause.statements.length - 1]!),
    );
  }
  if (ts.isTryStatement(statement)) {
    // Both try and every catch/finally path must terminate.
    const tryTerminates = statementsMayFallThrough(statement.tryBlock.statements) === false;
    const catchTerminates =
      statement.catchClause === undefined ||
      statementsMayFallThrough(statement.catchClause.block.statements) === false;
    const finallyTerminates =
      statement.finallyBlock === undefined ||
      statementsMayFallThrough(statement.finallyBlock.statements) === false;
    return tryTerminates && catchTerminates && finallyTerminates;
  }
  // Labeled statement wrapping a terminating statement.
  if (ts.isLabeledStatement(statement)) {
    return statementAlwaysTerminates(statement.statement);
  }
  return false;
}

/** Extract constraints from one reference to the `any`-typed binding. */
export function constraintsFromReference(
  reference: ts.Identifier,
  ctx: InferenceContext,
  evidence: Evidence,
  depth = 0,
): void {
  const parent = reference.parent;

  // Control-flow narrowing: inside a guard's true branch, ask the checker for
  // the type it has already narrowed this binding to. This is direct evidence
  // from the compiler's own flow analysis and covers guard shapes the syntactic
  // typeof/instanceof/isArray rules cannot see (truthiness, switch, negated
  // guards, custom predicates). Opaque / non-narrowing results are dropped.
  const flowNarrowed = controlFlowNarrowedType(reference, ctx);
  addSource(evidence, flowNarrowed);
  // When the checker has narrowed this reference to a *concrete* type (e.g.
  // `string` under `typeof x === 'string'`, or a class under `instanceof`),
  // member accesses on it belong to that concrete type — `string` already has
  // `toUpperCase`, `Foo` already has `bar`. Recording those member names in the
  // global property shape would let mergeEvidence intersect them onto an
  // unrelated memberless source from a sibling branch (e.g. turning `Function`
  // into `Function & { toUpperCase; toFixed }`). Only memberless / opaque
  // narrowings need the member shape as the sole evidence of the object's
  // members, so skip global shape collection for concrete narrowing sites.
  const narrowedToConcrete =
    flowNarrowed !== undefined &&
    !MEMBERLESS_OBJECT_SOURCES.has(flowNarrowed) &&
    !isArrayTypeString(flowNarrowed);

  // `const { a, b } = x` / `const { a } = x`: the binding elements pulled out of
  // `x` are real evidence for `x`'s shape. Each element is inferred on its own
  // from how it is used (`a.foo`, `b(...)`); fold those shapes back into `x` as
  // optional properties so destructuring yields typed bindings instead of
  // `unknown`. Without this, `signal` in `const { signal } = opts` collapses to
  // `unknown` and every `signal.aborted`/`signal.addEventListener` raises
  // TS2339/TS18046. Marking this owner as an object-literal init makes
  // mergeEvidence emit the fields as optional, matching the checker's shape.
  if (ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)) {
    const pattern: ts.ObjectBindingPattern = parent.name;
    for (const element of pattern.elements) {
      if (element.dotDotDotToken !== undefined) {
        continue;
      }
      const keyNode = element.propertyName ?? element.name;
      if (!ts.isIdentifier(keyNode) && !ts.isStringLiteral(keyNode) && !ts.isNumericLiteral(keyNode)) {
        continue;
      }
      // Compute the element's shape directly rather than reading the table:
      // parent declarations are visited before their binding elements, so the
      // table may not hold the element's type yet on the first fixed-point pass
      // (and the parent then freezes as a strong owner).
      const elementType = collectedType(element, ctx, depth + 1);
      const fieldType =
        (element.initializer !== undefined ? typeText(ctx, element.initializer) : undefined) ?? elementType;
      if (fieldType !== undefined && fieldType !== 'unknown' && fieldType !== 'never') {
        evidence.properties.set(keyNode.text, fieldType);
        evidence.objectLiteralInit = true;
      }
    }
  }

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

    // `o.a.b` / `o.a.b.c`: collect the full access chain so a parameter with
    // no other evidence becomes a nested object shape instead of `{ a:
    // unknown }` (which makes `o.a.b` a TS18046). Structural evidence only —
    // the code genuinely dereferences those properties. The first-level record
    // below still handles the simple `o.a` case and property writes.
    if (ts.isPropertyAccessExpression(grandparent) && grandparent.expression === parent) {
      // Walk outward to the longest property-access chain rooted at this
      // reference (`o.a.b.c` -> ['a','b','c']), then unwind it in order.
      let outermost: ts.PropertyAccessExpression = grandparent;
      while (
        ts.isPropertyAccessExpression(outermost.parent) &&
        outermost.parent.expression === outermost
      ) {
        outermost = outermost.parent;
      }
      const chain: string[] = [];
      let current: ts.Expression = outermost;
      while (ts.isPropertyAccessExpression(current)) {
        chain.unshift(current.name.text);
        current = current.expression;
      }
      if (ts.isIdentifier(current) && current === reference) {
        insertShapeChain(evidence.shapeChain, chain);
      }
    }

    const isMethodCall =
      ts.isCallExpression(grandparent) && grandparent.expression === parent;
    // Concrete-narrowed member accesses belong to the already-known concrete
    // type (string/number/class), so recording them globally would intersect
    // their members onto an unrelated memberless sibling source. Skip shape
    // collection at such sites; memberless/opaque narrowings still need it as
    // their only evidence of the binding's members.
    if (!narrowedToConcrete) {
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
        // A reduce/reduceRight call with an initial value gets a generic
        // accumulator signature. TS infers T from the real `init` argument, so
        // the callback parameters are contextually typed without ever guessing
        // a concrete element type — `list.reduce((a,b)=>a+b, 0)` becomes legal
        // instead of TS18046. Without an initializer there is no type anchor,
        // so keep the weak METHOD_TYPE (see probe: no-init cannot infer T).
        const reducerWithInit =
          isMethodCall &&
          ts.isCallExpression(grandparent) &&
          REDUCER_METHODS.has(parent.name.text) &&
          grandparent.arguments.length >= 2;
        evidence.properties.set(
          parent.name.text,
          reducerWithInit ? REDUCER_SIGNATURE : METHOD_TYPE,
        );
        // Record the contextual (expected) return type of the call, so the
        // lib-unique narrowing can verify the method's signature matches the
        // builtin. `getContextualType` yields number/string for annotated returns
        // and variable declarations, but nothing for bare/chained calls — those
        // stay unconstrained and still allow the weak narrowing.
        if (isMethodCall) {
          const contextual = ctx.checker.getContextualType(grandparent as ts.CallExpression);
          if (contextual !== undefined) {
            const text = ctx.checker.typeToString(contextual);
            const list = evidence.methodReturnTypes.get(parent.name.text) ?? [];
            if (!list.includes(text)) {
              list.push(text);
            }
            evidence.methodReturnTypes.set(parent.name.text, list);
            // If the observed return context contradicts the builtin method's
            // real return type, this is NOT the builtin method (it is a custom
            // same-named method). Replace the generic METHOD_TYPE with a
            // signature returning the observed type: this both blocks the weak
            // narrowing (value is no longer METHOD_TYPE) and keeps the call
            // type-correct under strict mode (return is `text`, not `unknown`).
            const builtinReturn = BUILTIN_METHOD_RETURN.get(parent.name.text);
            if (
              builtinReturn !== undefined &&
              !VAGUE_RETURN_TYPES.has(text) &&
              text !== builtinReturn
            ) {
              evidence.properties.set(parent.name.text, `(...args: unknown[]) => ${text}`);
            }
          }
        }
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
          // A real argument passed to a rest parameter (`console.log(msg)` ->
          // `...data: any[]`) constrains the argument to the ELEMENT type, not
          // the whole array. Using the array type produced `msg: any[]` and
          // `Math.max(v, 1)` -> `v: number[]` (TS2345) — review 0.1.17 P1-14.
          const isRest =
            parameterDecl !== undefined &&
            ts.isParameter(parameterDecl) &&
            parameterDecl.dotDotDotToken !== undefined;
          let paramText = symbolTypeText(ctx, parameter, parent);
          if (isRest && paramText !== undefined) {
            const restType = ctx.checker.getTypeOfSymbolAtLocation(parameter, parent);
            const elementType =
              (ctx.checker.isArrayType(restType) || ctx.checker.isTupleType(restType)) &&
              (restType.flags & ts.TypeFlags.Object) !== 0
                ? ctx.checker.getTypeArguments(restType as ts.TypeReference)[0]
                : undefined;
            if (elementType !== undefined) {
              paramText = widenedTypeText(ctx.checker, elementType, parent);
            }
          }
          const inferred =
            parameterDecl === undefined ? undefined : ctx.table.declarations.get(parameterDecl);
          addConstraint(evidence, inferred ?? paramText ?? 'unknown');
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

  // Spread has two distinct type requirements in TypeScript:
  //   - array/iterable spread  `[...x]`  → x only needs to be Iterable<T>
  //     (a generator or Set is equally valid — Architecture review 1.6).
  //   - call-argument spread    `f(...x)` → x must be an array/tuple type;
  //     `Iterable<T>` is NOT accepted as spread arguments (TS2556/TS2345).
  // Object spread (`{...x}`) is excluded entirely: it accepts any value.
  if (
    ts.isSpreadElement(parent) &&
    parent.expression === reference &&
    !ts.isObjectLiteralExpression(parent.parent)
  ) {
    const call = parent.parent;
    if (ts.isCallExpression(call) || ts.isNewExpression(call)) {
      // Resolve the callee/constructor signature through the checker (NOT by
      // name): a locally shadowed `Math.max` must not inherit the global's
      // number[]. Rest signatures yield the element type; fixed-argument
      // signatures yield a tuple (else TS2556). `new C(...x)` shares the same
      // path. Fall back to `unknown[]` so the spread stays legal (review R5-1).
      addConstraint(evidence, spreadCallConstraint(call, ctx) ?? 'unknown[]');
    } else {
      // Array / iterable spread — Iterable is sufficient and more permissive.
      addConstraint(evidence, 'Iterable<unknown>');
    }
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
  // `x[k]` / `x[k] = v`: the key itself must be a PropertyKey. This is a real
  // JS language requirement (index expressions are coerced to string/symbol),
  // not a name guess. Without it the key binding stays `unknown` and strict
  // rejects the index (TS2538), even when the container was correctly inferred
  // as Record<PropertyKey, unknown>.
  if (
    ts.isElementAccessExpression(parent) &&
    parent.argumentExpression === reference
  ) {
    addConstraint(evidence, 'PropertyKey');
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
    const arithmeticType = arithmeticNumberType(ctx, parent);
    // `+` with no concrete operand type: JS may add or concatenate, so no
    // numeric source is justified. Mark the binding so that, if it ends up
    // with no other evidence, it falls back to `any` (faithful to the original
    // untyped JS) instead of `unknown` (which makes `a + b` a TS18046).
    // `arithmeticNumberType` returns a type only when one side is already
    // number, so this branch is exactly the "no anchor" case for `+`.
    if (
      parent.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      arithmeticType === undefined
    ) {
      evidence.ambiguousAdd = true;
    }
    addSource(evidence, arithmeticType);
    // `-`, `*`, `/`, `%`, `**` coerce both operands to number in JS and never
    // concatenate, so an operand seen here is definitely numeric. `+` is
    // excluded (it may be string concatenation), which is why it is handled
    // by `arithmeticNumberType` only when the other side is already number.
    if (NUMERIC_COERCION_OPERATORS.has(parent.operatorToken.kind)) {
      addSource(evidence, 'number');
    }
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
      // Both operands of a relational comparison must be comparable. If the
      // other side is a concrete orderable primitive, require the same type
      // here instead of the generic `number | string` — otherwise `let n = 0;
      // n < x` widens x to `number | string` and the comparison itself becomes
      // illegal (TS2365).
      const other = parent.left === reference ? parent.right : parent.left;
      addConstraint(evidence, orderableOperandType(ctx, other) ?? 'number | string');
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

  // `for (const v of x)` -> x must be ITERABLE, not necessarily an array.
  // Emitting `T[]` used to reject originally-legal `for...of` inputs (Set,
  // Generator, string). The loop body only proves the iteration *protocol* and,
  // when it pins the element to a primitive (`t += v`), the element type —
  // neither implies an array. `Iterable<T>` keeps the body type-checking while
  // accepting every value the original JS accepted. (Architecture review 1.2/1.6.)
  // The element match uses SYMBOL IDENTITY, not the binding's spelling: a nested
  // same-named local (`() => { const v = 1; t += v; }`) must not be mistaken for
  // the loop variable and pollute the element type. (Architecture review 1.4.)
  if (ts.isForOfStatement(parent) && parent.expression === reference) {
    let elementType = 'unknown';
    const initializer = parent.initializer;
    if (ts.isVariableDeclarationList(initializer) && initializer.declarations.length > 0) {
      const binding = initializer.declarations[0];
      if (binding !== undefined) {
        // (a) Existing primitive-accumulator evidence: `acc += v` pins the
        // element to number/string. Symbol identity avoids shadowed locals.
        if (ts.isIdentifier(binding.name)) {
          const loopVarSymbol = ctx.checker.getSymbolAtLocation(binding.name);
          if (loopVarSymbol !== undefined) {
            let concrete: string | undefined;
            const scanBody = (n: ts.Node): void => {
              if (
                ts.isBinaryExpression(n) &&
                (n.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken ||
                  NUMERIC_COERCION_OPERATORS.has(n.operatorToken.kind)) &&
                ts.isIdentifier(n.right) &&
                ctx.checker.getSymbolAtLocation(n.right) === loopVarSymbol
              ) {
                const accType = widenedTypeText(ctx.checker, ctx.checker.getTypeAtLocation(n.left), n.left);
                if (accType === 'number' || accType === 'string') {
                  concrete = accType;
                }
              }
              ts.forEachChild(n, scanBody);
            };
            scanBody(parent.statement);
            if (concrete !== undefined) {
              elementType = concrete;
            }
          }
        }

        // (b) Structural element evidence: dereferences in the loop body
        // (`for (const v of xs) { v.a.b }`) prove the element's shape. Fold the
        // same property chains used for iteration callbacks into elementShape;
        // mergeEvidence refines `Iterable<unknown>` into `Iterable<shape>` so
        // the very body we inspected type-checks. Destructured bindings
        // (`for (const { a } of xs)`) prefix the chain with the property key.
        // (Line-by-line review bugs B2/B3.)
        if (elementType === 'unknown') {
          if (ts.isIdentifier(binding.name)) {
            for (const chain of propertyChainsOf(binding.name, parent.statement, ctx)) {
              insertShapeChain(evidence.elementShape, chain);
            }
          } else if (ts.isObjectBindingPattern(binding.name)) {
            for (const element of binding.name.elements) {
              const keyNode = element.propertyName ?? element.name;
              if (
                !ts.isIdentifier(keyNode) &&
                !ts.isStringLiteral(keyNode) &&
                !ts.isNumericLiteral(keyNode)
              ) {
                continue;
              }
              const key = keyNode.text;
              insertShapeChain(evidence.elementShape, [key]);
              if (ts.isIdentifier(element.name)) {
                for (const chain of propertyChainsOf(element.name, parent.statement, ctx)) {
                  insertShapeChain(evidence.elementShape, [key, ...chain]);
                }
              }
            }
          }
        }
      }
    }
    // `for await...of` accepts BOTH sync iterables and async iterables in JS.
    // Emitting only Iterable<T> rejects an AsyncGenerator; only AsyncIterable<T>
    // rejects an array. Their union preserves the original call range.
    // (Architecture review 1.2.)
    const protocol =
      parent.awaitModifier !== undefined
        ? `Iterable<${elementType}> | AsyncIterable<${elementType}>`
        : `Iterable<${elementType}>`;
    addConstraint(evidence, protocol);
  }

  // Destructuring: `const [a, b] = x` -> x is array-like; `const { foo } = x`
  // -> x has those properties (a synthesized object shape, as a weak source).
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === reference &&
    ts.isArrayBindingPattern(parent.name)
  ) {
    // Array destructuring requires an Iterable, not an Array (a Set or a
    // generator can be destructured too). Use the protocol, not the concrete.
    addConstraint(evidence, 'Iterable<unknown>');
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

  // `await x` proves almost nothing about x: JavaScript's await accepts any
  // value (numbers, strings, plain objects, thenables alike). Emitting a
  // `PromiseLike<unknown>` constraint here used to narrow `f(value: any)` where
  // the body is just `await value` to `PromiseLike<unknown>`, rejecting the
  // originally-legal `f(123)` / `f('hello')`. Since every value is awaitable,
  // this usage yields no usable protocol constraint — deliberately emit none,
  // so the binding keeps `any`/`unknown` unless stronger evidence exists.
  // (Architecture review 1.1 / "Usage Protocol".)

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

/**
 * Hard cap on recursive `collectEvidence` descent (binding elements and opaque
 * callback parameters each collect their children directly). Real code nests
 * only a few levels; the cap prevents a pathological/cyclic input from
 * recursing until stack overflow. Returning `undefined` past the cap is the
 * conservative choice: it asks the caller to fall back to `unknown`.
 */
const MAX_COLLECT_DEPTH = 32;

/**
 * Collect the inferred *type string* for a node, memoised per fixed-point
 * round. Recursive sites (binding elements, callback parameters) used to call
 * `mergeEvidence(collectEvidence(node, ctx)).type` directly, recomputing the
 * same subtree many times within one round. The memo is keyed by node and
 * tagged with `ctx.round`; `buildInferenceTable` advances that round each pass
 * so stale results can never leak across iterations.
 */
function collectedType(node: ts.Node, ctx: InferenceContext, depth: number): string | undefined {
  if (depth > MAX_COLLECT_DEPTH) {
    return undefined;
  }
  const cached = ctx.evidenceMemo.get(node);
  if (cached !== undefined && cached.round === ctx.round) {
    return cached.type;
  }
  const type = mergeEvidence(collectEvidence(node, ctx, depth)).type;
  ctx.evidenceMemo.set(node, { round: ctx.round, type });
  return type;
}

/** Collect type evidence for the declaration that owns an `any` annotation. */
/**
 * Weak name-based numeric hint. Only a FUNCTION name counts: a parameter of
 * `add(a, b)` or the return of `sum()` inherits the hint from the enclosing
 * function. Variable names are intentionally NOT used — an initializer, when
 * present, is real evidence and a name alone (`const total = ...`) is too
 * weak / misleading. Returns false unless a clear numeric-accumulator verb is
 * found in the function name. (Review round 12 / idea 3.)
 */
function ownerHasNumericNameHint(owner: ts.Node): boolean {
  let fnName: string | undefined;
  if (isFunctionLike(owner)) {
    const name = (owner as ts.SignatureDeclaration).name;
    if (name !== undefined && ts.isIdentifier(name)) {
      fnName = name.text;
    }
  } else if (ts.isParameter(owner) && isFunctionLike(owner.parent)) {
    const name = (owner.parent as ts.SignatureDeclaration).name;
    if (name !== undefined && ts.isIdentifier(name)) {
      fnName = name.text;
    }
  }
  return fnName !== undefined && nameSuggestsNumber(fnName);
}

export function collectEvidence(owner: ts.Node, ctx: InferenceContext, depth = 0): Evidence {
  const evidence = emptyEvidence();

  // Weak naming hint (lowest confidence): a numeric-accumulator function name
  // suggests its parameters/return are numeric. Recorded as a flag and only
  // consumed when NO real evidence exists — never outranks sources,
  // constraints or properties. (Review round 12 / idea 3.)
  evidence.nameHintNumber = ownerHasNumericNameHint(owner);

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
