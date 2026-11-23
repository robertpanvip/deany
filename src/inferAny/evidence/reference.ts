// Per-reference evidence collection: one identifier use, all its covariant
// sources and contravariant constraints. The largest collector module.
import * as ts from 'typescript';

import { aliasWriteShapes, applyTrivialFnCallsToRoot, closureReturnAliasWritesInto, propertyAliasWritesInto } from './aliases.js';
import { collectedType, isTypeProbedPropertyAccess, spreadCallConstraint, strictEqualityLiteralType, transparentUseNode } from './helpers.js';
import { isPureAliasBinding } from '../collect.js';
import { ARRAY_BUILTIN_MEMBERS, BITWISE_OPERATORS, BUILTIN_METHOD_RETURN, INDEXABLE_OBJECT, ITERATION_METHODS, MEMBERLESS_OBJECT_SOURCES, NUMERIC_COERCION_OPERATORS, REDUCER_METHODS, REDUCER_SIGNATURE, RELATIONAL_OPERATORS, VAGUE_RETURN_TYPES } from '../constants.js';
import { controlFlowNarrowedType } from '../controlFlow.js';
import { callResultShape, customArrayMethodSignature, insertShapeChain, isPlainObjectShapeText, propertyChainsWithCallsOf, renderShapeNode } from '../shape.js';
import { addConstraint, addSource } from '../state.js';
import type { Evidence, InferenceContext } from '../types.js';
import { arithmeticNumberType, instanceTypeOf, noteDependency, orderableOperandType, symbolTypeText, typePredicateOfArgument, typeText } from '../typeText.js';
import { isArrayIsArrayCall, isArrayTypeString, isObjectAssignCall, isUnderArrayIsArrayGuard, iterableArgumentConstraint, iterableConstructorConstraint, objectArgumentIndices, typeofLiteralToType, widenedTypeText } from '../util.js';

