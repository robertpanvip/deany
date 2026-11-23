import * as ts from 'typescript';

import type { Evidence, InferenceContext, ShapeNode } from './types.js';
import { controlFlowNarrowedType } from './controlFlow.js';
import { addConstraint, addSource, addWeakSource, emptyEvidence } from './state.js';
import { declaredTypeOf, isExportedParameter } from './publicApi.js';
import { ARRAY_BUILTIN_MEMBERS, BITWISE_OPERATORS, BUILTIN_METHOD_RETURN, INDEXABLE_OBJECT, ITERATION_METHODS, MEMBERLESS_OBJECT_SOURCES, NUMERIC_COERCION_OPERATORS, REDUCER_METHODS, REDUCER_SIGNATURE, RELATIONAL_OPERATORS, VAGUE_RETURN_TYPES, functionNameSuggestsReturnType, nameSuggestsNumber, variableNameSuggestsType } from './constants.js';
import { arrayElementTypeOf, functionLikeName, isArrayIsArrayCall, isArrayTypeString, isFunctionLike, isSelfReferentialType, isUnderArrayIsArrayGuard, iterableArgumentConstraint, iterableConstructorConstraint, mergeMutationEvidence, objectArgumentIndices, requireModuleType, symbolOf, typeofLiteralToType, widenedTypeText } from './util.js';
import { callResultShape, customArrayMethodSignature, insertShapeChain, isPlainObjectShapeText, mergeEvidence, propertyChainsWithCallsOf, renderShapeNode } from './shape.js';
import { arithmeticNumberType, instanceTypeOf, noteDependency, orderableOperandType, symbolTypeText, typePredicateOfArgument, typeText } from './typeText.js';
import { collectMutationEvidence, containerInstantiationFromMutations } from './mutation.js';
import { callsOf, isPureAliasBinding, referencesOf } from './collect.js';

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
    let restType = ctx.checker.getTypeOfSymbolAtLocation(parameter, call);
    // A rest parameter typed by a generic (`...xs: T extends [number, string]`)
    // resolves to `any` at the call site — no constraint is visible there.
    // Recover the concrete shape from the declaration's type-parameter base
    // constraint so a tuple-constrained generic still yields the tuple, rather
    // than an `unknown[]` that TS rejects as a tuple spread (TS2556). (Review P1.)
    if ((restType.flags & ts.TypeFlags.Any) !== 0) {
      const declaredType = ctx.checker.getTypeAtLocation(declaration);
      if ((declaredType.flags & ts.TypeFlags.TypeParameter) !== 0) {
        const base = ctx.checker.getBaseConstraintOfType(declaredType);
        if (base !== undefined) {
          restType = base;
        }
      }
    }
    // Arrays and tuples are both TypeReference in the checker's model, but a
    // tuple rest parameter (`...args: [number, string]`) must NOT be collapsed
    // to an element array: the spread argument has to be exactly that tuple,
    // or TS rejects it (TS2556). Preserve the full tuple structure — including
    // optional (`?`) and variadic (`...T[]`) elements. Only a genuine array
    // rest parameter contributes an element type plus `[]`. (Review P1 tuple.)
    if ((restType.flags & ts.TypeFlags.Object) !== 0 && ctx.checker.isTupleType(restType)) {
      const tupleText = widenedTypeText(ctx.checker, restType, call);
      if (tupleText !== undefined && tupleText !== 'never' && tupleText !== 'any') {
        return tupleText;
      }
    } else if ((restType.flags & ts.TypeFlags.Object) !== 0 && ctx.checker.isArrayType(restType)) {
      const elementType = ctx.checker.getTypeArguments(restType as ts.TypeReference)[0];
      if (elementType !== undefined) {
        const text = widenedTypeText(ctx.checker, elementType, call);
        if (text !== undefined && text !== 'never' && text !== 'any') {
          return `${text}[]`;
        }
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

/**
 * Widened type of a literal operand in a strict-equality comparison, or
 * undefined when the operand is not a literal (e.g. another binding). Only
 * self-describing literal syntax counts — this is a compatibility hint for
 * avoiding TS2367, never a standalone type source. `true`/`false` -> boolean,
 * string/number/bigint/numeric-negative literals -> their primitive, `null` ->
 * null. Template expressions and identifiers are excluded deliberately.
 * (TS strict-regression fix.)
 */
function strictEqualityLiteralType(node: ts.Expression): string | undefined {
  if (
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return 'boolean';
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return 'string';
  }
  if (ts.isNumericLiteral(node)) {
    return 'number';
  }
  if (ts.isBigIntLiteral(node)) {
    return 'bigint';
  }
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return 'number';
  }
  if (node.kind === ts.SyntaxKind.NullKeyword) {
    return 'null';
  }
  return undefined;
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

/**
 * The "use node" for a reference: walk outward through transparent expression
 * wrappers — non-null (`v!`), parentheses (`(v)`), `as`/angle-bracket
 * assertions and `satisfies` — so that structural evidence collected at a use
 * site also applies when the binding is wrapped. Returns the outermost wrapper,
 * or the identifier itself when there is none. `checker`-based queries (flow
 * narrowing, isArray guards) still use the original identifier, since those
 * wrappers do not change the control-flow position. (Review round 16.)
 */
function transparentUseNode(reference: ts.Identifier): ts.Expression {
  let current: ts.Expression = reference;
  for (;;) {
    const parent: ts.Node | undefined = current.parent;
    if (
      parent !== undefined &&
      ((ts.isNonNullExpression(parent) && parent.expression === current) ||
        (ts.isParenthesizedExpression(parent) && parent.expression === current) ||
        (ts.isAsExpression(parent) && parent.expression === current) ||
        (ts.isTypeAssertionExpression(parent) && parent.expression === current) ||
        (ts.isSatisfiesExpression(parent) && parent.expression === current))
    ) {
      current = parent;
      continue;
    }
    return current;
  }
}

/** Extract constraints from one reference to the `any`-typed binding. */
/**
 * True when a property access is guarded by a type probe *before* it is used —
 * `typeof o.p === '...'` or `o.p != null`. The very presence of the probe means
 * the code tolerates p being absent, so a synthesized shape should render p
 * optional (`p?:`) instead of forcing every caller to supply it. (v0.1.38.)
 */
function isTypeProbedPropertyAccess(expr: ts.PropertyAccessExpression): boolean {
  const parent: ts.Node | undefined = expr.parent;
  if (parent === undefined) return false;
  // typeof o.p === 'literal' / !== 'literal' (covers 'undefined', 'function', ...)
  if (ts.isTypeOfExpression(parent) && parent.expression === expr) {
    const comparison = parent.parent;
    if (
      comparison !== undefined &&
      ts.isBinaryExpression(comparison) &&
      (comparison.left === parent || comparison.right === parent)
    ) {
      const other = comparison.left === parent ? comparison.right : comparison.left;
      if (ts.isStringLiteral(other) || ts.isNoSubstitutionTemplateLiteral(other)) {
        return true;
      }
    }
  }
  // o.p != null / == null / === undefined / !== undefined
  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    if (
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken
    ) {
      const other = parent.left === expr ? parent.right : parent.left;
      if (
        other.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isIdentifier(other) && other.text === 'undefined')
      ) {
        return true;
      }
    }
  }
  return false;
}

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
/** The enclosing function's name, for owner-level name hints. */
function ownerFunctionName(owner: ts.Node): string | undefined {
  if (isFunctionLike(owner)) {
    return functionLikeName(owner);
  }
  if (ts.isParameter(owner)) {
    return functionLikeName(owner.parent);
  }
  return undefined;
}

