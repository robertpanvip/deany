import * as ts from 'typescript';

import type { InferenceContext, InferenceTable } from './types.js';
import { isFunctionLike } from './util.js';
import { mergeEvidence } from './shape.js';
import { collectEvidence } from './evidence.js';

/** Store an owner's inferred type into the correct side of the table. */
export function setOwnerType(table: InferenceTable, owner: ts.Node, type: string): void {
  if (isFunctionLike(owner)) {
    table.returns.set(owner, type);
  } else {
    table.declarations.set(owner, type);
  }
}

export function ownerType(table: InferenceTable, owner: ts.Node): string | undefined {
  return isFunctionLike(owner) ? table.returns.get(owner) : table.declarations.get(owner);
}

/**
 * Fixed-point iteration: infer types for every owner and feed each result back
 * into the table so chained declarations resolve. Strong evidence fixes a type
 * permanently; weak evidence (an object shape synthesized from property
 * accesses alone) stays provisional and is re-evaluated each round, so a later
 * concrete type — e.g. a call-site argument that itself was inferred in a
 * previous round — can refine it. Converges in at most MAX_ROUNDS rounds.
 */
export function buildInferenceTable(owners: readonly ts.Node[], ctx: InferenceContext): InferenceTable {
  const MAX_ROUNDS = 16;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    let changed = false;
    for (const owner of owners) {
      const current = ownerType(ctx.table, owner);
      const wasWeak = ctx.table.weakOwners.has(owner);
      // Strongly inferred owners are fixed. Weak ones stay open to refinement.
      if (current !== undefined && !wasWeak) {
        continue;
      }
      const merged = mergeEvidence(collectEvidence(owner, ctx));
      if (merged.type === undefined) {
        continue;
      }
      const isWeak = merged.weak === true;
      const sameType = current === merged.type;
      if (sameType && isWeak === wasWeak) {
        continue;
      }
      setOwnerType(ctx.table, owner, merged.type);
      if (isWeak) {
        ctx.table.weakOwners.add(owner);
      } else {
        ctx.table.weakOwners.delete(owner);
      }
      changed = true;
    }
    if (!changed) {
      break;
    }
  }
  return ctx.table;
}
