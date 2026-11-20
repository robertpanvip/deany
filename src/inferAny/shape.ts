import * as ts from 'typescript';
import { hasTopLevelArrow } from '../normalize.js';

import type { Evidence, InferenceContext, ShapeNode } from './types.js';
import { INDEXABLE_OBJECT, ITERATION_METHODS, MEMBERLESS_OBJECT_SOURCES } from './constants.js';
import { addStringIndexSignature, isArrayTypeString, splitTopLevelUnion } from './util.js';
import { uniqueBuiltinReceiverType } from './typeText.js';

export function insertShapeChain(root: ShapeNode, chain: readonly string[]): void {
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

export function renderShapeNode(node: ShapeNode): string {
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
export function renderPropertyShape(properties: ReadonlyMap<string, string>): string {
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
export function mergeObjectShapeWithProperties(
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
export function splitTopLevelFields(body: string): string[] {
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
export function customArrayMethodSignature(
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
 * Collect every property-access chain rooted at `root` inside `body` as an
 * array of key paths (e.g. `root.a.b` -> ['a', 'b']). Symbol identity is
 * checked when available so a same-named inner variable is not mistaken for
 * the callback element.
 */
export function propertyChainsOf(
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

/** Set intersection of top-level union members across several constraints. */
export function intersectConstraints(constraints: readonly string[]): string[] | undefined {
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
export function mergeEvidence(evidence: Evidence): {
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
        // call-site types and `instanceof` results stay untouched.
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
    if (allowed !== undefined && allowed.includes(INDEXABLE_OBJECT)) {
      if (members.every((member) => member === '{}')) {
        members = [INDEXABLE_OBJECT];
      } else {
        // A concrete object shape that is also indexed dynamically (e.g.
        // `function pick(o, k) { return o[k]; } pick({a:1}, 'a')`) must stay
        // indexable or strict TS emits TS7053. Keep the observed shape and add
        // a string index signature rather than discarding its real evidence.
        members = members.map((member) => addStringIndexSignature(member) ?? member);
      }
    }
  } else if (allowed !== undefined && allowed.length > 0) {
    // No observed values: the required argument types are our best estimate.
    // Exception: a pure iteration *protocol* constraint (Iterable<T>, emitted
    // by for-of / destructuring / spread) must not mask concrete Array
    // structure evidence from iteration methods (`.map`, `.filter`, ...).
    // Those methods do not exist on Iterable, so emitting only Iterable<T>
    // would make the very body we inspected fail TS2339. Prefer the array
    // shape in that case. (Architecture review 1.6.)
    const onlyProtocolConstraint = allowed.every(
      (member) => member.startsWith('Iterable<') || member.startsWith('AsyncIterable<'),
    );
    const hasIterationMethod = [...evidence.properties.keys()].some((key) =>
      ITERATION_METHODS.has(key),
    );
    if (
      onlyProtocolConstraint &&
      hasIterationMethod &&
      evidence.elementShape.children.size > 0
    ) {
      // Array iteration methods (.map/.filter) need a real Array receiver.
      members = [`Array<${renderShapeNode(evidence.elementShape)}>`];
      weak = true;
    } else if (onlyProtocolConstraint && evidence.elementShape.children.size > 0) {
      // Plain `for...of` / destructuring: KEEP the iteration protocol so Sets,
      // Generators and strings remain accepted, but refine the opaque `unknown`
      // element with the structural shape collected from the loop body. Without
      // this, `for (const v of xs) { v.a.b }` yields `Iterable<unknown>` and the
      // very body we inspected fails TS18046. (Line-by-line review B2/B3.)
      const element = renderShapeNode(evidence.elementShape);
      members = allowed.map((member) =>
        member.startsWith('AsyncIterable<')
          ? `AsyncIterable<${element}>`
          : `Iterable<${element}>`,
      );
      weak = true;
    } else {
      members = allowed;
    }
  } else if (
    evidence.elementShape.children.size > 0 &&
    [...evidence.properties.keys()].every((key) => ITERATION_METHODS.has(key))
  ) {
    // An iteration callback (`xs.map(it => it.a.b)`, `xs.forEach`, ...) proves
    // the receiver is an array whose elements have the accessed shape — even
    // without an `Array.isArray` guard. The callback-body property chains are
    // structural evidence, so prefer `Array<shape>` over the method-shape
    // ({ map: (...)=>unknown }) that a bare `.map` access would otherwise emit.
    members = [`Array<${renderShapeNode(evidence.elementShape)}>`];
    weak = true;
  } else if (evidence.shapeChain.children.size > 0) {
    // Last resort: synthesize a nested object shape from full property chains
    // (`o.a.b` -> `{ a: { b: unknown; }; }`). Prefer this over the flat
    // properties map so deep dereferences don't stop at the first level.
    members = [renderShapeNode(evidence.shapeChain)];
    weak = true;
  } else if (
    uniqueBuiltinReceiverType(evidence.properties, evidence.methodReturnTypes) !== undefined
  ) {
    // Last resort: the binding was only observed calling methods unique to a
    // builtin family (e.g. `s.toUpperCase()`), so narrow to that primitive.
    // Weak, so a later concrete source can refine it; guarded so coincidental
    // same-named methods on a custom shape are never narrowed, and guarded so
    // a return context contradicting the builtin signature rejects it.
    members = [
      uniqueBuiltinReceiverType(evidence.properties, evidence.methodReturnTypes) as string,
    ];
    weak = true;
  } else if (evidence.properties.size > 0) {
    // Last resort: synthesize an object shape from accessed properties.
    members = [renderPropertyShape(evidence.properties)];
    weak = true;
  } else if (evidence.stringContext) {
    // A binding observed only in string-like contexts (template interpolation,
    // `+` with a string, `===` a string literal) is NOT proven to be a string:
    // interpolation and `+` accept numbers, booleans, objects — anything with
    // a toString. Emitting `string` here silently narrowed the public contract
    // (`function tpl(x: any) { return `${x}` }` became `x: string`, so `tpl(42)`
    // turned from valid to a type error). Keep the weak marker so a real source
    // from a later round can still refine it, but never claim `string` on
    // interpolation alone — `unknown` is the honest answer.
    members = ['unknown'];
    weak = true;
  } else if (evidence.nameHintNumber) {
    // Weak naming hint (e.g. a parameter of `add`/`sum`/`count`). Used ONLY
    // when no real source/constraint/property exists, and marked weak so any
    // real evidence in a later round immediately overrides it. Checked before
    // ambiguousAdd: a numeric-accumulator name is a more specific hint than
    // the generic "cannot tell from `+`" fallback. (Review round 12.)
    return { type: 'number', weak: true };
  } else if (evidence.nameHintType !== undefined) {
    // Weak variable-name hint (`let names;` -> `unknown[]`, `let isReady;` ->
    // `boolean`). Only reached with NO real source/constraint/property and no
    // function-name number hint; marked weak so any real evidence in a later
    // round immediately overrides it. Never outranks real data. (Round 14.)
    return { type: evidence.nameHintType, weak: true };
  } else if (evidence.ambiguousAdd) {
    // The binding was only ever used in an anchor-less `+`. JS cannot decide
    // between numeric addition and string concat, so no type is justified;
    // emit `any` (faithful to the original implicit-any JS) instead of
    // `unknown`, which would make the `a + b` expression a TS18046. Marked weak
    // so a later round's concrete evidence can still refine it. (Round 12.)
    return { type: 'any', weak: true };
  } else if (evidence.weakSources.length > 0) {
    // Only low-confidence call-site evidence exists (S4: internal callers of
    // an exported parameter). It is deliberately NOT used to narrow the
    // public contract, but surface it in the reason so diagnostics can explain
    // why the `any` was kept instead of silently discarding collected data.
    // (Architecture review 3.1 — give weakSources a real consumer.)
    return {
      reason: `only internal call-site evidence (${[...new Set(evidence.weakSources)].join(', ')}); public parameter left un-narrowed`,
    };
  } else if (evidence.returnsAddExpression) {
    // An expression-bodied arrow (`(a, b) => a + b`) has no return statement:
    // its body IS the returned `+` expression, yet contributes no source, so it
    // reaches here with no evidence. JS `+` is addition or concatenation, so the
    // honest fallback return is `string | number` (same as the block-bodied
    // path). Marked weak so a later round's real evidence still overrides it.
    // (Review round 13.)
    return { type: 'string | number', weak: true };
  } else {
    return { reason: 'no usage evidence' };
  }

  members = [...new Set(members)].sort();
  if (members.length === 0) {
    return { reason: 'contradictory constraints' };
  }
  // `unknown` is TypeScript's top type: `unknown | T` collapses to `unknown`.
  // When any covariant source is genuinely opaque (e.g. `return x()` against a
  // bare `Function`, where the callee's result cannot be known at all), listing
  // the sibling concrete members is a lie — it claims confidence we do not
  // have (TS2322/TS2345 in strict mode once a caller relies on the narrow type).
  // Collapse the whole union to `unknown`, so "cannot tell" never turns into a
  // confident narrower type. This matches only the bare `unknown` member —
  // `unknown[]`, `Array<unknown>`, `{ k: unknown }`, `=> unknown` etc. are
  // distinct members and are never absorbed.
  if (members.includes('unknown')) {
    // A function returning a `+` expression whose operands were untyped has no
    // concrete return evidence — the bare `unknown` is the fallback for that
    // opaque `+`. JS `+` is either numeric addition or string concatenation, so
    // `string | number` is the honest, strictly-more-informative type (and is
    // safely assignable from any `+` result). Only when EVERY member is a bare
    // `unknown` (no concrete sibling) and the body actually returns `+`; a real
    // return type is never downgraded. Marked weak so real evidence still wins.
    // (Review round 13.)
    if (evidence.returnsAddExpression && members.every((m) => m === 'unknown')) {
      return { type: 'string | number', weak: true };
    }
    return { type: 'unknown', weak };
  }
  if (members.length === 1) {
    const only = members[0];
    return only === undefined ? { reason: 'no usage evidence' } : { type: only, weak };
  }
  // A bare function type is illegal as a union member without parentheses.
  const formatted = members.map((member) => (hasTopLevelArrow(member) ? `(${member})` : member));
  return { type: formatted.join(' | '), weak };
}
