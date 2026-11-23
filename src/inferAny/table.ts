import * as ts from 'typescript';

import type { InferenceContext, InferenceTable } from './types.js';
import { MAX_FIXED_POINT_ROUNDS } from './state.js';
import { isFunctionLike } from './util.js';
import { mergeEvidence } from './shape.js';
import { collectEvidence } from './evidence/index.js';

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
 * into the table so chained declarations resolve.
 *
 * An owner's evidence may be *strong* (concrete values, not a synthesized
 * object shape) yet still be *unstable*: `function f(x){ return g(x); }` reads
 * `g`'s inferred return, so if `g` is not settled yet, freezing `f` now would
 * strand it at a premature value (often bare `unknown`). To avoid this we track,
 * for each owner, the set of other owners whose inferred types its evidence
 * consulted (`table.dependencies`). An owner is frozen only once it is strong
 * AND none of its dependencies changed in the previous round; otherwise it is
 * re-collected. Evidence collected in a round records a fresh dependency set.
 *
 * Cycles are harmless: members of a dependency cycle simply keep re-evaluating
 * until their values stop changing, at which point "no dependency changed"
 * lets every member freeze and the loop converges. Converges in at most
 * MAX_FIXED_POINT_ROUNDS rounds.
 */
export function buildInferenceTable(owners: readonly ts.Node[], ctx: InferenceContext): InferenceTable {
  const maxRounds = MAX_FIXED_POINT_ROUNDS;
  let rounds = 0;
  let converged = true;
  let changedLastRound = new Set<ts.Node>();
  for (let round = 0; round < maxRounds; round += 1) {
    rounds = round + 1;
    // Invalidate per-round evidence memos: collectEvidence reads the evolving
    // table, so a type collected in an earlier round is no longer trustworthy.
    ctx.round = round + 1;
    const changedThisRound = new Set<ts.Node>();
    for (const owner of owners) {
      const current = ownerType(ctx.table, owner);
      const wasWeak = ctx.table.weakOwners.has(owner);
      // A strong result is frozen only when its dependencies are quiet. Weak
      // owners and owners with a changed dependency stay open. On the first
      // round every owner is un-inferred, so all are collected and record their
      // dependency edges; later rounds refine them.
      const deps = ctx.table.dependencies.get(owner);
      let depsChanged = false;
      if (deps !== undefined) {
        for (const dep of deps) {
          if (changedLastRound.has(dep)) {
            depsChanged = true;
            break;
          }
        }
      }
      if (current !== undefined && !wasWeak && !depsChanged) {
        continue;
      }
      // Collect a fresh dependency set for this owner. Nested/recursive reads
      // are attributed to `owner` via ctx.activeOwner set in collectEvidence.
      const depsThisCollection = new Set<ts.Node>();
      ctx.activeDeps = depsThisCollection;
      const merged = mergeEvidence(collectEvidence(owner, ctx));
      ctx.activeDeps = undefined;
      ctx.table.dependencies.set(owner, depsThisCollection);
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
      changedThisRound.add(owner);
    }
    if (changedThisRound.size === 0) {
      converged = true;
      break;
    }
    // Still changing on the last allowed round -> the chain did not settle.
    if (round === maxRounds - 1) {
      converged = false;
    }
    changedLastRound = changedThisRound;
  }
  ctx.table.diagnostics.rounds = rounds;
  ctx.table.diagnostics.converged = converged;
  ctx.table.diagnostics.maxRounds = maxRounds;
  return ctx.table;
}
