// 公共 API 门面：实现已拆分到 ./normalize/ 目录，对外导出路径保持不变。
export { hasTopLevelArrow, normalizeJsDocType, splitTopLevel } from './normalize/core.js';
export { extractCustomTypeNames, normalizeRestType, objectTypeFromDottedParams, objectTypeFromProperties, wrapAsyncReturn } from './normalize/shapes.js';
