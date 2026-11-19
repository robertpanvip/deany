import * as ts from 'typescript';

import type { Evidence, InferAnyOptions, InferenceContext, InferenceTable, ShapeNode } from './types.js';

export const DEFAULT_INFER_OPTIONS: InferAnyOptions = {
  reportAmbiguous: true,
  includeAssertions: false,
}

export function createTable(): InferenceTable {
  return { declarations: new Map(), returns: new Map(), weakOwners: new Set() };
}

export function createContext(
  checker: ts.TypeChecker,
  program: ts.Program,
  table: InferenceTable,
): InferenceContext {
  return {
    checker,
    program,
    table,
    referenceCache: new Map(),
    callCache: new Map(),
  };
}

export function emptyEvidence(): Evidence {
  return {
    sources: [],
    constraints: [],
    properties: new Map<string, string>(),
    elementShape: { children: new Map<string, ShapeNode>() },
    shapeChain: { children: new Map<string, ShapeNode>() },
    arrayOwnMethods: new Map<string, string>(),
    methodReturnTypes: new Map<string, string[]>(),
    objectLiteralInit: false,
    stringContext: false,
  };
}

export function addSource(evidence: Evidence, type: string | undefined): void {
  if (type !== undefined) {
    evidence.sources.push(type);
  }
}

export function addConstraint(evidence: Evidence, type: string | undefined): void {
  if (type === undefined) {
    return;
  }
  // `void` / `Promise<void>` describe a function's *return*, not a value. A
  // constraint is an intersection that narrows a value binding (e.g. a real
  // argument passed to a parameter); intersecting with `void` forces that
  // value to become `void`, which is wrong — passing a value to a `void`
  // parameter is exactly what strict mode rejects (TS2345/TS2322). This arises
  // with `const next = async total => { resolve(total); return; }; next(x)`:
  // the parameter's inferred void return leaked in as a constraint on `x`.
  // Drop it so the binding falls back to `unknown` instead of a value-less
  // type. Function returns are unaffected: they carry void via `addSource`.
  if (type === 'void' || type === 'Promise<void>') {
    return;
  }
  evidence.constraints.push(type);
}
