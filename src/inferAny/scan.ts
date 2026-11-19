import * as ts from 'typescript';

import type { CallSite, InferenceContext } from './types.js';
import { nonDeclarationFiles } from './util.js';

/**
 * A single whole-program scan that indexes every identifier reference and
 * every resolved call site up front. Built lazily on first use and shared by
 * all owners, so `referencesOf`/`callsOf` become O(1) map lookups instead of
 * re-scanning the entire program for each symbol/declaration.
 *
 * Before this index, N owners triggered N full-program walks, and `callsOf`
 * called `getResolvedSignature` on every call node for *each* declaration —
 * O(owners × call-sites) checker calls. Here `getResolvedSignature` runs once
 * per call node total.
 */
export interface ProgramScan {
  readonly references: Map<ts.Symbol, ts.Identifier[]>;
  readonly calls: Map<ts.SignatureDeclaration, CallSite[]>;
}

function deref(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  return (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

/** Build the global reference + call-site index in one program walk. */
export function buildProgramScan(checker: ts.TypeChecker, program: ts.Program): ProgramScan {
  const references = new Map<ts.Symbol, ts.Identifier[]>();
  const calls = new Map<ts.SignatureDeclaration, CallSite[]>();

  for (const sourceFile of nonDeclarationFiles(program)) {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const symbol = checker.getSymbolAtLocation(node);
        if (symbol !== undefined) {
          const target = deref(symbol, checker);
          const bucket = references.get(target);
          if (bucket === undefined) {
            references.set(target, [node]);
          } else {
            bucket.push(node);
          }
        }
      } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        // A resolved signature's declaration can be a JSDocSignature for JSDoc
        // typedefs; only real TS signature declarations are call-site targets.
        const resolved = checker.getResolvedSignature(node)?.declaration;
        const declaration =
          resolved !== undefined && !ts.isJSDocSignature(resolved)
            ? (resolved as ts.SignatureDeclaration)
            : undefined;
        if (declaration !== undefined) {
          const bucket = calls.get(declaration);
          if (bucket === undefined) {
            calls.set(declaration, [node]);
          } else {
            bucket.push(node);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return { references, calls };
}

/** Get (or lazily build) the shared program scan for a context. */
export function getScan(ctx: InferenceContext): ProgramScan {
  if (ctx.scan === undefined) {
    // InferenceContext fields are readonly at the type level; the scan slot is
    // deliberately mutable so it can be memoised on first access.
    (ctx as { scan?: ProgramScan }).scan = buildProgramScan(ctx.checker, ctx.program);
  }
  return ctx.scan!;
}
