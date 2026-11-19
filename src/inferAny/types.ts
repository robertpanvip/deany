import * as ts from 'typescript';

export interface InferAnyOptions {
  /** Report ambiguous sites instead of silently leaving them untouched. */
  readonly reportAmbiguous: boolean;
  /** Also consider `as any` / `<any>x` assertions. */
  readonly includeAssertions: boolean;
}

export interface AnySite {
  readonly file: string;
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly original: string;
  readonly inferred?: string;
  readonly reason?: string;
}

export interface InferFileResult {
  readonly fileName: string;
  readonly output: string;
  readonly sites: readonly AnySite[];
}

export type FunctionLikeWithBody =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

/**
 * The fixed-point inference table. `declarations` holds the inferred type of a
 * value binding (variable / parameter / property); `returns` holds the inferred
 * return type of a function-like declaration. Nodes are used directly as keys
 * because they are identity-stable within a single `ts.Program`.
 */
export interface InferenceTable {
  readonly declarations: Map<ts.Node, string>;
  readonly returns: Map<ts.Node, string>;
  /** Owners inferred only from weak (property-shape) evidence; re-evaluated. */
  readonly weakOwners: Set<ts.Node>;
}

export interface InferenceContext {
  readonly checker: ts.TypeChecker;
  readonly program: ts.Program;
  readonly table: InferenceTable;
  readonly referenceCache: Map<ts.Symbol, ts.Identifier[]>;
  readonly callCache: Map<ts.SignatureDeclaration, CallSite[]>;
}

/**
 * A call to a function/method (`f(x)`) or a constructor invocation
 * (`new C(x)`). Both carry positional `arguments` whose resolved signature
 * declaration is the target function/constructor, so both are valid call-site
 * evidence for parameter inference. Constructors are included so `new C(1)`
 * can refine C's constructor parameters just like `c.m(1)` refines a method.
 */
export type CallSite = ts.CallExpression | ts.NewExpression;

/**
 * A node in a recursively collected property-shape tree. Used to describe the
 * element type of an array from the property chains accessed on an iteration
 * callback's element parameter (e.g. `xs.map(it => it.a.b)` -> { a: { b: unknown } }).
 */
export interface ShapeNode {
  readonly children: Map<string, ShapeNode>;
}

/**
 * Usage evidence is split by variance:
 * - `sources` are covariant (values the binding receives: initializers,
 *   assignments, returns, arithmetic). Multiple sources form a union.
 * - `constraints` are contravariant (types the binding must be assignable to,
 *   e.g. when passed as a call argument). Multiple constraints are intersected.
 * - `properties` describe an object's shape, used only as a last-resort source.
 * - `elementShape` describes an array element type inferred from iteration
 *   callback property chains; it refines an otherwise-unknown `unknown[]`.
 * - `arrayOwnMethods` are custom methods called on an array binding (detected
 *   via `Array.isArray` context); intersected into the array type so the calls
 *   type-check without inventing an element shape for unknown methods.
 * - `objectLiteralInit` marks an object-literal initializer, whose shape source
 *   may absorb properties written onto the binding after construction.
 */
export interface Evidence {
  readonly sources: string[];
  readonly constraints: string[];
  readonly properties: Map<string, string>;
  readonly elementShape: ShapeNode;
  /** Nested property chains accessed on the binding (`o.a.b` -> a -> b). */
  readonly shapeChain: ShapeNode;
  readonly arrayOwnMethods: Map<string, string>;
  /**
   * Contextual return types observed at call sites of lib-unique methods
   * (e.g. `s.toUpperCase()` used where `number` is expected). Used to reject
   * the weak builtin narrowing when the observed return context contradicts
   * the method's real lib return type — a coincidental same-named method is
   * not the builtin one.
   */
  readonly methodReturnTypes: Map<string, string[]>;
  objectLiteralInit: boolean;
  /** True when the binding was seen only in string-like contexts. Weak hint. */
  stringContext: boolean;
}

export type MutationKind = 'collection' | 'map' | 'set';

/**
 * A reusable type checker bound to a program. `infer` accepts a declaration node
 * from that program and returns a concrete type when usage evidence is conclusive.
 */
export interface UsageResolver {
  readonly getSourceFile: (fileName: string) => ts.SourceFile | undefined;
  readonly infer: (owner: ts.Node) => string | undefined;
  /**
   * Best-effort type text for an arbitrary expression, using the same checker
   * and inference table as `infer`. Used where the converter needs the type of
   * an initializer/assignment value (e.g. `this.field = <expr>`) that is not
   * itself a declaration owner. Returns undefined when no concrete type can be
   * named, so callers can keep the binding un-annotated rather than guess.
   */
  readonly typeOf: (node: ts.Node) => string | undefined;
  /**
   * True if `param` has no contextual type and resolves to `any`, i.e. the
   * parameter would trigger `noImplicitAny` (TS7006). Used to annotate only
   * callbacks that genuinely lack contextual typing, without breaking
   * `map`/`filter`-style callbacks whose types are inferred from the callee.
   */
  readonly isImplicitAnyParameter: (param: ts.ParameterDeclaration) => boolean;
  /**
   * True when `member` is a class member that genuinely overrides a member of
   * the same name on the class's base type chain. Used to emit the `override`
   * modifier required by `noImplicitOverride`, based on real checker evidence
   * rather than a name guess.
   */
  readonly overridesBase: (member: ts.ClassElement) => boolean;
}
