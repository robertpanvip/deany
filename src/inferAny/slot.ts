import * as ts from 'typescript';

import type { InferenceContext } from './types.js';
import { mergeMutationEvidence, slotPathOf, widenedTypeText } from './util.js';
import { typeText } from './typeText.js';

/**
 * Project onto an `any` slot using the checker's structured type of the
 * initializer rather than parsing a printed type string. String projection
 * breaks when a type argument contains commas (e.g. a function type
 * `(a: number, b: string) => void`) or other nested syntax; the checker's
 * `getTypeArguments` / index type walk never does. Returns undefined unless
 * every step is a concrete type object whose printed form is informative, so
 * the caller can fall back to string projection and preserve existing behavior.
 */
export function structuredSlotType(
  node: ts.Node,
  owner: ts.Node,
  ctx: InferenceContext,
): string | undefined {
  if (
    !ts.isVariableDeclaration(owner) &&
    !ts.isPropertyDeclaration(owner)
  ) {
    return undefined;
  }
  const init = owner.initializer;
  if (init === undefined) {
    return undefined;
  }
  const path = slotPathOf(node);
  if (path.length === 0) {
    return undefined;
  }
  let current = ctx.checker.getTypeAtLocation(init);
  for (const index of path) {
    // Arrays/tuples: the numeric index type is the element type.
    if (ctx.checker.isArrayType(current) || ctx.checker.isTupleType(current)) {
      const element = ctx.checker.getIndexTypeOfType(current, ts.IndexKind.Number);
      if (element === undefined) {
        return undefined;
      }
      current = element;
      continue;
    }
    const args = ctx.checker.getTypeArguments(current as ts.TypeReference);
    const picked = args[index];
    if (picked === undefined) {
      return undefined;
    }
    current = picked;
  }
  const widened = ctx.checker.getWidenedType(current);
  // Filter by flags, not text: a legitimate function-typed slot may print
  // `void` as its return type (`(a: number) => void`) and must not be dropped.
  if (widened.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) {
    return undefined;
  }
  return widenedTypeText(ctx.checker, widened, node);
}

/**
 * Project an `any` token that sits in a slot which `slotPathOf` does not model
 * (it only understands `any[]` and `Type<..., any>` type arguments). For those
 * slots the generic projection returns the whole owner type at path `[]`,
 * which gets substituted into the any position and produces structurally
 * wrong, non-compiling code:
 *
 *   `<T = any>`          -> `<T = void>`      (owner is the function: self/void)
 *   `<T extends any>`    -> `<T extends void>`(circular/meaningless constraint)
 *   `[any, number]`      -> `[[string, number], number]` (tuple nested in slot 0)
 *   `(x: number) => any` -> `(x: number) => (x: number) => number` (double arrow)
 *
 * Handle these explicitly. Generic parameter defaults/constraints have no
 * usage evidence to infer from — the `any` is a "no constraint / any default"
 * placeholder — so replace it with `unknown`, which is equivalent and legal
 * there, and never with the enclosing declaration's whole value type. Tuple
 * elements and function-type return positions are projected from the
 * initializer's structured checker type. If that projection is unavailable,
 * fall back to `unknown` rather than the whole type, so we never emit illegal
 * code. Returns undefined for slots the generic path already handles.
 */
export function specialSlotType(node: ts.Node, owner: ts.Node, ctx: InferenceContext): string | undefined {
  const parent = node.parent;
  if (parent === undefined) {
    return undefined;
  }

  // Generic parameter default / constraint: `<T = any>` / `<T extends any>`.
  // No initializer projection applies; `unknown` is the honest, legal slot.
  if (ts.isTypeParameterDeclaration(parent)) {
    return parent.default === node || parent.constraint === node ? 'unknown' : undefined;
  }

  // Tuple elements and function-type returns need the owner's initializer to
  // read the concrete slot type from the checker (a printed whole-type string
  // cannot be safely parsed for `[a, b]` / `=> R` here).
  if (!ts.isVariableDeclaration(owner) && !ts.isPropertyDeclaration(owner)) {
    return undefined;
  }
  const init = owner.initializer;
  if (init === undefined) {
    return undefined;
  }
  const initType = ctx.checker.getTypeAtLocation(init);

  const slotText = (type: ts.Type | undefined): string => {
    if (type === undefined) {
      return 'unknown';
    }
    const widened = ctx.checker.getWidenedType(type);
    if (widened.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) {
      return 'unknown';
    }
    const text = widenedTypeText(ctx.checker, widened, node);
    return text.length === 0 || text === 'any' ? 'unknown' : text;
  };

  if (ts.isTupleTypeNode(parent)) {
    const index = parent.elements.indexOf(node as ts.TypeNode);
    if (index < 0) {
      return undefined;
    }
    const args = ctx.checker.getTypeArguments(initType as ts.TypeReference);
    return slotText(args[index]);
  }

  if (
    (ts.isFunctionTypeNode(parent) || ts.isConstructorTypeNode(parent)) &&
    parent.type === node
  ) {
    const sigs = ctx.checker.getSignaturesOfType(initType, ts.SignatureKind.Call);
    return slotText(sigs[0]?.getReturnType());
  }

  return undefined;
}

/**
 * `Record<K, any>` / `ReadonlyRecord<K, any>` keep their *values* in the `any`
 * slot. When the initializer is an object literal, the checker reports its
 * whole shape (`{ a: number; b: number; }`), which has no type arguments and
 * therefore cannot be projected through the `[1]` value-slot path. Projecting
 * that shape would wrongly emit `Record<string, { a: number; b: number; }>`
 * and raise TS2322 — each property value is a `number`, not the whole object.
 *
 * Derive the slot from the literal's own property values instead, aligned with
 * how `Map<string, any>` slots are inferred from `set(k, v)`. Returns undefined
 * unless the `any` is the value slot of a Record-like reference whose owner has
 * an object-literal initializer, so the generic projection path still applies.
 */
export function recordValueSlotType(
  node: ts.Node,
  owner: ts.Node,
  ctx: InferenceContext,
): string | undefined {
  const parent = node.parent;
  if (parent === undefined || !ts.isTypeReferenceNode(parent) || parent.typeArguments === undefined) {
    return undefined;
  }
  const name = parent.typeName.getText();
  if (name !== 'Record' && name !== 'ReadonlyRecord') {
    return undefined;
  }
  if (parent.typeArguments.indexOf(node as ts.TypeNode) !== 1) {
    return undefined;
  }
  if (!ts.isVariableDeclaration(owner) || owner.initializer === undefined) {
    return undefined;
  }
  const init = owner.initializer;
  if (!ts.isObjectLiteralExpression(init)) {
    return undefined;
  }
  const valueTypes: string[] = [];
  for (const prop of init.properties) {
    let expr: ts.Expression | undefined;
    if (ts.isPropertyAssignment(prop)) {
      expr = prop.initializer;
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      expr = prop.name;
    }
    if (expr === undefined) {
      continue;
    }
    const type = typeText(ctx, expr);
    if (type !== undefined && type !== 'any' && type !== 'unknown' && type !== 'never') {
      valueTypes.push(type);
    }
  }
  return mergeMutationEvidence(undefined, valueTypes);
}