/**
 * Weak name-based numeric hint. Only a FUNCTION's PARAMETERS get this hint: a
 * parameter of `add(a, b)` / `count(xs)` inherits it from the enclosing
 * function. The function's own RETURN no longer takes a number from its name —
 * round 15 splits name hints by role (boolean/array/string name -> return,
 * numeric name -> parameters only). Variable names are intentionally NOT used:
 * an initializer, when present, is real evidence and a bare name is too weak.
 * Returns false unless a clear numeric-accumulator verb is found. (Rounds 12/15.)
 */
function ownerHasNumericNameHint(owner: ts.Node): boolean {
  const fnName = ownerFunctionName(owner);
  return fnName !== undefined && ts.isParameter(owner) && nameSuggestsNumber(fnName);
}

/**
 * A literal-like operand used purely to probe a value's type
 * (`x === null`, `x === void 0`, `x === 'a'`, ...). Strict TS rejects a
 * comparison between non-overlapping types, so a literal comparison is a
 * type probe, never a value use.
 */
function isTypeComparisonLiteral(expr: ts.Expression): boolean {
  if (
    ts.isStringLiteral(expr) ||
    ts.isNumericLiteral(expr) ||
    ts.isNoSubstitutionTemplateLiteral(expr) ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    expr.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isIdentifier(expr) && expr.text === 'undefined') return true;
  if (expr.kind === ts.SyntaxKind.VoidExpression) return true;
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken) {
    return ts.isNumericLiteral(expr.operand);
  }
  return false;
}

