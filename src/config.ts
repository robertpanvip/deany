import type { TsConfigOptions } from './types.js';
import { DEFAULT_TSCONFIG_OPTIONS } from './types.js';

/**
 * `verbatimModuleSyntax` keeps ES module syntax intact for scriptc/TS ESM,
 * but it is fundamentally incompatible with a CommonJS emit: TS6 rejects any
 * top-level `export` with TS1287 once `module` is a CJS target (deany emits
 * `export` for converted modules, so such a config could never compile).
 * Detect CommonJS-family module targets case-insensitively and drop the flag
 * for them; ESM targets keep the strict verbatim behavior (review P1-21).
 */
function moduleEmitsCommonJs(moduleTarget: string): boolean {
  const normalized = moduleTarget.trim().toLowerCase();
  return (
    normalized === 'commonjs' ||
    normalized === 'node16' ||
    normalized === 'nodenext'
  );
}

/** Produce a strict tsconfig that scriptc can consume without surprises. */
export function strictTsConfig(input: Partial<TsConfigOptions> = {}): string {
  const options: TsConfigOptions = { ...DEFAULT_TSCONFIG_OPTIONS, ...input };
  const config = {
    compilerOptions: {
      target: options.target,
      lib: [options.target.toLowerCase()],
      module: options.module,
      moduleResolution: 'Bundler',
      verbatimModuleSyntax: !moduleEmitsCommonJs(options.module),
      strict: true,
      noImplicitAny: true,
      strictNullChecks: true,
      strictFunctionTypes: true,
      strictBindCallApply: true,
      strictPropertyInitialization: true,
      noImplicitThis: true,
      useUnknownInCatchVariables: true,
      alwaysStrict: true,
      noUncheckedIndexedAccess: true,
      noImplicitOverride: true,
      noFallthroughCasesInSwitch: true,
      skipLibCheck: true,
      declaration: true,
      outDir: options.outDir,
    },
    include: [...options.include],
    exclude: [options.outDir, 'node_modules'],
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}
