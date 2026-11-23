import * as ts from 'typescript';
import * as path from 'node:path';

import type { AnySite, InferAnyOptions, InferFileResult } from './types.js';
import { findSiblingDts, parseDeclarationFile } from '../dts.js';
import type { DeclarationProvider } from '../dts.js';
import { declaredTypeOf, dtsGenericParamInsertionFor } from './publicApi.js';
import { DEFAULT_INFER_OPTIONS, createContext, createTable } from './state.js';
import { buildInferenceTable, ownerType } from './table.js';
import { collectAnyOwners, isReturnTypeAnnotationOf, isUnassignedLetWithoutInit, wrapAsyncReturnForInfer } from './collect.js';
import { isCatchClauseVariable, mergeMutationEvidence, ownerOf, parenthesizeIfComposite, projectSlotType, slotPathOf, widenedTypeText } from './util.js';
import { recordValueSlotType, specialSlotType, structuredSlotType } from './slot.js';
import { collectMutationEvidence, mutationKindOf } from './mutation.js';
import { mergeEvidence } from './shape.js';
import { collectEvidence } from './evidence/index.js';

/**
 * Infer concrete types for explicit `any` annotations in a TypeScript program.
 * Each returned result contains the rewritten source plus a per-site report.
 */
export function inferAnyInProject(
  rootNames: readonly string[],
  compilerOptions: ts.CompilerOptions,
  optionsInput: Partial<InferAnyOptions> = {},
): InferFileResult[] {
  const options: InferAnyOptions = { ...DEFAULT_INFER_OPTIONS, ...optionsInput };
  const program = ts.createProgram([...rootNames], compilerOptions);
  const checker = program.getTypeChecker();

  // Load sibling `.d.ts` contracts for each root. A declared type is the
  // highest-confidence evidence and outranks any usage inference (S4). The map
  // is keyed by the resolved source-file path to match `owner.getSourceFile()`.
  const dtsProviders = new Map<string, DeclarationProvider>();
  for (const root of rootNames) {
    const sourceFile = program.getSourceFile(root);
    const key = sourceFile?.fileName ?? path.resolve(root);
    const dtsPath = findSiblingDts(key);
    if (dtsPath !== undefined) {
      const provider = parseDeclarationFile(dtsPath);
      dtsProviders.set(key, provider);
      // Also register the resolved absolute path — infer paths can differ in
      // casing/normalisation between the program key and the owner's file.
      dtsProviders.set(path.resolve(root), provider);
    }
  }
  const ctx = createContext(checker, program, createTable(), dtsProviders, true);
  buildInferenceTable(collectAnyOwners(program), ctx);

  const results: InferFileResult[] = [];

  for (const fileName of rootNames) {
    const sourceFile = program.getSourceFile(fileName);
    if (sourceFile === undefined) {
      continue;
    }
    const source = sourceFile.getFullText();
    const edits: Array<{ start: number; end: number; text: string }> = [];
    const sites: AnySite[] = [];
    // A generic signature's `<T>` is injected once per function, keyed by the
    // insertion position (multiple `any` slots in one function share it).
    const injectedTypeParams = new Set<number>();

    const visit = (node: ts.Node): void => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        const owner = ownerOf(node);
        if (owner === undefined) {
          // An `any` inside a type assertion (`1 as any`, `<any>x`) has no
          // declaration owner. When --assertions is on, infer it from the type
          // of the expression being asserted — that is the only real evidence
          // available at this position. `1 as any` becomes `1 as number`, etc.
          const assertion =
            node.parent !== undefined &&
            (ts.isAsExpression(node.parent) || ts.isTypeAssertionExpression(node.parent))
              ? node.parent
              : undefined;
          const assertedType =
            assertion !== undefined && options.includeAssertions
              ? widenedTypeText(ctx.checker, ctx.checker.getTypeAtLocation(assertion.expression), assertion)
              : undefined;
          const usableAssertion =
            assertedType !== undefined && assertedType !== 'any' && assertedType !== 'unknown'
              ? assertedType
              : undefined;
          if (usableAssertion !== undefined) {
            const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
            edits.push({
              start: node.getStart(sourceFile),
              end: node.end,
              text: parenthesizeIfComposite(usableAssertion),
            });
            sites.push({
              file: fileName,
              line,
              start: node.getStart(sourceFile),
              end: node.end,
              original: node.getText(sourceFile),
              inferred: usableAssertion,
            });
          } else if (options.includeAssertions) {
            const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
            sites.push({
              file: fileName,
              line,
              start: node.getStart(sourceFile),
              end: node.end,
              original: node.getText(sourceFile),
              reason: 'assertion or unsupported location',
            });
          }
        } else {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          const original = node.getText(sourceFile);
          // A catch-clause variable may only be annotated `any` or `unknown`
          // (TS1196). Property evidence such as `e.message` would otherwise be
          // written back as an object shape and break strict compilation.
          if (isCatchClauseVariable(owner)) {
            sites.push({
              file: fileName,
              line,
              start: node.getStart(sourceFile),
              end: node.end,
              original,
              reason: 'catch clause variable must stay any or unknown (TS1196)',
            });
            return;
          }
          const wholeType = ownerType(ctx.table, owner);
          // A sibling `.d.ts` declaration is authoritative (S4). When present,
          // its type — including bare `unknown` — is the contract and must not
          // be dropped as "information-free" by mergeMutationEvidence below.
          const dtsSource = ctx.dtsProviders?.get(sourceFile.fileName);
          const hasDtsContract =
            dtsSource !== undefined && declaredTypeOf(owner, dtsSource) !== undefined;
          // The owner's inferred type describes the whole value. Project it
          // onto the position this `any` token actually occupies so nested
          // slots (`any[]`, `Array<any>`, `Map<K, any>`) are not double-wrapped.
          // `Record<K, any>` is special: an object-literal initializer is
          // reported as its whole shape, which cannot be projected through the
          // value-slot path — derive the slot from the literal's values instead.
          const recordSlot = recordValueSlotType(node, owner, ctx);
          // Slots the path model cannot express (generic defaults/constraints,
          // tuple elements, function-type returns) must be projected explicitly
          // or the whole owner type gets substituted into the any position and
          // yields non-compiling code. Check this before the generic path.
          const special = specialSlotType(node, owner, ctx);
          // Prefer the checker's structured initializer type for projection:
          // unlike parsing a printed type string it is immune to commas inside
          // type arguments (function types, multi-arg generics). Fall back to
          // the string projection when no structured type is available.
          const structured = structuredSlotType(node, owner, ctx);
          const projected =
            special ??
            recordSlot ??
            structured ??
            (wholeType === undefined ? undefined : projectSlotType(wholeType, slotPathOf(node)));
          const usableProjected = projected !== 'never' ? projected : undefined;
          // For a mutable container slot, method calls that write into it
          // (`push`, `set`, `add`, index assignment) are covariant sources for
          // the slot type and must be unioned with the projected whole value.
          // Read-only accesses stay out as noise.
          const mutationKind = mutationKindOf(node);
          const mutationTypes =
            mutationKind === undefined ? [] : collectMutationEvidence(owner, mutationKind, ctx);
          let usable = mergeMutationEvidence(usableProjected, mutationTypes);
          // `mergeMutationEvidence` drops bare `unknown` as information-free,
          // but for an explicitly handled special slot (generic default/
          // constraint, or a tuple/function slot with no concrete projection)
          // `unknown` IS the intended safe replacement — keeping `any` there
          // would leave the slot untyped, and the generic whole-type fallback
          // would be structurally illegal. Let it through when nothing better
          // was found via mutations.
          if (
            usable === undefined &&
            usableProjected === 'unknown' &&
            (special !== undefined || hasDtsContract)
          ) {
            usable = 'unknown';
          }
          if (usable !== undefined && isReturnTypeAnnotationOf(node, owner)) {
            usable = wrapAsyncReturnForInfer(usable, owner);
          }
          if (usable !== undefined) {
            edits.push({
              start: node.getStart(sourceFile),
              end: node.end,
              text: parenthesizeIfComposite(usable),
            });
            // A sibling `.d.ts` generic contract (`id<T>(x: T): T`) fills the
            // implementation's `any` slots with `T`. The source function has no
            // `<T>` of its own, so declare it on the signature or the result is
            // an undeclared type name (TS2304). Inject once per function.
            // (Line-by-line/泛型探索 bug G2.)
            if (sourceFile !== undefined) {
              const provider = ctx.dtsProviders?.get(sourceFile.fileName);
              const generic = dtsGenericParamInsertionFor(owner, provider, ctx.checker);
              if (generic !== undefined && !injectedTypeParams.has(generic.insertPos)) {
                injectedTypeParams.add(generic.insertPos);
                edits.push({
                  start: generic.insertPos,
                  end: generic.insertPos,
                  text: generic.typeParams,
                });
              }
            }
            // `let v: any;` that is never initialized/assigned: narrowing to a
            // concrete type would make TS start definite-assignment analysis
            // and emit TS2454 at every read (the original `any` never did).
            // A definite-assignment assertion (`let v!: T`) keeps the inferred
            // type while telling TS the binding is intentionally assigned
            // elsewhere — the only way to keep both precision and strict-
            // legality without injecting a fake `undefined` into the type.
            if (isUnassignedLetWithoutInit(owner, ctx) && ts.isVariableDeclaration(owner)) {
              const nameEnd = owner.name.end;
              const afterName = source.slice(nameEnd, nameEnd + 1);
              // Only when the type annotation directly follows the name (i.e.
              // `let v: any`), not a binding pattern or an existing `v!`.
              if (afterName === ':') {
                edits.push({ start: nameEnd, end: nameEnd, text: '!' });
              }
            }
            sites.push({ file: fileName, line, start: node.getStart(sourceFile), end: node.end, original, inferred: usable });
          } else if (options.reportAmbiguous) {
            const merged = mergeEvidence(collectEvidence(owner, ctx));
            sites.push({ file: fileName, line, start: node.getStart(sourceFile), end: node.end, original, reason: merged.reason });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    let output = source;
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
    }
    results.push({ fileName, output, sites, diagnostics: ctx.table.diagnostics });
  }

  return results;
}

/** Convenience helper: read a tsconfig.json into compiler options. */
export function readCompilerOptions(configPath: string): ts.CompilerOptions {
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
  }
  const configDir = path.dirname(configPath);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, configDir);
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  }
  return parsed.options;
}
