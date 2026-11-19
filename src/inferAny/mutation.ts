import * as ts from 'typescript';

import type { InferenceContext, MutationKind } from './types.js';
import { mergeMutationEvidence, symbolOf } from './util.js';
import { typeText } from './typeText.js';
import { referencesOf } from './collect.js';

/**
 * When an `any` occupies the mutable element/value slot of a container type
 * (`any[]`, `Array<any>`, `Map<K, any>`, `Set<any>`), mutations through that
 * binding are additional covariant sources for the slot type. Read-only
 * accesses (`a.length`, `a.map`) remain noise and are never used.
 */
export function mutationKindOf(anyNode: ts.Node): MutationKind | undefined {
  const parent = anyNode.parent;
  if (ts.isArrayTypeNode(parent) && parent.elementType === anyNode) {
    return 'collection';
  }
  if (ts.isTypeReferenceNode(parent) && parent.typeArguments !== undefined) {
    const name = parent.typeName.getText();
    const index = parent.typeArguments.indexOf(anyNode as ts.TypeNode);
    if (index < 0) {
      return undefined;
    }
    if (name === 'Array' || name === 'ReadonlyArray') {
      return 'collection';
    }
    if ((name === 'Map' || name === 'ReadonlyMap' || name === 'WeakMap') && index === 1) {
      return 'map';
    }
    if ((name === 'Set' || name === 'ReadonlySet' || name === 'WeakSet') && index === 0) {
      return 'set';
    }
  }
  return undefined;
}

/**
 * Collect element/value types written into a container through its binding:
 * `push`/`unshift` and index assignment for arrays, `set(k, v)` for maps,
 * `add(v)` for sets. These are covariant sources for the `any` slot.
 */
export function collectMutationEvidence(
  owner: ts.Node,
  kind: MutationKind,
  ctx: InferenceContext,
): string[] {
  const symbol = symbolOf(owner, ctx.checker);
  if (symbol === undefined) {
    return [];
  }
  const collected: string[] = [];
  const add = (node: ts.Expression | undefined): void => {
    if (node === undefined) {
      return;
    }
    const text = typeText(ctx, node);
    if (text !== undefined) {
      collected.push(text);
    } else {
      // The written value is an opaque `any`/`unknown` (e.g. `r.push(fn(x))`
      // where `fn` is an implicit-any callback, or `r.push(await v)`). It is
      // still a real write: the element slot can hold that value, so record
      // `unknown`. This keeps `[]` from freezing at `Array<never>` (which
      // rejects every push with TS2345) without inventing a concrete type.
      collected.push('unknown');
    }
  };
  for (const ref of referencesOf(symbol, ctx)) {
    const parent = ref.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === ref) {
      const call = parent.parent;
      if (ts.isCallExpression(call) && call.expression === parent) {
        const method = parent.name.text;
        if (kind === 'collection' && (method === 'push' || method === 'unshift')) {
          for (const argument of call.arguments) {
            add(argument);
          }
        } else if (kind === 'map' && method === 'set') {
          add(call.arguments[1]);
        } else if (kind === 'set' && method === 'add') {
          add(call.arguments[0]);
        }
      }
    }
    // `a[i] = v`: the reference is the element-access base.
    if (
      kind === 'collection' &&
      ts.isElementAccessExpression(parent) &&
      parent.expression === ref
    ) {
      const binary = parent.parent;
      if (
        ts.isBinaryExpression(binary) &&
        binary.left === parent &&
        binary.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        add(binary.right);
      }
    }
  }
  return collected;
}

/**
 * Recover concrete type arguments for `new Map()` / `new Set()` that were
 * written without explicit generics (so the checker reports `Map<any, any>`).
 * `set(k, v)` / `add(v)` calls through the binding are covariant evidence for
 * the key and value slots, exactly as `push` is for arrays. Returns a fully
 * instantiated `Map<K, V>` / `Set<V>` string, or undefined when there is no
 * informative mutation evidence (the caller then keeps the safe normalized
 * `Map<unknown, unknown>` / `Set<unknown>`).
 */
export function containerInstantiationFromMutations(
  owner: ts.Node,
  kind: 'map' | 'set',
  ctx: InferenceContext,
): string | undefined {
  const symbol = symbolOf(owner, ctx.checker);
  if (symbol === undefined) {
    return undefined;
  }
  const keys: string[] = [];
  const values: string[] = [];
  const record = (node: ts.Expression | undefined, bucket: string[]): void => {
    if (node === undefined) {
      return;
    }
    const text = typeText(ctx, node);
    bucket.push(text ?? 'unknown');
  };
  for (const ref of referencesOf(symbol, ctx)) {
    const parent = ref.parent;
    if (!ts.isPropertyAccessExpression(parent) || parent.expression !== ref) {
      continue;
    }
    const call = parent.parent;
    if (!ts.isCallExpression(call) || call.expression !== parent) {
      continue;
    }
    const method = parent.name.text;
    if (kind === 'map' && method === 'set' && call.arguments.length >= 2) {
      record(call.arguments[0], keys);
      record(call.arguments[1], values);
    } else if (kind === 'set' && method === 'add' && call.arguments.length >= 1) {
      record(call.arguments[0], values);
    }
  }
  if (kind === 'map') {
    if (keys.length === 0 || values.length === 0) {
      return undefined;
    }
    const k = mergeMutationEvidence(undefined, keys);
    const v = mergeMutationEvidence(undefined, values);
    if (k === undefined || v === undefined) {
      return undefined;
    }
    return `Map<${k}, ${v}>`;
  }
  if (values.length === 0) {
    return undefined;
  }
  const v = mergeMutationEvidence(undefined, values);
  return v === undefined ? undefined : `Set<${v}>`;
}
