import type { TsConfigOptions } from './types.js';
import { DEFAULT_TSCONFIG_OPTIONS } from './types.js';

/** Produce a strict tsconfig that scriptc can consume without surprises. */
export function strictTsConfig(input: Partial<TsConfigOptions> = {}): string {
  const options: TsConfigOptions = { ...DEFAULT_TSCONFIG_OPTIONS, ...input };
  const config = {
    compilerOptions: {
      target: options.target,
      lib: [options.target.toLowerCase()],
      module: options.module,
      moduleResolution: 'Bundler',
      verbatimModuleSyntax: true,
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
