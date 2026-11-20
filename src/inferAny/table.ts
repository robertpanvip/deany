import * as ts from 'typescript';

import type { InferenceContext, InferenceTable } from './types.js';
import { MAX_FIXED_POINT_ROUNDS } from './state.js';
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
  const maxRounds = MAX_FIXED_POINT_ROUNDS;
  let rounds = 0;
  let converged = true;
  for (let round = 0; round < maxRounds; round += 1) {
    rounds = round + 1;
    // Invalidate per-round evidence memos: collectEvidence reads the evolving
    // table, so a type collected in an earlier round is no longer trustworthy.
    ctx.round = round + 1;
    let changed = false;
    for (const owner of owners) {
      const current = ownerType(ctx.table, owner);
      const wasWeak = ctx.table.weakOwners.has(owner);
      // Strongly inferred owners are fixed. Weak ones stay open to refinement.
      // Exception: a *bare* `unknown` result means at least one opaque return
      // (or initializer) could not be resolved yet, usually because it depends
      // on another owner that has not been inferred in this fixed-point pass.
      // Freezing it as strong would strand it at `unknown` forever even after
      // that dependency settles to a concrete type. Keep such results open so
      // later rounds can refine them. A genuinely unresolvable `unknown` simply
      // re-merges to `unknown`, so convergence is unaffected.
      const currentIsBareUnknown = current === 'unknown';
      if (current !== undefined && !wasWeak && !currentIsBareUnknown) {
        continue;
      }
      const merged = mergeEvidence(collectEvidence(owner, ctx));
      if (merged.type === undefined) {
        continue;
      }
      // Treat a bare-`unknown` merge as weak so it is revisited next round once
      // its dependencies may have concrete types. Concrete merges keep their
      // declared strength and are frozen as before.
      const isWeak = merged.weak === true || merged.type === 'unknown';
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
      converged = true;
      break;
    }
    // Still changing on the last allowed round -> the chain did not settle.
    if (round === maxRounds - 1) {
      converged = false;
    }
  }
  ctx.table.diagnostics.rounds = rounds;
  ctx.table.diagnostics.converged = converged;
  ctx.table.diagnostics.maxRounds = maxRounds;
  return ctx.table;
}
