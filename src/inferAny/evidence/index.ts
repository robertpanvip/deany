// Evidence collection facade. Re-exports the public surface that callers
// (table, infer, tests) import from `./evidence/index.js`.
export { collectEvidence } from './collect.js';
export { constraintsFromReference } from './reference.js';
export { opaqueCallbackSignature } from './collect.js';
