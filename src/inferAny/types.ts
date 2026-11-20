import * as ts from 'typescript';

import type { DeclarationProvider } from '../dts.js';
import type { ProgramScan } from './scan.js';

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

/**
 * Project-level fixed-point convergence status. Shared by every file result of
 * one `inferAnyInProject` call, because the fixed point is computed once over
 * the whole `ts.Program`, not per file. Exposed so CLI/API callers can detect a
 * long dependency chain that hit the round cap and produced a partial table.
 */
export interface FixedPointDiagnostics {
  readonly rounds: number;
  readonly converged: boolean;
  readonly maxRounds: number;
}

export interface InferFileResult {
  readonly fileName: string;
  readonly output: string;
  readonly sites: readonly AnySite[];
  /** Project-level convergence status (identical reference across all files). */
  readonly diagnostics: FixedPointDiagnostics;
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
  /**
   * Number of fixed-point rounds actually executed, and whether convergence
   * was reached before the cap. Exposed so callers can detect a non-converged
   * long dependency chain instead of silently returning a partial table.
   */
  readonly diagnostics: {
    rounds: number;
    converged: boolean;
    maxRounds: number;
  };
}

export interface InferenceContext {
  readonly checker: ts.TypeChecker;
  readonly program: ts.Program;
  readonly table: InferenceTable;
  /** Lazily-built whole-program reference/call index, shared by all owners. */
  scan?: ProgramScan;
  /**
   * Per-round memo for recursively collected node types. Values are tagged
   * with the fixed-point round that produced them and are ignored in later
   * rounds, because `collectEvidence` reads the evolving inference table.
   */
  readonly evidenceMemo: Map<ts.Node, { round: number; type?: string }>;
  /** Current fixed-point round, used to invalidate the per-round memo. */
  round: number;
  /**
   * Authoritative sibling `.d.ts` contracts, keyed by the source file path.
   * When a declaration has an entry here, its type outranks all usage
   * evidence. Optional so the pure in-memory resolver path stays unchanged.
   */
  readonly dtsProviders?: ReadonlyMap<string, DeclarationProvider>;
  /**
   * When true, exported (public-API) parameters are not narrowed from internal
   * call-site arguments (S4). Enabled only by the infer-any flow; the convert
   * flow's usage resolver keeps its historic behaviour.
   */
  readonly narrowExportedParams?: boolean;
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
  /**
   * True when this node was observed being *called* (e.g. `x.foo()` or a
   * for-of element's `x.toUpperCase()`). Rendered as a callable signature so
   * strict mode accepts the call instead of TS18046 ("not callable"). A
   * callable node can still have children, representing the shape of the
   * value returned by the call (e.g. `v.foo().bar()` -> foo returns an object
   * with a callable `bar`). (Review round 17.)
   */
  callable?: boolean;
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
  /**
   * Low-confidence covariant sources. These come from call-site arguments of
   * exported (public-API) parameters: internal usage is not a reliable contract
   * for a value outside callers can supply. They never outrank `sources`, and
   * when they are the only evidence the owner stays un-narrowed (`any`).
   */
  readonly weakSources: string[];
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
  /**
   * Observed argument types at call sites of methods (first argument text).
   * Used to reject a builtin-family narrowing when an argument contradicts
   * the family's signature — e.g. `v.includes(3)` proves v is not a string
   * (string.includes takes a string; arrays also have includes). (Review r17.)
   */
  readonly methodArgumentTypes: Map<string, string[]>;
  /**
   * Widened types of literal operands compared with `===` / `!==` against a
   * reference to this binding (`x === true`, `x === 'a'`, `x === 5`). Strict
   * TypeScript rejects a comparison whose two sides have no overlap (TS2367),
   * so once a real covariant source fixes the binding to e.g. `string`, an
   * observed `x === true` must widen it to `string | boolean` to keep the
   * emitted code compiling. Recorded as compatibility hints and merged ONLY
   * when a real source exists — a bare `x === 'a'` with no other evidence must
   * stay `any` (P0-2 public-API guard). (TS strict-regression fix.)
   */
  readonly equalityOperandTypes: string[];
  objectLiteralInit: boolean;
  /** True when the binding was seen only in string-like contexts. Weak hint. */
  stringContext: boolean;
  /**
   * True when the binding was used as an operand of a `+` whose other side had
   * no concrete type either. JS `+` may be numeric addition or string concat,
   * so no numeric type is justified; with no other evidence the binding falls
   * back to `any` (faithful to the untyped JS semantics) rather than `unknown`,
   * which would make the expression itself a TS18046. (Review round 12 / idea 3.)
   */
  ambiguousAdd: boolean;
  /**
   * Weak naming hint that the binding is numeric (function/variable name like
   * `add`/`sum`/`count`). Never outranks real evidence; only consulted when no
   * source, constraint or property exists. (Review round 12 / idea 3.)
   */
  nameHintNumber: boolean;
  /**
   * Weak return-type hint derived from a FUNCTION name (`isReady` -> boolean,
   * `getItems` -> unknown[], `getName` -> string). Lowest confidence: consulted
   * only when the function has no concrete return evidence. When it replaces an
   * opaque `unknown` return, the converter inserts an `as` assertion on those
   * returns so the annotated concrete return stays strict-legal. (Round 15.)
   */
  nameHintReturnType: string | undefined;
  /**
   * True when a function body's returned expression is a `+` operation. JS
   * `+` yields either a number (numeric addition) or a string (concatenation),
   * so when no real return evidence exists the return falls back to
   * `string | number` rather than `unknown` — a strictly more informative and
   * still safe type. Only consumed in the bare-`unknown` fallback branch, so
   * any real return evidence (JSDoc, call sites, anchors) always wins.
   * (Review round 13.)
   */
  returnsAddExpression: boolean;
  /**
   * Weak type hint derived from a VARIABLE name with no initializer (e.g.
   * `let names;` -> `unknown[]`, `let isReady;` -> `boolean`). Lowest
   * confidence: only consulted when no real evidence exists. Distinct from
   * `nameHintNumber` which is a FUNCTION-name -> parameter hint. (Round 14.)
   */
  nameHintType: string | undefined;
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
   * Resolve the symbol an identifier refers to, following import aliases.
   * Used by the converter to compare declarations by symbol identity rather
   * than by spelling (so same-named locals in other scopes cannot be confused).
   * Returns undefined when the checker cannot bind the node.
   */
  readonly symbolOf: (node: ts.Node) => ts.Symbol | undefined;
  /**
   * Best-effort type text for an arbitrary expression, using the same checker
   * and inference table as `infer`. Used where the converter needs the type of
   * an initializer/assignment value (e.g. `this.field = <expr>`) that is not
   * itself a declaration owner. Returns undefined when no concrete type can be
   * named, so callers can keep the binding un-annotated rather than guess.
   */
  readonly typeOf: (node: ts.Node) => string | undefined;
  /**
   * The weak return-type hint derived purely from a function's NAME (boolean /
   * array / string), independent of real evidence. The converter compares this
   * with the inferred return: when they match, the concrete return came from
   * the name hint and opaque `return` expressions need an `as` assertion to
   * stay strict-legal. (Review round 15.)
   */
  readonly functionNameReturnHint: (owner: ts.Node) => string | undefined;
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