/**
 * Classify how one reference of a parameter is used inside its own function.
 * A *detection category* means the reference only probes the value's type;
 * `undefined` means the value is genuinely consumed (returned as data, read as
 * a business property, used in arithmetic, assigned, ...).
 */
function parameterProbeCategory(ref: ts.Identifier, ctx: InferenceContext): string | undefined {
  let parent: ts.Node | undefined = ref.parent;

  // A reference that reads a property/business field off the parameter
  // (`x.size`, `val.message`, `val.constructor.name`) is a genuine value use,
  // not a type probe — even if the whole expression is later compared to a
  // literal (`x.size === 0`) or typeof'd. Only a *bare* parameter reference is
  // eligible to be a probe.
  if (parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.expression === ref) {
    return undefined;
  }
  // Climb parentheses around the bare parameter reference.
  while (parent !== undefined && ts.isParenthesizedExpression(parent)) {
    parent = parent.parent;
  }
  if (parent === undefined) return undefined;

  if (ts.isTypeOfExpression(parent) && parent.expression === ref) return 'typeof';

  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    if (op === ts.SyntaxKind.InKeyword && parent.right === ref) return 'in';
    if (op === ts.SyntaxKind.InstanceOfKeyword && parent.left === ref) return 'instanceof';
    if (
      (op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken) &&
      (parent.left === ref || parent.right === ref)
    ) {
      const other = parent.left === ref ? parent.right : parent.left;
      if (isTypeComparisonLiteral(other)) return 'equality';
    }
  }

  if (ts.isCallExpression(parent)) {
    const index = parent.arguments.indexOf(ref);
    if (index >= 0) {
      if (isArrayIsArrayCall(parent)) return 'isArray';
      if (typePredicateOfArgument(parent, ref, ctx) !== undefined) return 'predicate';
      // Forwarded to another function: the callee infers its own parameter,
      // forwarding alone does not consume this value.
      return 'call';
    }
  }
  return undefined;
}

/**
 * True when `node` is a reference (identifier / property access / parenthesized
 * expression resolving to an identifier) to a parameter that the classifier
 * rule pins to `unknown`. Such an `unknown` is the honest "any value" answer
 * for a type-classifier, NOT a concrete type observation; letting it flow into
 * another function's call-site evidence would wrongly erode that function's
 * parameter (e.g. `has(key){ key._reactInternals ... }` becoming `key: unknown`
 * and raising TS18046). Skip it as call-site evidence instead.
 */
function isClassifierParamReference(node: ts.Expression, ctx: InferenceContext): boolean {
  let target: ts.Node = node;
  while (
    ts.isParenthesizedExpression(target) ||
    ts.isAsExpression(target) ||
    ts.isNonNullExpression(target)
  ) {
    target = target.expression;
  }
  if (!ts.isIdentifier(target)) return false;
  const symbol = ctx.checker.getSymbolAtLocation(target);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (declaration === undefined || !ts.isParameter(declaration)) return false;
  return isTypeClassifierParameter(declaration, ctx);
}