export function constraintsFromReference(
  reference: ts.Identifier,
  ctx: InferenceContext,
  evidence: Evidence,
  depth = 0,
): void {
  // All structural comparisons use the wrapper-transparent use node so that
  // `v!.foo`, `(v).foo`, `v as T` etc. are treated exactly like `v.foo`.
  const useNode: ts.Expression = transparentUseNode(reference);
  const parent = useNode.parent;

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

  // Destructuring ASSIGNMENT `({ a } = x)` / `[a, b] = x`: the RHS `x` is the
  // source being destructured, so it must have those keys (object form) or be
  // iterable (array form). This is the assignment mirror of the declaration
  // form `const { a } = x` above. Without it `x` stays `unknown` and strict
  // emits TS2339 ("Property 'a' does not exist on type 'unknown'") / TS2802.
  // The binding tokens (`a`) are collected for *their own* owner by the scan;
  // here we only record the shape requirement on the source `x`. (Review r16.)
  if (
    ts.isBinaryExpression(parent) &&
    parent.right === useNode &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    const target = parent.left;
    if (ts.isObjectLiteralExpression(target)) {
      for (const prop of target.properties) {
        if (ts.isShorthandPropertyAssignment(prop) || ts.isPropertyAssignment(prop)) {
          const keyNode = prop.name;
          if (ts.isIdentifier(keyNode) || ts.isStringLiteral(keyNode) || ts.isNumericLiteral(keyNode)) {
            evidence.properties.set(keyNode.text, 'unknown');
          }
        }
      }
      evidence.objectLiteralInit = true;
    } else if (ts.isArrayLiteralExpression(target)) {
      addConstraint(evidence, 'Iterable<unknown>');
    }
  }

  if (
    ts.isBinaryExpression(parent) &&
    parent.left === useNode &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    addSource(evidence, typeText(ctx, parent.right));
  }

  // Owner on the RIGHT of `=`: the value flows INTO the left-hand target, so
  // a concrete target type is a covariant source for the owner. This is the
  // setter/receiver case: `set x(p){ this._v = p }` where `_v` is already known
  // to be `number` proves p can hold a number. Only concrete target types count
  // — an evolving `any` (e.g. `this._v = 1` in the constructor) yields nothing.
  // (Review round 17.)
  if (
    ts.isBinaryExpression(parent) &&
    parent.right === useNode &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    // Destructuring targets (`({a} = v)` / `[a] = v`) are handled separately
    // above: there the RHS is the source being destructured, not a value being
    // assigned into a concrete slot. Typing the literal target would inject a
    // spurious `{ a: any }` source. (Review round 17.)
    !ts.isObjectLiteralExpression(parent.left) &&
    !ts.isArrayLiteralExpression(parent.left)
  ) {
    const targetType = typeText(ctx, parent.left);
    if (targetType !== undefined && !VAGUE_RETURN_TYPES.has(targetType)) {
      addSource(evidence, targetType);
    }
  }

  // Pure alias: `let a = b` / `const a = b` where this binding (`b`) is the
  // initializer and `a` is a plain identifier with no type annotation. The two
  // names denote the same object, so any shape written through `a` is also the
  // shape of `b` (`let a = b; a.c.d = 1` must narrow b too). Feed `a`'s inferred
  // type back into this binding as a covariant source, with a dependency edge
  // so the fixed point re-evaluates b after a settles — otherwise a strong
  // early `b: unknown` freezes before a's shape is known. Only bare-identifier
  // initializers qualify: `let a = f(b)` / `let a = b + 1` are not aliases, and
  // an annotated `let a: T = b` is a contract, not an alias. (v0.1.43.)
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === useNode &&
    ts.isIdentifier(parent.name) &&
    parent.type === undefined
  ) {
    const aliasDeclaration = ctx.checker.getSymbolAtLocation(parent.name)?.valueDeclaration;
    if (aliasDeclaration !== undefined && aliasDeclaration !== ctx.activeOwner) {
      noteDependency(ctx, aliasDeclaration);
      const aliasType = typeText(ctx, parent.name);
      if (aliasType !== undefined && !VAGUE_RETURN_TYPES.has(aliasType)) {
        addSource(evidence, aliasType);
        // Also tag it as an alias-derived source when the alias is genuine
        // (never reassigned). Sibling alias sources describe the same object
        // and are field-merged in mergeEvidence; this tag keeps call-site /
        // assignment sources on their normal union semantics. (v0.1.45.)
        if (isPureAliasBinding(parent, ctx)) {
          evidence.aliasSources.push(aliasType);
          // The alias's own `a.<chain> = value` writes describe this same
          // object. Feed them in as additional alias sources so a deep/shallow
          // write through `a` merges field-wise with the target's own shape
          // instead of being lost when `a`'s shapeChain is masked by its
          // initializer source. (v0.1.46.)
          for (const writeShape of aliasWriteShapes(parent, ctx)) {
            evidence.aliasSources.push(writeShape);
          }
        }
      }
    }
  }

  // Property-path alias: `let a = b.c` / `const a = b.x.y` where this binding
  // (`b`) is the root of the initializer's property-access chain. `a` denotes
  // the nested object `b.c`, so genuine `=` writes through `a` (`a.d = 1`)
  // prove the shape of `b.c`: `let a = b.c; a.d = 1` must narrow b to
  // `{ c: { d: number } }`. Only a *pure* alias (never reassigned) with real
  // writes qualifies, and the writes go into the shape chain (see below) —
  // not `sources` — to stay convergent. Reads/calls/inherited members are not
  // writes and contribute nothing. (v0.1.47.)
  if (ts.isPropertyAccessExpression(parent) && parent.expression === useNode) {
    // Walk outward to the longest property-access chain rooted at `useNode`.
    let outermost: ts.PropertyAccessExpression = parent;
    while (
      ts.isPropertyAccessExpression(outermost.parent) &&
      outermost.parent.expression === outermost
    ) {
      outermost = outermost.parent;
    }
    const decl = outermost.parent;
    if (
      decl !== undefined &&
      ts.isVariableDeclaration(decl) &&
      decl.initializer === outermost &&
      ts.isIdentifier(decl.name) &&
      decl.type === undefined &&
      isPureAliasBinding(decl, ctx, true)
    ) {
      const prefixChain: string[] = [];
      let walk: ts.Expression = outermost;
      while (ts.isPropertyAccessExpression(walk)) {
        prefixChain.unshift(walk.name.text);
        walk = walk.expression;
      }
      // Only when the owner is an untyped function PARAMETER. Restricting to
      // parameters excludes real-library locals such as React's
      // `var ReactCurrentActQueue$1 = ReactSharedInternals.ReactCurrentActQueue`
      // whose `...didScheduleLegacyUpdate = true` write is structurally
      // identical to the target scenario but must not reshape the module-level
      // internals object. A parameter with no annotation has no competing
      // declared shape, so the fallback shape is unambiguous. (v0.1.47.)
      const ownerIsUntypedParam =
        ts.isParameter(useNode) ||
        (() => {
          const sym = ctx.checker.getSymbolAtLocation(useNode);
          const vd = sym?.valueDeclaration;
          return vd !== undefined && ts.isParameter(vd) && vd.type === undefined;
        })();
      if (walk === useNode && prefixChain.length >= 1 && ownerIsUntypedParam) {
        // Feed the writes into the *shape chain* (the fallback shape tree),
        // never into `sources`/`aliasSources`. Those participate in the
        // fixed-point source union/merge cycle and, combined with the
        // `a = b.c` initializer reflow, grow the shape without bound on real
        // libraries (react-dom OOM). The shape chain is a low-priority
        // fallback that does not feed back into source inference, so it stays
        // convergent while still covering the opaque-target case. (v0.1.47.)
        propertyAliasWritesInto(decl, prefixChain, ctx, evidence.shapeChain);
      }
    }
  }

  // Closure-return alias: `function g(){ return b }` where g's only value is
  // this binding, called as `const x = g()` and then written (`x.a = 1`).
  // `g` returns the very same object `b`, so writes through `x` prove b's
  // shape, just like a direct alias. Only the narrow, unambiguous form is
  // accepted: a function with a single `return <this binding>` statement,
  // invoked with zero arguments into a never-reassigned const, with static
  // literal writes and no method calls. (v0.1.47.)
  if (ts.isReturnStatement(parent) && parent.expression === useNode) {
    closureReturnAliasWritesInto(reference, ctx, evidence.shapeChain);
  } else if (
    ts.isArrowFunction(parent) &&
    parent.body === useNode &&
    !ts.isBlock(parent.body)
  ) {
    // Expression-bodied arrow `const g = () => b`: the body is the owner's
    // reference itself. Same trivial-returner treatment. (v0.1.47.)
    const gDecl = parent.parent;
    if (ts.isVariableDeclaration(gDecl) && ts.isIdentifier(gDecl.name)) {
      const gSymbol = ctx.checker.getSymbolAtLocation(gDecl.name);
      if (gSymbol !== undefined) {
        applyTrivialFnCallsToRoot(gSymbol, ctx, evidence.shapeChain);
      }
    }
  }

  // Logical assignment (`x ||= v`, `x &&= v`, `x ??= v`): v is a value the
  // binding receives, so it is a covariant source, just like `x = v`.
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === useNode &&
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
  if (ts.isPropertyAccessExpression(parent) && parent.expression === useNode) {
    // `typeof val.constructor === 'function' ? val.constructor.name : null`:
    // the typeof probe before use means `constructor` may be absent, so the
    // synthesized first-level shape marks it optional (`constructor?:`). The
    // same applies to `val.p != null` guards. (v0.1.38.)
    if (isTypeProbedPropertyAccess(parent)) {
      insertShapeChain(evidence.shapeChain, [parent.name.text], false, true);
    }
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
      if (current === useNode) {
        // A deep write (`a.c.d = 123`): the RHS is real value evidence for the
        // terminal leaf, so record its type on the chain instead of leaving an
        // opaque `unknown`. Skipped for compound/logical assignments and for
        // writes of an opaque value. (v0.1.43.)
        let writeLeafType: string | undefined;
        const outerParent = outermost.parent;
        if (
          ts.isBinaryExpression(outerParent) &&
          outerParent.left === outermost &&
          outerParent.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
          const rhsType = typeText(ctx, outerParent.right);
          if (rhsType !== undefined && !VAGUE_RETURN_TYPES.has(rhsType)) {
            writeLeafType = rhsType;
          }
        }
        insertShapeChain(evidence.shapeChain, chain, false, false, writeLeafType);
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
        // `v.foo().bar()`: foo's return value is dereferenced/called further
        // down the chain. That is real structural evidence about foo's return
        // shape, not a name guess. Render it as a callable returning that
        // shape so the whole chain type-checks (otherwise foo(): unknown and
        // `.bar()` is TS2571). Reducers with an init keep their generic
        // signature — their return is the accumulator, not a chained shape.
        // (Review round 17.)
        const chainedReturn = isMethodCall ? callResultShape(grandparent as ts.CallExpression) : undefined;
        const methodSignature =
          chainedReturn !== undefined
            ? `(...args: unknown[]) => ${renderShapeNode(chainedReturn)}`
            : METHOD_TYPE;
        evidence.properties.set(
          parent.name.text,
          reducerWithInit ? REDUCER_SIGNATURE : methodSignature,
        );
        // Record the contextual (expected) return type of the call, so the
        // lib-unique narrowing can verify the method's signature matches the
        // builtin. `getContextualType` yields number/string for annotated returns
        // and variable declarations, but nothing for bare/chained calls — those
        // stay unconstrained and still allow the weak narrowing.
        if (isMethodCall) {
          // Record the first argument's observed type. A shared method called
          // with a concrete type its would-be builtin family rejects (e.g.
          // `includes(3)` on a would-be string) disproves that family later in
          // uniqueBuiltinReceiverType. (Review round 17.)
          const firstArg = (grandparent as ts.CallExpression).arguments[0];
          if (firstArg !== undefined) {
            const argType = typeText(ctx, firstArg);
            if (argType !== undefined && !VAGUE_RETURN_TYPES.has(argType)) {
              const list = evidence.methodArgumentTypes.get(parent.name.text) ?? [];
              if (!list.includes(argType)) {
                list.push(argType);
              }
              evidence.methodArgumentTypes.set(parent.name.text, list);
            }
          }
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
    parent.name === useNode &&
    ts.isBinaryExpression(parent.parent) &&
    parent.parent.left === parent &&
    parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    addSource(evidence, typeText(ctx, parent.parent.right));
  }

  // `Array.isArray(x)` narrows x to an array. This is a covariant source for
  // the binding, not a normal call-argument constraint. `unknown[]` is used so
  // strict mode stays intact without inventing an element type.
  if (ts.isCallExpression(parent) && parent.arguments[0] === useNode && isArrayIsArrayCall(parent)) {
    addSource(evidence, 'unknown[]');
  } else if (
    ts.isCallExpression(parent) &&
    typePredicateOfArgument(parent, useNode, ctx) !== undefined
  ) {
    // `if (isFoo(x))` where `isFoo(v): v is T` narrows x to T. This is a real
    // control-flow type guard, so T is a covariant source for the binding.
    addSource(evidence, typePredicateOfArgument(parent, useNode, ctx));
  } else if (ts.isCallExpression(parent)) {
    const index = parent.arguments.indexOf(useNode);
    if (index >= 0) {
      // Built-ins like Object.defineProperty / Reflect.set demand an object at
      // this slot even though lib.d.ts types it as `any` / a bare `T` / `{}`.
      // That is a contravariant constraint: the binding must at least be an
      // object. Skip the lib-declared parameter type for these slots — checker
      // widens `object` to `{}`, which would intersect with `object` into an
      // empty set and erase the evidence.
      const objectArgs = objectArgumentIndices(parent);
      const isObjectSlot = objectArgs !== undefined && objectArgs.includes(index);
      // `Object.assign(target, ...sources)` writes every source's own fields
      // INTO the target. When this binding is the target (index 0), each
      // source's object shape is genuine covariant shape evidence for it:
      // the target really has those fields afterwards. Feed plain-object
      // sources in as alias sources so mergeEvidence field-merges them with
      // the target's own shape (取最大), rather than unioning them as
      // alternative values. Only `=`-style concrete object literals qualify
      // (via isPlainObjectShapeText); opaque/`any` sources add nothing.
      // (v0.1.47.)
      if (index === 0 && isObjectAssignCall(parent)) {
        for (let s = 1; s < parent.arguments.length; s += 1) {
          const sourceType = typeText(ctx, parent.arguments[s]!);
          if (sourceType !== undefined && !VAGUE_RETURN_TYPES.has(sourceType) && isPlainObjectShapeText(sourceType)) {
            addSource(evidence, sourceType);
            evidence.aliasSources.push(sourceType);
          }
        }
      }
      // `Promise.all(v)` / `Promise.race(v)`: the argument must be iterable.
      // The checker resolves these overloads to `unknown` for an opaque arg,
      // which is filtered, so record the real protocol requirement directly.
      // (Review round 17.)
      const iterableConstraint = index === 0 ? iterableArgumentConstraint(parent, ctx) : undefined;
      if (isObjectSlot) {
        addConstraint(evidence, 'object');
      } else if (iterableConstraint !== undefined) {
        addConstraint(evidence, iterableConstraint);
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
          if (parameterDecl !== undefined) noteDependency(ctx, parameterDecl);
          const inferred =
            parameterDecl === undefined ? undefined : ctx.table.declarations.get(parameterDecl);
          addConstraint(evidence, inferred ?? paramText ?? 'unknown');
        }
      }
    }
  }

  // `new Map(v)` / `new Set(v)` / WeakMap / WeakSet: the first constructor
  // argument must be iterable. Unlike CallExpression, NewExpression arguments
  // were not previously visited here, so the binding stayed `unknown` and
  // strict emitted TS2769. Record the real protocol requirement (Map/WeakMap
  // need key/value entry pairs) as a contravariant constraint. (Review r17.)
  if (ts.isNewExpression(parent)) {
    const index = parent.arguments?.indexOf(useNode) ?? -1;
    if (index >= 0) {
      const ctorConstraint = index === 0 ? iterableConstructorConstraint(parent.expression, ctx) : undefined;
      if (ctorConstraint !== undefined) {
        addConstraint(evidence, ctorConstraint);
      } else {
        // General constructor parameters: `new Date(v)` requires
        // `string | number | Date`, `new RegExp(v)` requires string, etc.
        // The checker resolves the construct signature's parameter type;
        // a user class with an implicit-any constructor yields `any` (filtered,
        // stays unknown) so no concrete type is invented. (Review r17.)
        const signature = ctx.checker.getResolvedSignature(parent);
        const parameter = signature?.getParameters()[index];
        if (parameter !== undefined) {
          addConstraint(evidence, symbolTypeText(ctx, parameter, parent));
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
  if (ts.isCallExpression(parent) && parent.expression === useNode) {
    addConstraint(evidence, '(...args: unknown[]) => unknown');
  }

  // `new Ctor()`: same idea, but the value must be constructable.
  if (ts.isNewExpression(parent) && parent.expression === useNode) {
    addConstraint(evidence, 'new (...args: unknown[]) => unknown');
  }

  // Tagged template: `` tag`hi` `` / `` tag`a${v}b` ``. The tag is invoked as
  // a function (first argument a TemplateStringsArray), so it must be callable
  // — the same contravariant constraint as a plain `tag()`. Without it the tag
  // stays `unknown` and strict rejects the call with TS2349. This is genuine
  // usage evidence, not a name guess. (Review round 16.)
  if (ts.isTaggedTemplateExpression(parent) && parent.tag === useNode) {
    addConstraint(evidence, '(...args: unknown[]) => unknown');
  }

  // `class X extends Base {}`: the extends expression must be a constructable
  // base class. Without this `Base` stays `unknown` and strict emits TS2507
  // ("Type 'unknown' is not a constructor function type"). `any` in the
  // construct signature / instance type is deliberate and language-forced:
  // `new (...args: unknown[]) => unknown` fails with TS2509 (an `unknown`
  // instance cannot be extended), so the base's args/instance must stay `any`
  // to faithfully preserve the original JS's unrestricted subclassing.
  // (Review round 16.)
  if (
    ts.isExpressionWithTypeArguments(parent) &&
    parent.expression === useNode &&
    ts.isHeritageClause(parent.parent) &&
    parent.parent.token === ts.SyntaxKind.ExtendsKeyword
  ) {
    addConstraint(evidence, 'new (...args: any[]) => any');
  }

  // `xs.map/forEach(it => it.a.b)`: the receiver is an array, and the property
  // chains accessed on the callback's element parameter describe its element
  // type. Collect them into a shape tree; mergeEvidence uses it to refine an
  // otherwise-opaque `unknown[]` into `Array<{...}>`. This is structural evidence
  // (the code actually depends on those properties), not a heuristic guess.
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === useNode &&
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
        for (const { keys, callable } of propertyChainsWithCallsOf(elementParam.name, callback.body, ctx)) {
          insertShapeChain(evidence.elementShape, keys, callable);
        }
      }
    }
  }

  // Object spread `{...x}` requires x to be an object in strict TypeScript —
  // spreading a bare `unknown`/number/string is TS2698 ("Spread types may only
  // be created from object types"). The source is a SpreadAssignment (not a
  // SpreadElement), which is why the array/call spread rule below never saw it.
  // Record the same contravariant `object` constraint used for Object.* slots;
  // a concrete covariant source (call-site object) still wins. (Review r16.)
  if (ts.isSpreadAssignment(parent) && parent.expression === useNode) {
    addConstraint(evidence, 'object');
  }

  // Spread has two distinct type requirements in TypeScript:
  //   - array/iterable spread  `[...x]`  → x only needs to be Iterable<T>
  //     (a generator or Set is equally valid — Architecture review 1.6).
  //   - call-argument spread    `f(...x)` → x must be an array/tuple type;
  //     `Iterable<T>` is NOT accepted as spread arguments (TS2556/TS2345).
  if (
    ts.isSpreadElement(parent) &&
    parent.expression === useNode &&
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
    parent.expression === useNode
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
    parent.argumentExpression === useNode
  ) {
    addConstraint(evidence, 'PropertyKey');
  }
  // Computed property name `{ [v]: 1 }`: v is coerced to a PropertyKey just
  // like an index expression. Without this it stays `unknown` and strict emits
  // TS2464 ("computed property name must be string/number/symbol"). Same real
  // JS-language requirement, not a name guess. (Review round 16.)
  if (ts.isComputedPropertyName(parent) && parent.expression === useNode) {
    addConstraint(evidence, 'PropertyKey');
  }
  if (ts.isForInStatement(parent) && parent.expression === useNode) {
    addConstraint(evidence, INDEXABLE_OBJECT);
  }

  // `x instanceof Ctor` narrows x to the constructor's instance type.
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === useNode &&
    parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
  ) {
    addSource(evidence, instanceTypeOf(ctx, parent.right));
  }

  if (
    ts.isBinaryExpression(parent) &&
    (parent.left === useNode || parent.right === useNode)
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
      const other = parent.left === useNode ? parent.right : parent.left;
      addConstraint(evidence, orderableOperandType(ctx, other) ?? 'number | string');
    }
    // `key in x` requires x to be an object (the left side is the key).
    if (
      parent.operatorToken.kind === ts.SyntaxKind.InKeyword &&
      parent.right === useNode
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
  if (ts.isTemplateSpan(parent) && parent.expression === useNode) {
    evidence.stringContext = true;
  }
  if (
    ts.isBinaryExpression(parent) &&
    (parent.left === useNode || parent.right === useNode)
  ) {
    const operator = parent.operatorToken.kind;
    const other = parent.left === useNode ? parent.right : parent.left;
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
    // Strict equality against a literal proves the two sides' types overlap:
    // TS2367 rejects `string === true`, but `string | boolean === true` is
    // legal. Record the literal's widened type so a real covariant source can
    // be unioned with it. `typeof x === '...'` is handled by its own branch
    // above (a strong source), so skip the unwrapped typeof expression here.
    // Only literals count — `x === y` (both bindings) proves nothing. These
    // are compatibility hints, consumed ONLY when a real source exists, so a
    // bare `x === 'a'` with no other evidence still keeps `any` (P0-2).
    // (TS strict-regression fix.)
    if (
      (operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        operator === ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
      !ts.isTypeOfExpression(other)
    ) {
      const literalType = strictEqualityLiteralType(other);
      if (literalType !== undefined) {
        evidence.equalityOperandTypes.push(literalType);
      }
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

  // `yield* x` delegates to an iterator, so x must be ITERABLE (exactly the
  // same protocol requirement as `for...of`). Without this x stays `unknown`
  // and strict emits TS2488 ("must have a [Symbol.iterator]() method"). The
  // delegated element type is generally unknowable, so use the conservative
  // `Iterable<unknown>` — accepting every value the original JS accepted.
  // (Review round 17.)
  if (
    ts.isYieldExpression(parent) &&
    parent.asteriskToken !== undefined &&
    parent.expression === useNode
  ) {
    addConstraint(evidence, 'Iterable<unknown>');
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
  if (ts.isForOfStatement(parent) && parent.expression === useNode) {
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
            for (const { keys, callable } of propertyChainsWithCallsOf(binding.name, parent.statement, ctx)) {
              insertShapeChain(evidence.elementShape, keys, callable);
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
                for (const { keys, callable } of propertyChainsWithCallsOf(element.name, parent.statement, ctx)) {
                  insertShapeChain(evidence.elementShape, [key, ...keys], callable);
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
    parent.initializer === useNode &&
    ts.isArrayBindingPattern(parent.name)
  ) {
    // Array destructuring requires an Iterable, not an Array (a Set or a
    // generator can be destructured too). Use the protocol, not the concrete.
    addConstraint(evidence, 'Iterable<unknown>');
    // Element alias: `const [a, b] = xs` binds a/b to the container's elements,
    // so property chains dereferenced on those bindings are covariant evidence
    // for the element type. Scan the enclosing block for each binding's usage
    // (the same structural approach as for-of) and fold the chains into
    // elementShape, so mergeEvidence refines `Iterable<unknown>` to
    // `Iterable<shape>`. (v0.1.44.)
    let scope: ts.Node = parent;
    while (
      scope.parent !== undefined &&
      !ts.isBlock(scope.parent) &&
      !ts.isSourceFile(scope.parent) &&
      !ts.isFunctionLike(scope.parent)
    ) {
      scope = scope.parent;
    }
    const scanBody = scope.parent ?? scope;
    for (const element of parent.name.elements) {
      if (
        !ts.isBindingElement(element) ||
        element.dotDotDotToken !== undefined ||
        !ts.isIdentifier(element.name)
      ) {
        continue;
      }
      for (const { keys, callable } of propertyChainsWithCallsOf(element.name, scanBody, ctx)) {
        insertShapeChain(evidence.elementShape, keys, callable);
      }
    }
  }
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === useNode &&
    ts.isObjectBindingPattern(parent.name)
  ) {
    for (const element of parent.name.elements) {
      // A rest element (`const { a, ...rest } = opts`) captures the *remaining*
      // keys — it is NOT a property named `rest` on the source. Recording it as
      // `opts.rest` is a correctness bug: it forces every source object to
      // carry a `rest` member it never had. Skip it; the rest binding's own
      // shape is inferred independently as a normal owner. (v0.1.44.)
      if (element.dotDotDotToken !== undefined) {
        continue;
      }
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
    parent.initializer === useNode &&
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
    parent.left === useNode &&
    (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    addSource(evidence, typeText(ctx, parent.right));
  }

  // `cond ? x : other` -> the other branch's type is a possible value for x.
  if (ts.isConditionalExpression(parent)) {
    if (parent.whenTrue === useNode) {
      addSource(evidence, typeText(ctx, parent.whenFalse));
    } else if (parent.whenFalse === useNode) {
      addSource(evidence, typeText(ctx, parent.whenTrue));
    }
  }
}
