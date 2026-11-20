import * as ts from 'typescript';

import type { InferenceContext, UsageResolver } from './types.js';
import { isArrayTypeString, isFunctionLike } from './util.js';
import { ARRAY_BUILTIN_MEMBERS, ITERATION_METHODS, REDUCER_METHODS, REDUCER_SIGNATURE } from './constants.js';
import { createContext, createTable } from './state.js';
import { buildInferenceTable, ownerType } from './table.js';
import { collectDeclarations } from './collect.js';
import { typeText } from './typeText.js';

/**
 * True when `param` is the element parameter of a known iteration callback
 * whose receiver binding was inferred as an array of shapes. In that case the
 * rewritten source gives the parameter a contextual type, so it must not be
 * annotated (a redundant `unknown` would shadow the element shape).
 */
export function isInferredArrayElementParameter(
  param: ts.ParameterDeclaration,
  ctx: InferenceContext,
): boolean {
  const func = param.parent;
  if (!isFunctionLike(func) || func.parameters[0] !== param) {
    return false;
  }
  const call = func.parent;
  if (!ts.isCallExpression(call) || !call.arguments.includes(func as ts.Expression)) {
    return false;
  }
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !ITERATION_METHODS.has(callee.name.text)) {
    return false;
  }
  let symbol = ctx.checker.getSymbolAtLocation(callee.expression);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = ctx.checker.getAliasedSymbol(symbol);
  }
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (declaration === undefined) {
    return false;
  }
  const inferred = ctx.table.declarations.get(declaration);
  return inferred !== undefined && inferred.startsWith('Array<');
}

/**
 * True when `param` is a callback argument to a standard array method whose
 * receiver will be concretely typed after conversion (e.g. `nums: number[]`
 * from a JSDoc rest param, then `nums.reduce((a, b) => ...)`). The rewritten
 * source gives `nums` its array type, and lib.d.ts then supplies contextual
 * types for the callback parameters — so annotating them `unknown` would
 * override real contextual typing and reintroduce TS18046/TS2322.
 */
export function callbackReceiverIsTypedArray(param: ts.ParameterDeclaration, ctx: InferenceContext): boolean {
  const func = param.parent;
  if (!isFunctionLike(func) || !ts.isCallExpression(func.parent)) {
    return false;
  }
  const call = func.parent;
  if (!call.arguments.some((arg) => arg === func)) {
    return false;
  }
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !ARRAY_BUILTIN_MEMBERS.has(callee.name.text)) {
    return false;
  }
  let symbol = ctx.checker.getSymbolAtLocation(callee.expression);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = ctx.checker.getAliasedSymbol(symbol);
  }
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (declaration === undefined) {
    return false;
  }
  const inferred = ctx.table.declarations.get(declaration);
  return inferred !== undefined && isArrayTypeString(inferred);
}

/**
 * True when `param` is the callback of a reduce/reduceRight call whose receiver
 * was inferred with the generic accumulator signature. The rewritten source
 * then gives the callback parameters contextual types from the real `init`
 * argument, so annotating them `unknown` would override that and reintroduce
 * TS18046. (Review round 12 / idea 2.)
 */
export function callbackReceiverIsGenericReducer(
  param: ts.ParameterDeclaration,
  ctx: InferenceContext,
): boolean {
  const func = param.parent;
  if (!isFunctionLike(func) || !ts.isCallExpression(func.parent)) {
    return false;
  }
  const call = func.parent;
  if (!call.arguments.some((arg) => arg === func) || call.arguments.length < 2) {
    return false;
  }
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !REDUCER_METHODS.has(callee.name.text)) {
    return false;
  }
  let symbol = ctx.checker.getSymbolAtLocation(callee.expression);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = ctx.checker.getAliasedSymbol(symbol);
  }
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (declaration === undefined) {
    return false;
  }
  const inferred = ctx.table.declarations.get(declaration);
  return inferred !== undefined && inferred.includes(REDUCER_SIGNATURE);
}

/**
 * True when `param` is the callback of a custom method called on a narrowed
 * array (`xs.custom(it => ...)`) whose receiver was inferred with a typed
 * method signature via an intersection. The rewritten source supplies a
 * contextual parameter type, so an `unknown` annotation must not be added.
 */
export function isCustomArrayMethodCallback(
  param: ts.ParameterDeclaration,
  ctx: InferenceContext,
): boolean {
  const func = param.parent;
  if (!isFunctionLike(func) || func.parameters[0] !== param) {
    return false;
  }
  const call = func.parent;
  if (!ts.isCallExpression(call) || call.arguments[0] !== func) {
    return false;
  }
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || ARRAY_BUILTIN_MEMBERS.has(callee.name.text)) {
    return false;
  }
  let symbol = ctx.checker.getSymbolAtLocation(callee.expression);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = ctx.checker.getAliasedSymbol(symbol);
  }
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (declaration === undefined) {
    return false;
  }
  const inferred = ctx.table.declarations.get(declaration);
  return inferred !== undefined && inferred.includes('&') && isArrayTypeString(inferred.split('&')[0]?.trim() ?? '');
}

/** Create a usage resolver over a set of root files (JS or TS). */
export function createUsageResolver(
  rootNames: readonly string[],
  compilerOptions: ts.CompilerOptions,
): UsageResolver {
  const program = ts.createProgram([...rootNames], compilerOptions);
  const checker = program.getTypeChecker();
  const ctx = createContext(checker, program, createTable());
  buildInferenceTable(collectDeclarations(program), ctx);
  return {
    getSourceFile: (fileName) => program.getSourceFile(fileName),
    infer: (owner) => ownerType(ctx.table, owner),
    symbolOf: (node) => {
      let symbol = checker.getSymbolAtLocation(node);
      if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
        symbol = checker.getAliasedSymbol(symbol);
      }
      return symbol;
    },
    typeOf: (node) => typeText(ctx, node as ts.Expression),
    overridesBase: (member) => {
      const classDecl = member.parent;
      if (!ts.isClassDeclaration(classDecl) || classDecl.heritageClauses === undefined) {
        return false;
      }
      if (member.name === undefined || ts.isConstructorDeclaration(member)) {
        return false;
      }
      const memberName = member.name.getText().replace(/^['"]|['"]$/g, '');
      const classType = checker.getTypeAtLocation(classDecl);
      return checker
        .getBaseTypes(classType as ts.InterfaceType)
        .some((base) => base.getProperty(memberName) !== undefined);
    },
    isImplicitAnyParameter: (param) => {
      // A contextual type (even `any`) means the parameter is already typed by
      // the callee, and annotating it could break inference. Only when there is
      // no contextual type AND the resolved type is `any` do we have a true
      // implicit-any that strict mode will reject. The runtime checker accepts
      // parameter nodes here; the Expression cast satisfies the TS type surface.
      const paramExpr = param as unknown as ts.Expression;
      if (checker.getContextualType(paramExpr) !== undefined) {
        return false;
      }
      // If this parameter is an iteration callback's element and the receiver
      // was inferred as an array of shapes, the rewritten source will supply a
      // contextual element type. Annotating it `unknown` would override that
      // and reintroduce TS18046, so leave it unannotated.
      if (isInferredArrayElementParameter(param, ctx)) {
        return false;
      }
      if (callbackReceiverIsTypedArray(param, ctx)) {
        return false;
      }
      if (callbackReceiverIsGenericReducer(param, ctx)) {
        return false;
      }
      if (isCustomArrayMethodCallback(param, ctx)) {
        return false;
      }
      const apparent = checker.getTypeAtLocation(paramExpr);
      return (apparent.flags & ts.TypeFlags.Any) !== 0;
    },
  };
}
