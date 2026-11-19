import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

/** One parameter from a d.ts signature, in source order. */
export interface DtsParameter {
  /** The declared type text (e.g. `Options`, `T[]`, `(x: number) => void`). */
  readonly type: string;
  readonly optional: boolean;
  readonly rest: boolean;
}

/** The signature of a function/method as written in a d.ts declaration. */
export interface DtsSignature {
  /** Type parameters including brackets, e.g. `<T extends Foo>`. */
  readonly typeParams?: string;
  /** Parameter types in source order (matched to JS parameters by position). */
  readonly params: readonly DtsParameter[];
  /** Return type text, e.g. `Result` or `Promise<void>`. */
  readonly returnType?: string;
}

/** A type-level declaration (interface / type alias / enum) emitted verbatim. */
export interface DtsTypeDeclaration {
  readonly name: string;
  /** Full declaration text as written in the d.ts. */
  readonly text: string;
}

/**
 * Declarations extracted from a sibling `.d.ts`, keyed by symbol name.
 * Functions use their name; class methods/properties use `Class.member`.
 */
export interface DeclarationProvider {
  /** Absolute path of the d.ts this provider was built from. */
  readonly dtsPath: string;
  readonly functions: ReadonlyMap<string, DtsSignature>;
  readonly variables: ReadonlyMap<string, string>;
  readonly members: ReadonlyMap<string, string | DtsSignature>;
  readonly typeDeclarations: readonly DtsTypeDeclaration[];
}

/** Find a declaration file paired with a source path.
 *  `lib.js` -> `lib.d.ts`; `api.ts` -> `api.d.ts` (the infer-any case).
 *  A path that already ends in `.d.ts` returns itself. */
export function findSiblingDts(jsPath: string): string | undefined {
  const absolute = path.resolve(jsPath);
  if (/\.d\.ts$/i.test(absolute)) {
    return fs.existsSync(absolute) ? absolute : undefined;
  }
  const candidate = /\.ts$/i.test(absolute)
    ? absolute.replace(/\.ts$/i, '.d.ts')
    : /\.js$/i.test(absolute)
      ? absolute.replace(/\.js$/i, '.d.ts')
      : undefined;
  if (candidate === undefined) {
    return undefined;
  }
  return fs.existsSync(candidate) ? candidate : undefined;
}

function signatureOf(
  node: ts.SignatureDeclaration,
  sourceFile: ts.SourceFile,
): DtsSignature {
  const typeParams =
    node.typeParameters !== undefined && node.typeParameters.length > 0
      ? `<${node.typeParameters.map((param) => param.getText(sourceFile)).join(', ')}>`
      : undefined;
  const params: DtsParameter[] = node.parameters.map((param) => ({
    type: param.type?.getText(sourceFile) ?? 'unknown',
    optional: param.questionToken !== undefined,
    rest: param.dotDotDotToken !== undefined,
  }));
  return { typeParams, params, returnType: node.type?.getText(sourceFile) };
}

/**
 * Parse the sibling d.ts and collect its declarations. Uses the d.ts AST
 * directly (not the checker) so generic parameters, overload signatures and
 * referenced type names are preserved exactly as authored.
 */
export function loadDeclarations(jsPath: string): DeclarationProvider | undefined {
  const dtsPath = findSiblingDts(jsPath);
  if (dtsPath === undefined) {
    return undefined;
  }
  return parseDeclarationFile(dtsPath);
}

/** Parse an explicit `.d.ts` path into a provider (shared by JS and TS paths). */
export function parseDeclarationFile(dtsPath: string): DeclarationProvider {
  const text = fs.readFileSync(dtsPath, 'utf8');
  const sourceFile = ts.createSourceFile(
    dtsPath,
    text,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );

  const functions = new Map<string, DtsSignature>();
  const variables = new Map<string, string>();
  const members = new Map<string, string | DtsSignature>();
  const typeDeclarations: DtsTypeDeclaration[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      // Overloads: keep the last (usually the broadest / implementation-like)
      // signature so calls through the JS function stay assignable.
      functions.set(statement.name.text, signatureOf(statement, sourceFile));
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.type !== undefined
        ) {
          variables.set(declaration.name.text, declaration.type.getText(sourceFile));
        }
      }
    } else if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      typeDeclarations.push({
        name: statement.name.text,
        text: statement.getText(sourceFile),
      });
    } else if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
      const className = statement.name.text;
      for (const member of statement.members) {
        if (
          (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) &&
          member.name !== undefined &&
          ts.isIdentifier(member.name)
        ) {
          members.set(`${className}.${member.name.text}`, signatureOf(member, sourceFile));
        } else if (
          (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) &&
          member.name !== undefined &&
          ts.isIdentifier(member.name) &&
          member.type !== undefined
        ) {
          members.set(`${className}.${member.name.text}`, member.type.getText(sourceFile));
        }
      }
    }
  }

  return { dtsPath, functions, variables, members, typeDeclarations };
}

/** Qualified key for a class member declaration (`Class.member`). */
export function memberKey(node: ts.Node): string | undefined {
  if (
    (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) &&
    node.name !== undefined &&
    ts.isIdentifier(node.name)
  ) {
    const parent = node.parent;
    if (ts.isClassDeclaration(parent) && parent.name !== undefined) {
      return `${parent.name.text}.${node.name.text}`;
    }
  }
  return undefined;
}
