// 公共 API 门面：实现已拆分到 ./inferAny/ 目录，此文件保持对外导出路径不变。
export { inferAnyInProject, readCompilerOptions } from './inferAny/infer.js';
export { createUsageResolver } from './inferAny/usageResolver.js';
export { DEFAULT_INFER_OPTIONS } from './inferAny/state.js';
export type { InferAnyOptions, AnySite, InferFileResult, FixedPointDiagnostics, UsageResolver } from './inferAny/types.js';
