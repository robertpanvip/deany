/** Public option surface of the converter. */
export interface ConvertOptions {
  /** Map loose JSDoc types (`*`, `?`, `any`) to `unknown`. Default: true. */
  readonly unknownForLoose: boolean;
  /** Annotate parameters and return values that have no JSDoc type. Default: true. */
  readonly annotateUntyped: boolean;
  /** Type used when a declaration has no JSDoc type and `annotateUntyped` is on. */
  readonly defaultType: string;
  /** Emit `T[]` instead of `Array<T>` when the element type is simple. Default: false. */
  readonly arrayShorthand: boolean;
  /** Annotate parameters of callbacks that lack contextual typing (would be TS7006). Default: true. */
  readonly annotateUntypedCallbacks: boolean;
  /** Emit `type` aliases for standalone `@typedef` / `@callback` blocks. Default: true. */
  readonly emitTypedefs: boolean;
  /** Prepend a generated-file banner. Default: true. */
  readonly banner: boolean;
  /** Wrap annotated `@returns` types of async functions in `Promise<...>`. Default: true. */
  readonly asyncPromiseReturn: boolean;
}

export const DEFAULT_OPTIONS: ConvertOptions = {
  unknownForLoose: true,
  annotateUntyped: true,
  defaultType: 'unknown',
  arrayShorthand: false,
  annotateUntypedCallbacks: true,
  emitTypedefs: true,
  banner: true,
  asyncPromiseReturn: true,
};

export interface Diagnostic {
  readonly severity: 'info' | 'warn' | 'error';
  readonly message: string;
  readonly file?: string;
  readonly offset?: number;
}

export interface ConvertResult {
  readonly fileName: string;
  readonly output: string;
  readonly diagnostics: readonly Diagnostic[];
}

/** A single parsed JSDoc tag such as `@param {string} [name] - description`. */
export interface JsDocTag {
  readonly tag: string;
  readonly typeText?: string;
  readonly name?: string;
  readonly optional: boolean;
  readonly variadic: boolean;
  readonly defaultValue?: string;
  readonly description: string;
  readonly raw: string;
}

/** One `/** ... *\/` block with its source offsets. */
export interface JsDocBlock {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly description: string;
  readonly tags: readonly JsDocTag[];
}

/** Options that affect the generated strict `tsconfig.json`. */
export interface TsConfigOptions {
  readonly target: string;
  readonly module: string;
  readonly outDir: string;
  readonly include: readonly string[];
}

export const DEFAULT_TSCONFIG_OPTIONS: TsConfigOptions = {
  target: 'ES2022',
  module: 'ESNext',
  outDir: 'dist',
  include: ['**/*.ts'],
};