/**
 * A "type classifier" parameter is one its function only *probes*, never uses
 * as a concrete value — it reports what type the argument is (`miniKindOf`
 * returns `'array'`/`'date'`/...) rather than operating on it. Every value is
 * legitimate, so the honest type is `unknown`; narrowing it from its own
 * probes (`unknown[]` from `Array.isArray`, `Date`/`Error` from predicates) or
 * from call-site arguments yields a misleading union.
 *
 * Deliberately conservative: the parameter needs at least TWO distinct probe
 * categories and ZERO value uses. A lone typeof guard (`format(x)`) still
 * narrows as before, and a branch that reads `x.length` is a value use that
 * keeps its inferred type — so existing inference is untouched.
 */
function isTypeClassifierParameter(owner: ts.Node, ctx: InferenceContext): boolean {
  if (!ts.isParameter(owner)) return false;
  const fn = owner.parent;
  if (fn === undefined || !isFunctionLike(fn) || fn.body === undefined) return false;
  const symbol = symbolOf(owner, ctx.checker);
  if (symbol === undefined) return false;

  const categories = new Set<string>();
  let valueUse = false;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && ctx.checker.getSymbolAtLocation(node) === symbol) {
      const category = parameterProbeCategory(node, ctx);
      if (category === undefined) {
        valueUse = true;
      } else {
        categories.add(category);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return !valueUse && categories.size >= 2;
}

/**
 * Object shapes written *through* a pure alias binding. When `let a = b` and
 * `a` is never reassigned, every `a.<chain> = value` write is really a write to
 * `b` — the two names denote the same object. These writes may be sitting in
 * `a`'s `shapeChain`, which `mergeEvidence` ignores whenever `a` already has a
 * covariant `source` (e.g. its initializer `b`), so they would never reach `b`
 * via `typeText(a)` alone. Rendering them into plain object shapes lets the
 * alias-source merge in `mergeEvidence` combine them with `b`'s own evidence.
 *
 * Only genuine `=` writes with a concrete RHS are collected; reads, method
 * calls and compound assignments are not shape evidence. Returns an empty
 * array when there is nothing usable, so the caller adds no source. (v0.1.46.)
 */
function aliasWriteShapes(decl: ts.VariableDeclaration, ctx: InferenceContext): string[] {
  if (!ts.isIdentifier(decl.name)) {
    return [];
  }
  const symbol = ctx.checker.getSymbolAtLocation(decl.name);
  if (symbol === undefined) {
    return [];
  }
  const root: ShapeNode = { children: new Map<string, ShapeNode>() };
  let sawWrite = false;
  for (const ref of referencesOf(symbol, ctx)) {
    // Walk outward to the longest property-access chain rooted at `ref`.
    let current: ts.Expression = ref;
    while (
      ts.isPropertyAccessExpression(current.parent) &&
      current.parent.expression === current
    ) {
      current = current.parent;
    }
    if (current === ref) {
      continue;
    }
    const parent: ts.Node | undefined = current.parent;
    if (
      parent === undefined ||
      !ts.isBinaryExpression(parent) ||
      parent.left !== current ||
      parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken
    ) {
      continue;
    }
    const chain: string[] = [];
    let walk: ts.Expression = current;
    while (ts.isPropertyAccessExpression(walk)) {
      chain.unshift(walk.name.text);
      walk = walk.expression;
    }
    // Only deep writes (`a.c.d = v`, chain length >= 2) are collected. A
    // shallow alias write (`node.flag = v`) is already represented by the
    // alias's own `properties` and folding it here widens function-parameter
    // unions in real libraries (react-dom). The mixed deep-write scenario is
    // the gap v0.1.45 left open. (v0.1.46.)
    if (walk !== ref || chain.length < 2) {
      continue;
    }
    const rhsType = typeText(ctx, parent.right);
    if (rhsType === undefined || VAGUE_RETURN_TYPES.has(rhsType)) {
      continue;
    }
    insertShapeChain(root, chain, false, false, rhsType);
    sawWrite = true;
  }
  if (!sawWrite) {
    return [];
  }
  const rendered = renderShapeNode(root);
  return isPlainObjectShapeText(rendered) ? [rendered] : [];
}

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
