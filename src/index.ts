export { convertSource } from './convert.js';
export { findSiblingDts, loadDeclarations } from './dts.js';
export type {
  DeclarationProvider,
  DtsSignature,
  DtsParameter,
  DtsTypeDeclaration,
} from './dts.js';
export { checkStrict } from './check.js';
export { strictTsConfig } from './config.js';
export { collectJsFiles, collectTsFiles, convertPath, defaultOutputPath } from './fs.js';
export { normalizeJsDocType, normalizeRestType, objectTypeFromProperties } from './normalize.js';
export { parseJsDocBlocks } from './jsdoc.js';
export {
  inferAnyInProject,
  createUsageResolver,
  readCompilerOptions,
  DEFAULT_INFER_OPTIONS,
} from './inferAny.js';
export type { InferAnyOptions, AnySite, InferFileResult, UsageResolver } from './inferAny.js';
export { DEFAULT_OPTIONS, DEFAULT_TSCONFIG_OPTIONS } from './types.js';
export type {
  ConvertOptions,
  ConvertResult,
  Diagnostic,
  JsDocBlock,
  JsDocTag,
  TsConfigOptions,
} from './types.js';
export type { CheckResult } from './check.js';
export type { BatchResult } from './fs.js';
